import { PORTFOLIO_SCHEMA } from '../config/constants';
import type { AppState, Candidate } from '../types';
import type { LayerDef } from '../map/layerRegistry';
import { summarizeRisk } from '../geo/scoring';

export interface Portfolio {
  schema: string;
  exportedAt: string;
  zoneMode: AppState['zoneMode'];
  trafficFactor: number;
  budget: number | null;
  enabledLayers: Record<string, boolean>;
  workplaces: Array<{ id: string; address: string; lat: number; lon: number; minutes: number }>;
  candidates: Array<{
    id: string;
    address: string;
    label: string;
    lat: number;
    lon: number;
    notes: string;
    price: number | null;
  }>;
}

export function exportPortfolio(state: AppState): Portfolio {
  return {
    schema: PORTFOLIO_SCHEMA,
    exportedAt: new Date().toISOString(),
    zoneMode: state.zoneMode,
    trafficFactor: state.trafficFactor,
    budget: state.budget,
    enabledLayers: { ...state.enabledLayers },
    workplaces: state.workplaces.map(({ id, address, lat, lon, minutes }) => ({
      id,
      address,
      lat,
      lon,
      minutes,
    })),
    // Hazard verdicts are deliberately not exported. They are recomputed on
    // import against whatever the datasets say today; a cached verdict from six
    // months ago is worse than no verdict.
    candidates: state.candidates.map(({ id, address, label, lat, lon, notes, price }) => ({
      id,
      address,
      label,
      lat,
      lon,
      notes,
      price,
    })),
  };
}

export class ImportError extends Error {}

export function importPortfolio(raw: unknown): Partial<AppState> {
  if (!raw || typeof raw !== 'object') throw new ImportError('That file is not a saved map.');
  const data = raw as Partial<Portfolio>;

  if (data.schema !== PORTFOLIO_SCHEMA) {
    throw new ImportError(
      `This file says it is "${data.schema ?? 'unknown'}", but this version reads "${PORTFOLIO_SCHEMA}". ` +
        'Nothing was loaded.',
    );
  }
  if (!Array.isArray(data.workplaces) || !Array.isArray(data.candidates)) {
    throw new ImportError('That file is missing its workplace or address list.');
  }

  const candidates: Candidate[] = data.candidates.map((entry) => ({
    id: String(entry.id),
    address: String(entry.address ?? ''),
    label: String(entry.label ?? ''),
    lat: Number(entry.lat),
    lon: Number(entry.lon),
    notes: String(entry.notes ?? ''),
    price: entry.price === null || entry.price === undefined ? null : Number(entry.price),
    results: {},
    driveTimes: {},
    inZone: null,
    scored: false,
  }));

  if (candidates.some((c) => !Number.isFinite(c.lat) || !Number.isFinite(c.lon))) {
    throw new ImportError('That file contains an address with no valid coordinates.');
  }

  return {
    workplaces: data.workplaces.map((entry) => ({
      id: String(entry.id),
      address: String(entry.address ?? ''),
      lat: Number(entry.lat),
      lon: Number(entry.lon),
      minutes: Number(entry.minutes) || 30,
    })),
    candidates,
    enabledLayers: data.enabledLayers ?? {},
    zoneMode: data.zoneMode === 'any' ? 'any' : 'all',
    trafficFactor: Number(data.trafficFactor) || 1.35,
    budget: data.budget === null || data.budget === undefined ? null : Number(data.budget),
  };
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportCsv(state: AppState, layers: LayerDef[]): string {
  const enabled = layers.filter((def) => state.enabledLayers[def.id]);
  const header = [
    'address',
    'label',
    'lat',
    'lon',
    'price',
    'zip_median_sale_price',
    'in_commute_zone',
    ...state.workplaces.map((w) => `est_min_to_${w.address.slice(0, 24).replace(/[,\s]+/g, '_')}`),
    'hazard_flags',
    'risk_band',
    ...enabled.map((def) => def.id),
    'notes',
  ];

  const rows = state.candidates.map((candidate) => {
    const risk = summarizeRisk(candidate, enabled.map((d) => d.id));
    const cells: unknown[] = [
      candidate.address,
      candidate.label,
      candidate.lat,
      candidate.lon,
      candidate.price,
      candidate.zipPrice?.medianSalePrice ?? '',
      candidate.inZone === null ? '' : candidate.inZone ? 'yes' : 'no',
      ...state.workplaces.map((w) => {
        const minutes = candidate.driveTimes[w.id];
        return minutes === null || minutes === undefined ? '' : Math.round(minutes);
      }),
      risk.flags,
      risk.band,
      ...enabled.map((def) => {
        const result = candidate.results[def.id];
        if (!result) return '';
        if (def.mode === 'proximity') {
          return result.distanceMi === undefined ? '' : `${result.distanceMi.toFixed(2)} mi`;
        }
        if (result.state === 'hit') return result.value ?? 'yes';
        return result.state === 'unknown' ? 'no data' : 'clear';
      }),
      candidate.notes,
    ];
    return cells.map(csvEscape).join(',');
  });

  return [header.join(','), ...rows].join('\n');
}

export function exportGeoJson(state: AppState): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: [
        ...state.workplaces.map((w) => ({
          type: 'Feature',
          properties: { kind: 'workplace', address: w.address, minutes: w.minutes },
          geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
        })),
        ...state.candidates.map((c) => ({
          type: 'Feature',
          properties: {
            kind: 'candidate',
            address: c.address,
            label: c.label,
            price: c.price,
            notes: c.notes,
          },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        })),
      ],
    },
    null,
    2,
  );
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
