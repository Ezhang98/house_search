import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import type { Feature, FeatureCollection, Geometry, Point, Position } from 'geojson';
import type { HitState, LayerResult } from '../types';

/** USGS 7.5-minute quadrangles tile on a regular 0.125° grid. */
const QUAD_DEG = 0.125;

/**
 * Layers that only exist for quadrangles the state has actually mapped.
 * Outside a mapped quad there is no data, which is emphatically not the same as
 * no hazard, so those points resolve to `unknown` instead of `clear`.
 */
const QUAD_COVERAGE_LAYERS = new Set(['liquefaction', 'landslide', 'fault']);

function bboxOf(geometry: Geometry): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (coords: unknown): void => {
    if (typeof (coords as number[])[0] === 'number') {
      const [x, y] = coords as [number, number];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const part of coords as unknown[]) walk(part);
  };
  if ('coordinates' in geometry) walk(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

function quadKey(lon: number, lat: number): string {
  return `${Math.floor(lon / QUAD_DEG)}:${Math.floor(lat / QUAD_DEG)}`;
}

/**
 * A loaded layer plus the small amount of precomputation that makes repeated
 * point queries cheap: per-feature bounding boxes for a fast reject, and (where
 * relevant) the set of quadrangles the dataset actually covers.
 */
export class LayerIndex {
  readonly id: string;
  private readonly features: Feature[];
  private readonly boxes: Array<[number, number, number, number]>;
  private readonly mappedQuads: Set<string> | null;

  constructor(id: string, collection: FeatureCollection) {
    this.id = id;
    this.features = collection.features.filter((f) => Boolean(f.geometry));
    this.boxes = this.features.map((f) => bboxOf(f.geometry as Geometry));

    if (QUAD_COVERAGE_LAYERS.has(id)) {
      const quads = new Set<string>();
      for (const box of this.boxes) {
        for (let lon = box[0]; lon <= box[2] + QUAD_DEG; lon += QUAD_DEG) {
          for (let lat = box[1]; lat <= box[3] + QUAD_DEG; lat += QUAD_DEG) {
            quads.add(quadKey(lon, lat));
          }
        }
      }
      this.mappedQuads = quads;
    } else {
      this.mappedQuads = null;
    }
  }

  /** Does this layer have any coverage where the point sits? */
  hasCoverageAt(lon: number, lat: number): boolean {
    if (!this.mappedQuads) return true;
    return this.mappedQuads.has(quadKey(lon, lat));
  }

  /** Point-in-polygon against the (simplified) display geometry. */
  containing(lon: number, lat: number): Feature | null {
    const pt = point([lon, lat]);
    for (let i = 0; i < this.features.length; i += 1) {
      const box = this.boxes[i];
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
      const geometry = this.features[i].geometry;
      if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;
      if (booleanPointInPolygon(pt, this.features[i] as Feature<never>)) return this.features[i];
    }
    return null;
  }

  /**
   * Nearest feature in miles, searching outward in rings so that a dense urban
   * layer does not force a scan of every feature in the state.
   */
  nearest(lon: number, lat: number, maxMi = 25): { feature: Feature; distanceMi: number } | null {
    const pt = point([lon, lat]);
    let best: { feature: Feature; distanceMi: number } | null = null;

    for (const searchDeg of [0.02, 0.08, 0.3, 1.0]) {
      for (let i = 0; i < this.features.length; i += 1) {
        const box = this.boxes[i];
        if (
          lon < box[0] - searchDeg ||
          lon > box[2] + searchDeg ||
          lat < box[1] - searchDeg ||
          lat > box[3] + searchDeg
        ) {
          continue;
        }
        const feature = this.features[i];
        const d = this.distanceToFeature(pt, feature);
        if (d === null) continue;
        if (!best || d < best.distanceMi) best = { feature, distanceMi: d };
      }
      // Only trust this ring if the winner is comfortably inside it; a feature
      // just past the edge could still be closer than one found here.
      if (best && best.distanceMi < searchDeg * 55) break;
    }

    if (best && best.distanceMi > maxMi) return null;
    return best;
  }

  private distanceToFeature(pt: Feature<Point>, feature: Feature): number | null {
    const geometry = feature.geometry;
    switch (geometry.type) {
      case 'Point':
        return distance(pt, point(geometry.coordinates as Position), { units: 'miles' });
      case 'LineString':
        if (geometry.coordinates.length < 2) return null;
        return distance(pt, nearestPointOnLine(geometry, pt), { units: 'miles' });
      case 'MultiLineString': {
        let min: number | null = null;
        for (const line of geometry.coordinates) {
          if (line.length < 2) continue;
          const d = distance(pt, nearestPointOnLine(lineString(line), pt), { units: 'miles' });
          if (min === null || d < min) min = d;
        }
        return min;
      }
      case 'Polygon':
      case 'MultiPolygon': {
        if (booleanPointInPolygon(pt, feature as Feature<never>)) return 0;
        const rings =
          geometry.type === 'Polygon'
            ? geometry.coordinates
            : geometry.coordinates.flatMap((poly) => poly);
        let min: number | null = null;
        for (const ring of rings) {
          if (ring.length < 2) continue;
          const d = distance(pt, nearestPointOnLine(lineString(ring), pt), { units: 'miles' });
          if (min === null || d < min) min = d;
        }
        return min;
      }
      default:
        return null;
    }
  }
}

/**
 * Ask the authoritative service whether this exact coordinate falls in a zone.
 *
 * The prebaked geometry is simplified for drawing; at parcel scale a simplified
 * edge can be tens of metres off, which is the difference between needing flood
 * insurance and not. So the map is drawn from local data and the table's answer
 * comes from upstream.
 */
export async function authoritativePointQuery(
  serviceUrl: string,
  lon: number,
  lat: number,
  outFields: string,
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    f: 'json',
  });
  try {
    const response = await fetch(`${serviceUrl}/query?${params}`);
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      features?: Array<{ attributes: Record<string, unknown> }>;
      error?: unknown;
    };
    if (payload.error) return null;
    return (payload.features ?? []).map((f) => f.attributes);
  } catch {
    return null;
  }
}

export function stateFrom(hit: boolean, hasCoverage: boolean): HitState {
  if (hit) return 'hit';
  return hasCoverage ? 'clear' : 'unknown';
}

export function emptyResult(): LayerResult {
  return { state: 'unknown' };
}
