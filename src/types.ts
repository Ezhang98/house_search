import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export type LayerKind = 'hazard' | 'infrastructure' | 'basemap';
export type LayerGeometry = 'polygon' | 'line' | 'point';

/** One entry from public/data/manifest.json, written by data/build_layers.py. */
export interface LayerManifestEntry {
  id: string;
  label: string;
  kind: LayerKind;
  geometry: LayerGeometry;
  file: string;
  attribution: string;
  feature_count: number;
  bytes: number;
  fetched_at: string;
  status: 'ok' | 'failed';
  notes?: string;
  source_url?: string;
  simplify_deg?: number;
  point_query_url?: string | null;
  coverage_caveat?: string;
  error?: string;
}

export interface LayerManifest {
  generated_at: string;
  layers: Record<string, LayerManifestEntry>;
}

export interface Workplace {
  id: string;
  address: string;
  lat: number;
  lon: number;
  minutes: number;
  /** Cached isochrone, keyed so we do not re-request on every render. */
  isochrone?: Feature<Polygon | MultiPolygon> | null;
  isochroneKey?: string;
  estimated?: boolean;
}

/**
 * Three-state result. `unknown` exists because most California hazard datasets
 * only cover mapped quadrangles -- "no polygon here" is not "no hazard here",
 * and collapsing the two would quietly turn a data gap into a clean bill of
 * health.
 */
export type HitState = 'hit' | 'clear' | 'unknown';

export interface LayerResult {
  state: HitState;
  /** Class string from the layer, e.g. 'very-high' or 'sfha'. */
  value?: string;
  /** Miles to the nearest feature, for line and point layers. */
  distanceMi?: number;
  /** True when the answer came from a live authoritative query, not display geometry. */
  authoritative?: boolean;
}

export interface Candidate {
  id: string;
  address: string;
  label: string;
  lat: number;
  lon: number;
  notes: string;
  price: number | null;
  /** layerId -> result */
  results: Record<string, LayerResult>;
  /** Minutes to each workplace, keyed by workplace id. */
  driveTimes: Record<string, number | null>;
  inZone: boolean | null;
  zipPrice?: ZipPrice | null;
  scored: boolean;
}

export interface ZipPrice {
  zip: string;
  medianSalePrice: number;
  medianPpsf: number | null;
  homesSold: number;
}

export interface PriceMeta {
  metric: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  attribution: string;
  zip_count: number;
  period_duration_days: number;
}

export type ZoneMode = 'all' | 'any';

export interface AppState {
  workplaces: Workplace[];
  candidates: Candidate[];
  /** Which layers are switched on. Off means hidden on the map AND dropped from the table. */
  enabledLayers: Record<string, boolean>;
  zoneMode: ZoneMode;
  trafficFactor: number;
  tab: 'hazards' | 'prices';
  budget: number | null;
}

export type LayerData = FeatureCollection;
