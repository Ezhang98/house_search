import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import bbox from '@turf/bbox';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { DEFAULT_MINUTES, LAYER_COLORS } from './config/constants';
import { geocode, GeocodeError } from './geo/geocode';
import { combineZones, fetchIsochrone } from './geo/isochrone';
import { scoreCandidate, summarizeRisk } from './geo/scoring';
import { buildRegistry, getIndex, type LayerDef } from './map/layerRegistry';
import { MapView } from './map/mapView';
import { loadPrices, priceAt, type PriceData } from './map/prices';
import {
  download,
  exportCsv,
  exportGeoJson,
  exportPortfolio,
  ImportError,
  importPortfolio,
} from './state/portfolio';
import { blankCandidate, blankWorkplace, store } from './state/store';
import { escapeHtml, renderTable } from './ui/table';
import type { LayerManifest } from './types';

const BASE_URL = import.meta.env.BASE_URL;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let layers: LayerDef[] = [];
let mapView: MapView;
let priceData: PriceData | null = null;
let currentZone: Feature<Polygon | MultiPolygon> | null = null;
let zoneEstimated = false;

function toast(message: string, isError = false, ms = 5200): void {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast ${isError ? 'error' : ''}`;
  node.hidden = false;
  window.clearTimeout((node as unknown as { _t?: number })._t);
  (node as unknown as { _t?: number })._t = window.setTimeout(() => {
    node.hidden = true;
  }, ms);
}

// ---------------------------------------------------------------------------
// Commute zone
// ---------------------------------------------------------------------------

async function rebuildZone(): Promise<void> {
  const state = store.get();
  const status = el('zone-status');

  if (state.workplaces.length === 0) {
    currentZone = null;
    zoneEstimated = false;
    mapView.setZone(null, false);
    status.textContent = '';
    rescoreAll();
    return;
  }

  status.textContent = 'Calculating drive-time zone…';
  const results = await Promise.all(
    state.workplaces.map((workplace) =>
      fetchIsochrone(workplace.lat, workplace.lon, workplace.minutes, state.trafficFactor),
    ),
  );

  zoneEstimated = results.some((r) => r.estimated);
  currentZone = combineZones(
    results.map((r) => r.polygon),
    state.zoneMode,
  );

  mapView.setZone(currentZone, zoneEstimated);

  if (!currentZone) {
    status.innerHTML =
      '<strong>No overlap.</strong> These workplaces have no common commute zone at these times. ' +
      'Raise a limit, or switch “Combine” to “within any zone”.';
  } else {
    const label = state.zoneMode === 'all' && state.workplaces.length > 1 ? 'Overlap of all zones' : 'Drive-time zone';
    status.innerHTML = zoneEstimated
      ? `<strong>${label} (rough estimate).</strong> The routing service was unavailable, so this is a plain radius that ignores roads and terrain.`
      : `${label}, built from free-flow routing shrunk by ${state.trafficFactor.toFixed(2)}× for traffic.`;
    mapView.fitBounds(bbox(currentZone) as [number, number, number, number]);
  }

  rescoreAll();
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

let scoringToken = 0;

async function rescoreAll(): Promise<void> {
  const token = ++scoringToken;
  const state = store.get();
  const active = layers.filter((def) => state.enabledLayers[def.id]);
  if (state.candidates.length === 0) {
    render();
    return;
  }

  // Score sequentially so a long list does not fire hundreds of simultaneous
  // requests at the agencies' services.
  for (const candidate of state.candidates) {
    if (token !== scoringToken) return;
    await scoreCandidate(candidate, active, BASE_URL, state.workplaces, currentZone);
    if (priceData) candidate.zipPrice = priceAt(priceData, candidate.lon, candidate.lat);
    if (token !== scoringToken) return;
    store.update(() => {});
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderWorkplaces(): void {
  const state = store.get();
  const list = el('work-list');
  list.innerHTML = state.workplaces
    .map(
      (workplace) => `
      <li data-id="${workplace.id}">
        <span class="work-address" title="${escapeHtml(workplace.address)}">${escapeHtml(
          workplace.address,
        )}</span>
        <span class="work-controls">
          <input type="number" class="minutes" min="5" max="120" step="5" value="${workplace.minutes}" />
          <span class="muted">min</span>
          <button class="remove" data-remove title="Remove workplace">×</button>
        </span>
      </li>`,
    )
    .join('');

  list.querySelectorAll<HTMLLIElement>('li').forEach((item) => {
    const id = item.dataset.id!;
    item.querySelector<HTMLInputElement>('.minutes')?.addEventListener('change', (event) => {
      const minutes = Number((event.target as HTMLInputElement).value) || DEFAULT_MINUTES;
      store.update((state) => {
        const workplace = state.workplaces.find((w) => w.id === id);
        if (workplace) workplace.minutes = minutes;
      });
      void rebuildZone();
    });
    item.querySelector('[data-remove]')?.addEventListener('click', () => {
      store.update((state) => {
        state.workplaces = state.workplaces.filter((w) => w.id !== id);
      });
      void rebuildZone();
    });
  });
}

function renderLayerPanel(): void {
  const state = store.get();
  const container = el('layer-list');

  const groups: Array<[string, LayerDef[]]> = [
    ['Hazards', layers.filter((d) => d.kind === 'hazard')],
    ['Infrastructure & industry', layers.filter((d) => d.kind === 'infrastructure')],
  ];

  container.innerHTML = groups
    .map(
      ([title, defs]) => `
      <div class="layer-group">
        <h3>${title}</h3>
        ${defs
          .map((def) => {
            const mb = def.bytes / 1_048_576;
            const size = mb >= 1 ? `${mb.toFixed(0)} MB` : `${Math.round(def.bytes / 1024)} KB`;
            const caveat = def.caveat ? ` <span class="warn" title="${escapeHtml(def.caveat)}">!</span>` : '';
            return `
              <label class="layer-row" title="${escapeHtml(def.notes ?? '')}">
                <input type="checkbox" data-layer="${def.id}" ${state.enabledLayers[def.id] ? 'checked' : ''} />
                <i class="swatch" style="background:${swatchColor(def.id)}"></i>
                <span class="layer-name">${escapeHtml(def.label)}${caveat}</span>
                <span class="muted layer-size">${size}</span>
              </label>`;
          })
          .join('')}
      </div>`,
    )
    .join('');

  container.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.layer!;
      const def = layers.find((d) => d.id === id)!;
      store.update((state) => {
        state.enabledLayers[id] = input.checked;
      });
      void toggleLayer(def, input.checked);
    });
  });
}

function swatchColor(layerId: string): string {
  return Object.values(LAYER_COLORS[layerId] ?? {})[0] ?? '#888';
}

async function toggleLayer(def: LayerDef, on: boolean): Promise<void> {
  if (on) {
    try {
      el('layer-list').classList.add('loading');
      await mapView.ensureLayer(def, BASE_URL);
      mapView.setLayerVisible(def, true);
      await getIndex(def, BASE_URL);
    } catch (error) {
      toast(`Could not load ${def.label}: ${(error as Error).message}`, true);
      store.update((state) => {
        state.enabledLayers[def.id] = false;
      });
      renderLayerPanel();
      return;
    } finally {
      el('layer-list').classList.remove('loading');
    }
  } else {
    mapView.setLayerVisible(def, false);
  }
  void rescoreAll();
}

function render(): void {
  const state = store.get();
  renderWorkplaces();
  mapView.syncWorkplaces(state.workplaces);
  mapView.syncCandidates(state.candidates, (candidate) => {
    const enabledIds = layers.filter((d) => state.enabledLayers[d.id]).map((d) => d.id);
    return summarizeRisk(candidate, enabledIds).band;
  });
  renderTable(el('table'), state, layers, {
    onFocus: (id) => {
      const candidate = state.candidates.find((c) => c.id === id);
      if (candidate) mapView.flyTo(candidate.lat, candidate.lon);
    },
    onRemove: (id) => {
      store.update((s) => {
        s.candidates = s.candidates.filter((c) => c.id !== id);
      });
    },
    onEdit: (id, field, value) => {
      store.update((s) => {
        const candidate = s.candidates.find((c) => c.id === id);
        if (!candidate) return;
        if (field === 'price') candidate.price = value ? Number(value) : null;
        else candidate[field] = value;
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function addWorkplace(address: string): Promise<void> {
  try {
    const result = await geocode(address);
    if (result.outOfState) {
      toast(
        `"${result.address}" is outside California. This tool only has California hazard data, so it would give you a map with nothing on it.`,
        true,
        8000,
      );
      return;
    }
    store.update((state) => {
      state.workplaces.push(blankWorkplace(result.address, result.lat, result.lon));
    });
    await rebuildZone();
  } catch (error) {
    toast(error instanceof GeocodeError ? error.message : String(error), true);
  }
}

async function addCandidate(address: string): Promise<void> {
  try {
    const result = await geocode(address);
    await addCandidateAt(result.address, result.lat, result.lon);
  } catch (error) {
    toast(error instanceof GeocodeError ? error.message : String(error), true);
  }
}

async function addCandidateAt(address: string, lat: number, lon: number): Promise<void> {
  const candidate = blankCandidate(address, lat, lon);
  store.update((state) => {
    state.candidates.push(candidate);
  });
  const state = store.get();
  const active = layers.filter((def) => state.enabledLayers[def.id]);
  await scoreCandidate(candidate, active, BASE_URL, state.workplaces, currentZone);
  if (priceData) candidate.zipPrice = priceAt(priceData, lon, lat);
  store.update(() => {});
}

async function switchTab(tab: 'hazards' | 'prices'): Promise<void> {
  store.update((state) => {
    state.tab = tab;
  });
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  el('section-layers').hidden = tab !== 'hazards';
  el('section-price').hidden = tab !== 'prices';

  if (tab === 'prices') {
    try {
      await ensurePrices();
    } catch (error) {
      el('price-meta').textContent = `Could not load price data: ${(error as Error).message}`;
      return;
    }
    mapView.setPriceVisible(true);
  } else {
    mapView.setPriceVisible(false);
  }
}

let pricePromise: Promise<void> | null = null;

/**
 * Loaded once, lazily, and shared. Kicked off in the background at boot so the
 * "ZIP sold" column fills in on the main table without the user ever having to
 * open the prices tab.
 */
function ensurePrices(): Promise<void> {
  if (pricePromise) return pricePromise;
  el('price-meta').textContent = 'Loading sold-price data…';
  pricePromise = loadPrices(BASE_URL)
    .then((data) => {
      priceData = data;
      mapView.setPriceData(data.polygons);
      renderPricePanel();
      store.update((state) => {
        for (const candidate of state.candidates) {
          candidate.zipPrice = priceAt(data, candidate.lon, candidate.lat);
        }
      });
    })
    .catch((error) => {
      pricePromise = null; // allow a retry when the tab is opened
      throw error;
    });
  return pricePromise;
}

function renderPricePanel(): void {
  if (!priceData) return;
  const { meta } = priceData;
  el('price-meta').innerHTML = `
    ${escapeHtml(meta.metric)}.<br />
    Covering <strong>${escapeHtml(meta.period_start)}</strong> to <strong>${escapeHtml(meta.period_end)}</strong>
    across ${meta.zip_count.toLocaleString()} ZIP codes.<br />
    <span class="muted">Snapshot taken ${escapeHtml(meta.generated_at.slice(0, 10))}. ${escapeHtml(
      meta.attribution,
    )}</span>`;

  el('price-legend').innerHTML = [
    ['#1a9850', '≤ $300k'],
    ['#a6d96a', '$600k'],
    ['#ffffbf', '$900k'],
    ['#fdae61', '$1.4M'],
    ['#d73027', '$2.2M+'],
    ['#e5e7eb', 'no data'],
  ]
    .map(([color, label]) => `<span class="key"><i class="swatch" style="background:${color}"></i>${label}</span>`)
    .join('');
}

function renderProvenance(manifest: LayerManifest): void {
  const parts = Object.values(manifest.layers)
    .filter((entry) => entry.status === 'ok' && entry.kind !== 'basemap')
    .map((entry) => `${entry.label} — ${entry.attribution} (fetched ${entry.fetched_at.slice(0, 10)})`);
  el('provenance').innerHTML = `Layer sources: ${parts.map(escapeHtml).join(' · ')}. Routing by Valhalla (FOSSGIS). Geocoding by the U.S. Census Bureau and Nominatim.`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  mapView = new MapView(el('map'));

  // Deliberately not awaiting map readiness here. The map needs WebGL and a
  // reachable tile CDN; the filters, table and controls need neither. Blocking
  // the whole UI on the map means one failure leaves a blank page.
  const manifest = (await fetch(`${BASE_URL}data/manifest.json`).then((r) => r.json())) as LayerManifest;
  layers = buildRegistry(manifest);
  renderProvenance(manifest);

  store.load();
  store.initLayers(layers.map((def) => def.id));
  store.subscribe(() => render());

  renderLayerPanel();
  render();

  const state = store.get();
  el('zone-mode').setAttribute('value', state.zoneMode);
  (el('zone-mode') as HTMLSelectElement).value = state.zoneMode;
  (el('traffic') as HTMLInputElement).value = String(state.trafficFactor);
  el('traffic-out').textContent = `${state.trafficFactor.toFixed(2)}×`;
  if (state.budget) (el('budget') as HTMLInputElement).value = String(state.budget);

  wireEvents();

  // Anything that draws on the map waits for the map, but only that.
  void mapView.whenReady().then(() => {
    for (const def of layers) {
      if (store.get().enabledLayers[def.id]) void toggleLayer(def, true);
    }
    render();
    if (store.get().workplaces.length > 0) void rebuildZone();
    // Warm the price data quietly; a failure here must not surface as an error
    // on a tab the user has not asked for.
    void ensurePrices().catch(() => undefined);
  });
}

function wireEvents(): void {
  el('form-work').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el<HTMLInputElement>('input-work');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    void addWorkplace(value);
  });

  el('form-candidate').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el<HTMLInputElement>('input-candidate');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    void addCandidate(value);
  });

  el('zone-mode').addEventListener('change', (event) => {
    store.update((state) => {
      state.zoneMode = (event.target as HTMLSelectElement).value as 'all' | 'any';
    });
    void rebuildZone();
  });

  const traffic = el<HTMLInputElement>('traffic');
  traffic.addEventListener('input', () => {
    el('traffic-out').textContent = `${Number(traffic.value).toFixed(2)}×`;
  });
  traffic.addEventListener('change', () => {
    store.update((state) => {
      state.trafficFactor = Number(traffic.value);
    });
    void rebuildZone();
  });

  el('budget').addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value;
    store.update((state) => {
      state.budget = value ? Number(value) : null;
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => {
    button.addEventListener('click', () => void switchTab(button.dataset.tab as 'hazards' | 'prices'));
  });

  mapView.setMapClickHandler((lat, lon) => {
    void addCandidateAt(`Pin at ${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon);
  });

  el('btn-export').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(
      `house-search-${stamp}.json`,
      JSON.stringify(exportPortfolio(store.get()), null, 2),
      'application/json',
    );
  });

  el('btn-csv').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`house-search-${stamp}.csv`, exportCsv(store.get(), layers), 'text/csv');
  });

  el('btn-geojson').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`house-search-${stamp}.geojson`, exportGeoJson(store.get()), 'application/geo+json');
  });

  el('btn-import').addEventListener('click', () => el('file-import').click());

  el('file-import').addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const parsed = importPortfolio(JSON.parse(await file.text()));
      store.replace({ ...store.get(), ...parsed });
      renderLayerPanel();
      for (const def of layers) {
        if (store.get().enabledLayers[def.id]) void toggleLayer(def, true);
      }
      await rebuildZone();
      toast(`Loaded ${parsed.candidates?.length ?? 0} addresses. Hazards are being re-checked against current data.`);
    } catch (error) {
      toast(error instanceof ImportError ? error.message : `Could not read that file: ${error}`, true, 9000);
    } finally {
      (event.target as HTMLInputElement).value = '';
    }
  });
}

void boot();
