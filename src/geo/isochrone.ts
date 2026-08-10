import intersect from '@turf/intersect';
import { featureCollection, polygon } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import {
  ISOCHRONE_MAX_MINUTES,
  ISOCHRONE_MIN_INTERVAL_MS,
  VALHALLA_ENDPOINT,
} from '../config/constants';

export interface IsochroneResult {
  polygon: Feature<Polygon | MultiPolygon>;
  /** True when routing was unavailable and this is a plain radius fallback. */
  estimated: boolean;
}

export function isochroneKey(lat: number, lon: number, minutes: number, factor: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)},${minutes},${factor.toFixed(2)}`;
}

const memory = new Map<string, IsochroneResult>();
let lastRequest = 0;

function loadPersisted(key: string): IsochroneResult | null {
  try {
    const raw = localStorage.getItem(`iso:${key}`);
    return raw ? (JSON.parse(raw) as IsochroneResult) : null;
  } catch {
    return null;
  }
}

function persist(key: string, value: IsochroneResult): void {
  try {
    localStorage.setItem(`iso:${key}`, JSON.stringify(value));
  } catch {
    // Quota exceeded; the in-memory cache still covers this session.
  }
}

async function throttle(): Promise<void> {
  const wait = lastRequest + ISOCHRONE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
}

/**
 * A circle sized by an assumed average speed. Used only when the routing
 * service is unreachable -- it ignores roads, water and terrain entirely, so
 * callers must label it as an estimate rather than passing it off as a
 * drive-time zone.
 */
function radiusFallback(lat: number, lon: number, minutes: number): Feature<Polygon> {
  const assumedMph = 28;
  const radiusMi = (assumedMph * minutes) / 60;
  const latDeg = radiusMi / 69;
  const lonDeg = radiusMi / (69 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= 64; i += 1) {
    const angle = (i / 64) * Math.PI * 2;
    ring.push([lon + lonDeg * Math.cos(angle), lat + latDeg * Math.sin(angle)]);
  }
  return polygon([ring]) as Feature<Polygon>;
}

export async function fetchIsochrone(
  lat: number,
  lon: number,
  minutes: number,
  trafficFactor: number,
): Promise<IsochroneResult> {
  const key = isochroneKey(lat, lon, minutes, trafficFactor);
  const cached = memory.get(key) ?? loadPersisted(key);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }

  // Ask for less free-flow driving time than the user requested, so the zone
  // reflects a pessimistic commute rather than an empty-road one.
  const requested = Math.min(ISOCHRONE_MAX_MINUTES, Math.max(1, minutes / trafficFactor));

  const query = {
    locations: [{ lat, lon }],
    costing: 'auto',
    contours: [{ time: Number(requested.toFixed(2)) }],
    polygons: true,
    denoise: 0.4,
    generalize: 60,
  };

  try {
    await throttle();
    const response = await fetch(`${VALHALLA_ENDPOINT}?json=${encodeURIComponent(JSON.stringify(query))}`);
    if (!response.ok) throw new Error(`routing service returned ${response.status}`);
    const payload = (await response.json()) as {
      features?: Array<Feature<Polygon | MultiPolygon>>;
    };
    const feature = payload.features?.[0];
    if (!feature?.geometry) throw new Error('routing service returned no contour');

    const result: IsochroneResult = {
      polygon: { type: 'Feature', properties: {}, geometry: feature.geometry },
      estimated: false,
    };
    memory.set(key, result);
    persist(key, result);
    return result;
  } catch (error) {
    console.warn('Isochrone request failed, falling back to radius estimate:', error);
    const result: IsochroneResult = {
      polygon: radiusFallback(lat, lon, minutes),
      estimated: true,
    };
    memory.set(key, result);
    return result;
  }
}

/**
 * Combine several workplace zones.
 *
 * 'all' intersects them -- the answer to "somewhere both of us can commute
 * from", which is the whole point of entering more than one workplace. 'any'
 * keeps them separate and treats membership in any one as a match.
 */
export function combineZones(
  zones: Array<Feature<Polygon | MultiPolygon>>,
  mode: 'all' | 'any',
): Feature<Polygon | MultiPolygon> | null {
  if (zones.length === 0) return null;
  if (zones.length === 1) return zones[0];
  if (mode === 'any') {
    // Kept as a MultiPolygon rather than unioned: overlapping rings render
    // fine, and skipping the union keeps this cheap on complex isochrones.
    const parts: Polygon['coordinates'][] = [];
    for (const zone of zones) {
      if (zone.geometry.type === 'Polygon') parts.push(zone.geometry.coordinates);
      else parts.push(...zone.geometry.coordinates);
    }
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: parts },
    };
  }

  let accumulator: Feature<Polygon | MultiPolygon> | null = zones[0];
  for (let i = 1; i < zones.length; i += 1) {
    if (!accumulator) return null;
    const next: Feature<Polygon | MultiPolygon> | null = intersect(
      featureCollection([accumulator, zones[i]]),
    );
    if (!next) return null; // No overlap at all -- an empty result is the truth.
    accumulator = next;
  }
  return accumulator;
}
