/** Statewide California view, used before any workplace is entered. */
export const CA_CENTER: [number, number] = [-119.4, 37.2];
export const CA_ZOOM = 5.2;
export const CA_BOUNDS: [number, number, number, number] = [-124.55, 32.45, -114.05, 42.05];

export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

export const VALHALLA_ENDPOINT = 'https://valhalla1.openstreetmap.de/isochrone';

/**
 * Free-flow routing runs optimistic against a real commute, so we shrink the
 * requested time before asking for it: a 30-minute zone is built from
 * 30 / 1.35 ≈ 22 minutes of free-flow driving. The result is deliberately
 * conservative -- it under-promises reach rather than over-promising it.
 */
export const DEFAULT_TRAFFIC_FACTOR = 1.35;
export const DEFAULT_MINUTES = 30;

/** Valhalla's public instance is a shared community resource; stay polite. */
export const ISOCHRONE_MIN_INTERVAL_MS = 1100;
export const ISOCHRONE_MAX_MINUTES = 120;

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
export const CENSUS_ENDPOINT =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

export const STORAGE_KEY = 'house-search/v1';
export const PORTFOLIO_SCHEMA = 'house-search/v1';

/**
 * Distance below which a proximity layer counts as a flag on a candidate row.
 * These are judgement calls, not published standards -- freeway noise and
 * particulates fall off steeply within a few hundred metres, aircraft noise
 * does not.
 */
export const PROXIMITY_FLAG_MI: Record<string, number> = {
  roads: 0.25,
  rail: 0.25,
  airports: 1.5,
  industrial: 0.25,
  mines: 1.0,
  datacenters: 0.5,
  substations: 0.25,
};

/** Row banding: green at zero flags, yellow while it is a mixed picture, red beyond. */
export const RISK_YELLOW_AT = 1;
export const RISK_RED_AT = 3;

export const LAYER_COLORS: Record<string, Record<string, string>> = {
  flood: {
    sfha: '#2c7fb8',
    floodway: '#08519c',
    'coastal-high': '#54278f',
  },
  fire: {
    moderate: '#fed976',
    high: '#fd8d3c',
    'very-high': '#e31a1c',
  },
  liquefaction: { zone: '#41ab5d' },
  landslide: { zone: '#8c6d31' },
  fault: { zone: '#d95f0e' },
  tsunami: { zone: '#3182bd' },
  roads: { freeway: '#e6550d', trunk: '#fd8d3c', primary: '#fdae6b' },
  rail: { rail: '#525252', transit: '#969696' },
  airports: { commercial: '#6a51a3', 'general-aviation': '#9e9ac8', military: '#54278f' },
  industrial: { industrial: '#756bb1' },
  mines: { mine: '#8c510a' },
  datacenters: { 'data-center': '#016c59' },
  substations: { substation: '#67a9cf' },
};

export const DEFAULT_LAYER_COLOR = '#888888';

/** Order layers appear in the panel and the table. */
export const LAYER_ORDER = [
  'flood',
  'fire',
  'liquefaction',
  'landslide',
  'fault',
  'tsunami',
  'roads',
  'rail',
  'airports',
  'industrial',
  'mines',
  'datacenters',
  'substations',
];

/** Layers switched on the first time someone opens the page. */
export const DEFAULT_ENABLED = new Set(['flood', 'fire', 'liquefaction', 'fault', 'roads']);
