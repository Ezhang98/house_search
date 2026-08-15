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
import {
  candidateFromRow,
  CsvError,
  dedupeKey,
  planCsvImport,
  type CsvPlan,
} from './state/csvImport';
import { blankCandidate, blankWorkplace, store } from './state/store';
import { escapeHtml, renderTable } from './ui/table';
import type { Candidate, LayerManifest } from './types';

const BASE_URL = import.meta.env.BASE_URL;

/**
 * Delay between geocoding requests during a bulk import. Nominatim's usage
 * policy asks for at most one request per second; this leaves headroom.
 */
const GEOCODE_INTERVAL_MS = 1100;

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
      // Build the query index first: scoring the table depends on it, drawing
      // does not. If the map is broken the table must still work.
      await getIndex(def, BASE_URL);
      void mapView
        .ensureLayer(def, BASE_URL)
        .then(() => mapView.setLayerVisible(def, true))
        .catch((error) => console.warn(`Could not draw ${def.label}:`, error));
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

function openClearConfirm(): void {
  const count = store.get().candidates.length;
  if (count === 0) {
    toast('There are no addresses to clear.');
    return;
  }
  el('confirm-clear-text').innerHTML = `<strong>${count}</strong> address${
    count === 1 ? '' : 'es'
  } and everything recorded against ${count === 1 ? 'it' : 'them'} — labels, notes, asking prices,
    hazard results and drive-time estimates — will be removed from the table and the map.`;
  el('confirm-clear').hidden = false;
  el<HTMLButtonElement>('btn-clear-cancel').focus();
}

function closeClearConfirm(): void {
  el('confirm-clear').hidden = true;
}

function clearCandidates(): void {
  const count = store.get().candidates.length;
  // Retire any scoring pass still walking the old list, or it would keep
  // re-rendering on behalf of addresses that no longer exist.
  scoringToken += 1;
  store.update((state) => {
    state.candidates = [];
  });
  closeClearConfirm();
  toast(`Cleared ${count} address${count === 1 ? '' : 'es'}.`);
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
      // The table only needs the joined table; only the choropleth needs the
      // map, so that hand-off waits separately rather than gating the data.
      void mapView.whenReady().then(() => mapView.setPriceData(data.polygons));
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

  for (const def of layers) {
    if (state.enabledLayers[def.id]) void toggleLayer(def, true);
  }

  // Warm the price data quietly; a failure here must not surface as an error on
  // a tab the user has not asked for.
  void ensurePrices().catch(() => undefined);

  if (state.workplaces.length > 0) void rebuildZone();
  void mapView.whenReady().then(() => render());
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
    const value = Number((event.target as HTMLInputElement).value);
    store.update((state) => {
      // Anything that is not a usable ceiling clears the split rather than
      // sorting every address into the over-budget half.
      state.budget = Number.isFinite(value) && value > 0 ? value : null;
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

  el('btn-clear').addEventListener('click', () => openClearConfirm());
  el('btn-clear-cancel').addEventListener('click', () => closeClearConfirm());
  el('btn-clear-confirm').addEventListener('click', () => clearCandidates());
  el('confirm-clear').addEventListener('click', (event) => {
    // Clicking the backdrop cancels; clicking inside the dialog does not.
    if (event.target === el('confirm-clear')) closeClearConfirm();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el('confirm-clear').hidden) closeClearConfirm();
  });

  el('btn-import').addEventListener('click', () => el('file-import').click());

  el('file-import').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      // Dispatch on content, not just extension: a .txt holding a saved map
      // should still load, and a .json full of listings should not be silently
      // treated as a portfolio.
      const looksJson = text.trimStart().startsWith('{');
      if (looksJson) await importPortfolioFile(text);
      else await importCsvFile(text);
    } catch (error) {
      toast(
        error instanceof ImportError || error instanceof CsvError
          ? error.message
          : `Could not read that file: ${error}`,
        true,
        9000,
      );
    } finally {
      input.value = '';
    }
  });

  el('btn-import-cancel').addEventListener('click', () => {
    importCancelled = true;
  });
  el('btn-import-close').addEventListener('click', () => {
    el('import-status').hidden = true;
  });
}

async function importPortfolioFile(text: string): Promise<void> {
  const parsed = importPortfolio(JSON.parse(text));
  store.replace({ ...store.get(), ...parsed });
  renderLayerPanel();
  for (const def of layers) {
    if (store.get().enabledLayers[def.id]) void toggleLayer(def, true);
  }
  await rebuildZone();
  toast(`Loaded ${parsed.candidates?.length ?? 0} addresses. Hazards are being re-checked against current data.`);
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

let importCancelled = false;

function showImportModal(title: string, text: string, showProgress: boolean): void {
  el('import-status').hidden = false;
  el('import-title').textContent = title;
  el('import-text').innerHTML = text;
  el('import-detail').innerHTML = '';
  (el('import-bar').parentElement as HTMLElement).hidden = !showProgress;
  el('import-bar').style.width = '0%';
  el('btn-import-cancel').hidden = !showProgress;
  el('btn-import-close').hidden = showProgress;
}

/**
 * Import candidate addresses from a CSV — typically a "Download All" export
 * from Redfin or Zillow.
 *
 * Rows that already carry latitude and longitude are plotted immediately;
 * only the rest are geocoded, one at a time, because Nominatim's usage policy
 * asks for no more than one request a second and a listing export can be
 * hundreds of rows.
 */
async function importCsvFile(text: string): Promise<void> {
  const plan = planCsvImport(text);
  const existing = new Set(store.get().candidates.map((c) => dedupeKey(c.address, c.lat, c.lon)));

  const matchedSummary = Object.entries(plan.matched)
    .filter(([, header]) => header)
    .map(([key, header]) => `<td><strong>${key}</strong></td><td>${escapeHtml(header!)}</td>`)
    .map((cells) => `<tr>${cells}</tr>`)
    .join('');

  const seconds = Math.ceil((plan.needGeocoding * GEOCODE_INTERVAL_MS) / 1000);
  showImportModal(
    'Importing addresses',
    `Found <strong>${plan.rows.length}</strong> rows. ` +
      (plan.needGeocoding === 0
        ? 'All of them have coordinates, so this will be instant.'
        : `<strong>${plan.needGeocoding}</strong> need geocoding — roughly ${
            seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`
          }. You can cancel at any point and keep what has loaded.`),
    true,
  );
  el('import-detail').innerHTML = `<div>Columns matched:</div><table>${matchedSummary}</table>`;

  importCancelled = false;
  const added: Candidate[] = [];
  const failed: Array<{ line: number; address: string; reason: string }> = [];
  const skipped: string[] = [];

  for (let i = 0; i < plan.rows.length; i += 1) {
    if (importCancelled) break;
    const row = plan.rows[i];

    el('import-bar').style.width = `${Math.round(((i + 1) / plan.rows.length) * 100)}%`;
    el('import-text').innerHTML = `Row <strong>${i + 1}</strong> of ${plan.rows.length} — ${escapeHtml(
      row.address.slice(0, 60),
    )}`;

    let lat = row.lat;
    let lon = row.lon;
    let address = row.address;

    if (lat === null || lon === null) {
      try {
        await new Promise((resolve) => setTimeout(resolve, GEOCODE_INTERVAL_MS));
        const result = await geocode(row.address);
        if (result.outOfState) {
          failed.push({ line: row.line, address: row.address, reason: 'outside California' });
          continue;
        }
        lat = result.lat;
        lon = result.lon;
        address = result.address;
      } catch (error) {
        failed.push({
          line: row.line,
          address: row.address,
          reason: error instanceof GeocodeError ? 'could not be geocoded' : String(error).slice(0, 60),
        });
        continue;
      }
    }

    const key = dedupeKey(address, lat, lon);
    if (existing.has(key)) {
      skipped.push(row.address);
      continue;
    }
    existing.add(key);
    added.push(candidateFromRow(row, lat, lon, address));
  }

  if (added.length > 0) {
    store.update((state) => {
      state.candidates.push(...added);
    });
  }

  reportImport(plan, added.length, failed, skipped);

  // Score in the background so the table appears immediately.
  void rescoreAll();
}

function reportImport(
  plan: CsvPlan,
  addedCount: number,
  failed: Array<{ line: number; address: string; reason: string }>,
  skipped: string[],
): void {
  const parts: string[] = [
    `<strong>${addedCount}</strong> address${addedCount === 1 ? '' : 'es'} added.`,
  ];
  if (importCancelled) parts.push('Import was cancelled; everything loaded so far has been kept.');

  showImportModal(importCancelled ? 'Import cancelled' : 'Import complete', parts.join(' '), false);

  // Nothing is dropped quietly -- every row that did not make it is listed with
  // its line number so it can be fixed and re-imported.
  let detail = '';
  if (failed.length > 0) {
    detail += `<div class="bad"><strong>${failed.length} row${
      failed.length === 1 ? '' : 's'
    } could not be added:</strong><ul>${failed
      .map((f) => `<li>Line ${f.line}: ${escapeHtml(f.address.slice(0, 70))} — ${escapeHtml(f.reason)}</li>`)
      .join('')}</ul></div>`;
  }
  if (plan.rejected.length > 0) {
    detail += `<div class="bad"><strong>${plan.rejected.length} ${
      plan.rejected.length === 1 ? 'row was' : 'rows were'
    } unusable:</strong><ul>${plan.rejected
      .map((r) => `<li>Line ${r.line}: ${escapeHtml(r.reason)}</li>`)
      .join('')}</ul></div>`;
  }
  if (skipped.length > 0) {
    detail += `<div><strong>${skipped.length}</strong> already in the table, skipped.</div>`;
  }
  el('import-detail').innerHTML = detail || '<div>Every row imported cleanly.</div>';
}

void boot();
