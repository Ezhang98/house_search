import type { FeatureCollection } from 'geojson';
import { LayerIndex } from '../geo/hitTest';
import { LAYER_ORDER } from '../config/constants';
import type { LayerKind, LayerManifest, LayerManifestEntry } from '../types';

/**
 * A layer as the user sees it. Several of these can be carved out of one
 * downloaded file: OpenStreetMap ships quarries alongside industrial land, and
 * data centers alongside electrical substations, but "0.2 mi from a substation"
 * and "0.2 mi from a data center" are different findings and belong in
 * different columns.
 */
export interface LayerDef {
  id: string;
  label: string;
  kind: LayerKind;
  geometry: 'polygon' | 'line' | 'point';
  /** File in public/data to fetch. Shared by split layers. */
  file: string;
  /** When set, keep only features whose `c` property is in this set. */
  classFilter?: Set<string>;
  /** Proximity layers report distance; zone layers report inside/outside. */
  mode: 'zone' | 'proximity';
  attribution: string;
  fetchedAt: string;
  bytes: number;
  featureCount: number;
  notes?: string;
  caveat?: string;
  pointQueryUrl?: string | null;
  pointQueryFields?: string;
}

const SPLITS: Record<string, Array<{ id: string; label: string; classes: string[]; caveat?: string }>> = {
  industrial: [
    { id: 'industrial', label: 'Industrial land', classes: ['industrial'] },
    { id: 'mines', label: 'Mines and quarries', classes: ['mine'] },
  ],
  datacenters: [
    {
      id: 'datacenters',
      label: 'Data centers',
      classes: ['data-center'],
      caveat:
        'Only 114 data centers are tagged in OpenStreetMap statewide and there is no authoritative public dataset. Treat a clear result as "not known to us", not "none nearby".',
    },
    { id: 'substations', label: 'Electrical substations', classes: ['substation'] },
  ],
};

const ZONE_LAYERS = new Set(['flood', 'fire', 'liquefaction', 'landslide', 'fault', 'tsunami']);

const POINT_QUERY_FIELDS: Record<string, string> = {
  flood: 'FLD_ZONE,ZONE_SUBTY',
  fire: 'FHSZ,FHSZ_Description',
  liquefaction: 'QUAD_NAME',
  landslide: 'QUAD_NAME',
  fault: 'QUAD_NAME',
  tsunami: 'Evacuate,County',
};

export function buildRegistry(manifest: LayerManifest): LayerDef[] {
  const defs: LayerDef[] = [];

  for (const entry of Object.values(manifest.layers)) {
    if (entry.status !== 'ok' || entry.kind === 'basemap') continue;
    const splits = SPLITS[entry.id];
    if (splits) {
      for (const split of splits) {
        defs.push(makeDef(entry, split.id, split.label, new Set(split.classes), split.caveat));
      }
    } else {
      defs.push(makeDef(entry, entry.id, entry.label));
    }
  }

  // Present layers in a deliberate reading order (hazards by how often they
  // decide a purchase, then infrastructure), not in whatever order the build
  // pipeline happened to finish them.
  const rank = new Map(LAYER_ORDER.map((id, index) => [id, index]));
  defs.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  return defs;
}

function makeDef(
  entry: LayerManifestEntry,
  id: string,
  label: string,
  classFilter?: Set<string>,
  extraCaveat?: string,
): LayerDef {
  return {
    id,
    label,
    kind: entry.kind,
    geometry: entry.geometry,
    file: entry.file,
    classFilter,
    mode: ZONE_LAYERS.has(id) ? 'zone' : 'proximity',
    attribution: entry.attribution,
    fetchedAt: entry.fetched_at,
    bytes: entry.bytes,
    featureCount: entry.feature_count,
    notes: entry.notes,
    caveat: extraCaveat ?? entry.coverage_caveat,
    pointQueryUrl: entry.point_query_url ?? null,
    pointQueryFields: POINT_QUERY_FIELDS[id],
  };
}

/** Loaded layer payloads, keyed by file so split layers share one download. */
const fileCache = new Map<string, Promise<FeatureCollection>>();
const indexCache = new Map<string, LayerIndex>();

export async function loadLayerData(def: LayerDef, baseUrl: string): Promise<FeatureCollection> {
  const url = `${baseUrl}${def.file}`;
  let pending = fileCache.get(def.file);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Could not load ${def.label} (${response.status})`);
      return response.json() as Promise<FeatureCollection>;
    });
    fileCache.set(def.file, pending);
  }
  const collection = await pending;
  if (!def.classFilter) return collection;
  return {
    type: 'FeatureCollection',
    features: collection.features.filter((f) => def.classFilter!.has(String(f.properties?.c))),
  };
}

export async function getIndex(def: LayerDef, baseUrl: string): Promise<LayerIndex> {
  const existing = indexCache.get(def.id);
  if (existing) return existing;
  const data = await loadLayerData(def, baseUrl);
  const index = new LayerIndex(def.id, data);
  indexCache.set(def.id, index);
  return index;
}

export function hasIndex(id: string): boolean {
  return indexCache.has(id);
}
