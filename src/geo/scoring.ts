import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { PROXIMITY_FLAG_MI, RISK_RED_AT, RISK_YELLOW_AT } from '../config/constants';
import type { Candidate, LayerResult, Workplace } from '../types';
import { authoritativePointQuery, stateFrom } from './hitTest';
import { getIndex, type LayerDef } from '../map/layerRegistry';

const FLOOD_CLASSES: Record<string, string> = {
  A: 'SFHA',
  AE: 'SFHA',
  AH: 'SFHA',
  AO: 'SFHA',
  AR: 'SFHA',
  A99: 'SFHA',
  V: 'Coastal high hazard',
  VE: 'Coastal high hazard',
};

function interpretAuthoritative(layerId: string, rows: Record<string, unknown>[]): string | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  switch (layerId) {
    case 'flood': {
      const zone = String(first.FLD_ZONE ?? '').toUpperCase();
      const subtype = String(first.ZONE_SUBTY ?? '').toUpperCase();
      if (subtype.includes('FLOODWAY')) return 'Floodway';
      return FLOOD_CLASSES[zone] ? `${FLOOD_CLASSES[zone]} (${zone})` : null;
    }
    case 'fire': {
      const description = String(first.FHSZ_Description ?? '');
      return description || null;
    }
    case 'tsunami': {
      const evacuate = String(first.Evacuate ?? '').toLowerCase();
      return evacuate.startsWith('no') ? null : 'Tsunami hazard area';
    }
    // CGS zone layers carry no severity grading -- being inside the zone is
    // the whole finding -- but the quadrangle name is worth surfacing, since
    // it is what you quote when ordering the official report.
    case 'liquefaction':
      return `Liquefaction zone${first.QUAD_NAME ? ` (${first.QUAD_NAME} quad)` : ''}`;
    case 'landslide':
      return `Landslide zone${first.QUAD_NAME ? ` (${first.QUAD_NAME} quad)` : ''}`;
    case 'fault':
      return `Fault rupture zone${first.QUAD_NAME ? ` (${first.QUAD_NAME} quad)` : ''}`;
    default:
      return 'In mapped zone';
  }
}

/**
 * Pessimistic drive-time estimate.
 *
 * Routing every candidate against every workplace would mean dozens of calls to
 * a shared community routing server for a table that gets rebuilt on every
 * edit. Instead the zone membership comes from the real isochrone (one call per
 * workplace) and the per-row minutes are estimated from distance.
 *
 * Straight-line distance is inflated by a detour factor, then divided by an
 * average speed that rises with trip length -- short trips are all surface
 * streets, long ones pick up freeway. Both ends are set low on purpose: this
 * should read worse than reality, not better.
 */
export function estimateDriveMinutes(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const R = 3958.8;
  const dLat = ((toLat - fromLat) * Math.PI) / 180;
  const dLon = ((toLon - fromLon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((fromLat * Math.PI) / 180) * Math.cos((toLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const straightMi = 2 * R * Math.asin(Math.sqrt(a));

  const roadMi = straightMi * 1.25;
  const avgMph = 22 + 18 * Math.min(1, straightMi / 25);
  return (roadMi / avgMph) * 60;
}

export function inAnyZone(
  lat: number,
  lon: number,
  zone: Feature<Polygon | MultiPolygon> | null,
): boolean | null {
  if (!zone) return null;
  return booleanPointInPolygon(point([lon, lat]), zone as Feature<never>);
}

export async function scoreCandidate(
  candidate: Candidate,
  layers: LayerDef[],
  baseUrl: string,
  workplaces: Workplace[],
  zone: Feature<Polygon | MultiPolygon> | null,
): Promise<void> {
  const results: Record<string, LayerResult> = {};

  await Promise.all(
    layers.map(async (def) => {
      try {
        if (def.mode === 'zone') {
          results[def.id] = await scoreZone(def, candidate, baseUrl);
        } else {
          results[def.id] = await scoreProximity(def, candidate, baseUrl);
        }
      } catch (error) {
        console.warn(`Scoring ${def.id} failed for ${candidate.address}:`, error);
        results[def.id] = { state: 'unknown' };
      }
    }),
  );

  candidate.results = results;
  candidate.scored = true;
  candidate.driveTimes = {};
  for (const workplace of workplaces) {
    candidate.driveTimes[workplace.id] = estimateDriveMinutes(
      candidate.lat,
      candidate.lon,
      workplace.lat,
      workplace.lon,
    );
  }
  candidate.inZone = inAnyZone(candidate.lat, candidate.lon, zone);
}

async function scoreZone(def: LayerDef, candidate: Candidate, baseUrl: string): Promise<LayerResult> {
  // Prefer the authoritative service: the local copy is simplified for drawing
  // and can be tens of metres off at a parcel boundary.
  if (def.pointQueryUrl && def.pointQueryFields) {
    const rows = await authoritativePointQuery(
      def.pointQueryUrl,
      candidate.lon,
      candidate.lat,
      def.pointQueryFields,
    );
    if (rows !== null) {
      const value = interpretAuthoritative(def.id, rows);
      if (value) return { state: 'hit', value, authoritative: true };
      const index = await getIndex(def, baseUrl);
      return {
        state: stateFrom(false, index.hasCoverageAt(candidate.lon, candidate.lat)),
        authoritative: true,
      };
    }
  }

  const index = await getIndex(def, baseUrl);
  const feature = index.containing(candidate.lon, candidate.lat);
  if (feature) {
    return { state: 'hit', value: String(feature.properties?.c ?? 'zone'), authoritative: false };
  }
  return {
    state: stateFrom(false, index.hasCoverageAt(candidate.lon, candidate.lat)),
    authoritative: false,
  };
}

async function scoreProximity(def: LayerDef, candidate: Candidate, baseUrl: string): Promise<LayerResult> {
  const index = await getIndex(def, baseUrl);
  const nearest = index.nearest(candidate.lon, candidate.lat);
  if (!nearest) return { state: 'clear' };

  const threshold = PROXIMITY_FLAG_MI[def.id] ?? 0.25;
  return {
    state: nearest.distanceMi <= threshold ? 'hit' : 'clear',
    distanceMi: nearest.distanceMi,
    value: String(nearest.feature.properties?.c ?? ''),
  };
}

export interface RiskSummary {
  flags: number;
  unknowns: number;
  band: 'green' | 'yellow' | 'red' | 'none';
}

/**
 * Row banding. Only enabled layers count, so switching a filter off genuinely
 * removes it from the assessment rather than hiding it while it still colours
 * the row.
 */
export function summarizeRisk(candidate: Candidate, enabledLayerIds: string[]): RiskSummary {
  if (!candidate.scored) return { flags: 0, unknowns: 0, band: 'none' };

  let flags = 0;
  let unknowns = 0;
  for (const id of enabledLayerIds) {
    const result = candidate.results[id];
    if (!result) continue;
    if (result.state === 'hit') flags += 1;
    else if (result.state === 'unknown') unknowns += 1;
  }

  let band: RiskSummary['band'];
  if (flags >= RISK_RED_AT) band = 'red';
  else if (flags >= RISK_YELLOW_AT) band = 'yellow';
  else band = 'green';

  return { flags, unknowns, band };
}
