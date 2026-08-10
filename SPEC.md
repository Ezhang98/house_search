# House Search Map — Specification

**Status:** Draft v0.1 — for review, not yet implemented
**Repo:** https://github.com/Ezhang98/house_search
**Deploy target:** GitHub Pages (static)

---

## 1. What it is

A public, static web app where a visitor types a **work address** in California and gets an
interactive map showing:

- a **drive-time zone** around that workplace (default 30 minutes, adjustable)
- toggleable **hazard overlays** — flood, wildfire, seismic, liquefaction, landslide
- toggleable **nuisance/infrastructure overlays** — airports, freeways, rail, industrial land,
  mines, regulated facilities, data centers
- **candidate home addresses** the user plots on the map
- a **table** below the map scoring each candidate address against every layer
- **import/export** of the entire session (map state + address table)

No accounts, no backend, no database. State lives in the browser.

---

## 2. Decisions made

| Decision | Choice | Consequence |
|---|---|---|
| Coverage | **California only** | Full layer richness statewide; out-of-state work addresses are rejected with a clear message. |
| Routing key strategy | **Keyless public Valhalla** | No signup for anyone; but free-flow speeds only, and we depend on a third-party demo server. |
| Data model | **Prebaked by GitHub Actions** | Fast page, no live GIS dependencies — *except* the isochrone (see §3). |
| Stack | **Vite + TypeScript + MapLibre GL** | Modular, typed, handles heavy polygon layers; built and deployed by Actions. |

---

## 3. Architecture

### 3.1 The static-hosting constraint

GitHub Pages serves files. There is no server, so there is no place for a scraper to run at
request time. "Scraping" therefore moves to **build time**: a scheduled GitHub Action fetches
from public government GIS services, processes with GDAL/Python, tiles with Tippecanoe, and
publishes the result as part of the site.

The browser then loads static tiles. No API keys, no CORS negotiation, no upstream outages
affecting visitors.

### 3.2 The one runtime dependency

The drive-time isochrone **cannot** be prebaked, because it depends on an address the user
supplies. It is the sole live network call:

- **Endpoint:** FOSSGIS public Valhalla — `https://valhalla1.openstreetmap.de/isochrone`
- **Profile:** `auto`, free-flow speeds (no traffic model available keylessly)
- **Contours:** requested minutes, polygons mode
- **Caching:** result cached in `localStorage` keyed by
  `(lat rounded to 4dp, lon rounded to 4dp, minutes, traffic factor)`. Re-runs are free.
- **Rate discipline:** max 1 request/sec, debounced 600 ms on input, hard cap per session.
- **Failure mode:** if the service is unreachable or rate-limits us, fall back to a
  straight-line radius estimate at 30 mph average, rendered with a dashed border and an
  explicit "estimated — routing service unavailable" banner. Never silently degrade.
- **Escape hatch:** a settings field accepts a custom Valhalla/ORS endpoint + key, for anyone
  who wants traffic-aware results or self-hosting.

### 3.3 Traffic factor

Free-flow isochrones are optimistic. The UI exposes a **traffic factor** slider
(1.0 = free-flow, default **1.35**, up to 2.0) applied as `requested_minutes / factor` before
the API call. The map legend always states the factor and that the result is an estimate, not
a measured commute.

### 3.4 Build pipeline

```
.github/workflows/build-data.yml   # scheduled + manual; fetch → process → tile → cache
.github/workflows/deploy.yml       # build app, combine with data, deploy-pages artifact
```

- Data is **not committed to the repo**. It is produced during the workflow and uploaded via
  `actions/upload-pages-artifact` → `actions/deploy-pages`. This avoids permanently bloating
  git history with binary tiles.
- Heavy fetch/tile steps are cached with `actions/cache`, keyed by layer name + source
  vintage, so a normal app deploy does not re-download hundreds of megabytes.
- Layers refresh on independent schedules (§4). A nightly job rebuilds only what is stale.
- Every layer emits a sidecar `<layer>.meta.json` with `{source_url, fetched_at,
  source_vintage, feature_count, license}`. The UI reads these for attribution and
  "data as of" stamps. **No layer ships without provenance metadata.**

### 3.5 Size budget

Hard limits: 100 MB per file (GitHub), 1 GB per Pages site, 100 GB/month soft bandwidth.

Target total: **under 400 MB**. PMTiles are served via HTTP range requests, so only the
viewed tiles transfer — page weight stays small even when the archive is large. Sizes below
are estimates to be confirmed in the Milestone 0 spike; any layer exceeding its budget gets
more aggressive simplification or a lower max zoom before anything else is cut.

---

## 4. Data layers

All sources are public, free, and California-complete unless noted.

### 4.1 Hazards

| Layer | Source | Refresh | Est. size | Notes |
|---|---|---|---|---|
| Flood — Special Flood Hazard Area | FEMA NFHL MapServer, layer 28 | Monthly | 40–80 MB | Largest layer. Keep only zone code + subtype; drop all other attributes. |
| Wildfire — Fire Hazard Severity Zone | CAL FIRE `fhsz24_5` FeatureServer | Quarterly | 10–25 MB | SRA + LRA; classes Moderate/High/Very High. |
| Active fire perimeters | NIFC / WFIGS | **6-hourly** | <1 MB | Live-ish; the only fast-moving layer. |
| Liquefaction zones | CGS `CGS_Liquefaction_Zones` | Yearly | 5–15 MB | Mapped quadrangles only — coverage gaps are real. |
| Alquist-Priolo fault zones + traces | CGS | Yearly | <5 MB | |
| Earthquake-induced landslide zones | CGS `CGS_Landslide_Zones` | Yearly | 5–15 MB | |
| Quaternary faults | USGS | Yearly | <5 MB | Statewide; complements A-P zones outside mapped quads. |
| Sea level rise / storm surge | NOAA Office for Coastal Management | Yearly | 10–20 MB | Coastal counties only. |
| FEMA National Risk Index | FEMA NRI, census-tract level | Yearly | <10 MB | ~9,100 CA tracts × ~18 hazard ratings. Backbone of the table. |

### 4.2 Infrastructure & industrial

| Layer | Source | Refresh | Est. size | Notes |
|---|---|---|---|---|
| Freeways / major roads | OSM (Geofabrik `california-latest`) | Weekly | 10–20 MB | `motorway`/`trunk` + buffers (1000 ft / 500 ft, per existing `config.py`). |
| Rail corridors | OSM `railway=rail\|light_rail`, minus service | Weekly | 5–10 MB | 0.25 mi buffer. |
| Airports + runway buffers | FAA / NTAD, OSM `aeroway` | Yearly | <5 MB | Buffer rings as a noise proxy; see §9 on true noise contours. |
| Industrial land use | OSM `landuse=industrial` | Weekly | 5–15 MB | Best available substitute — **no national or state zoning dataset exists.** |
| Mines | USGS MRDS + USMIN | Yearly | <5 MB | Point features, includes historic/inactive — flagged by status. |
| Regulated facilities | EPA FRS / TRI / ECHO | Monthly | <10 MB | Points; TRI adds release-volume attributes. |
| Power substations | OSM `power=substation` | Weekly | <5 MB | Proxy for heavy electrical infrastructure. |
| **Data centers** | OSM `telecom=data_center` + curated `data/datacenters.csv` | Weekly | <1 MB | **Weakest layer — see §9.** |

### 4.3 Basemap

CARTO Positron vector tiles (keyless, gray canvas so overlays read clearly), with
`tile.openstreetmap.org` raster as a fallback. Both are third-party and usage-policy bound;
if either becomes a problem, the fallback is a self-built Protomaps PMTiles extract of
California at reduced zoom.

---

## 5. Application

### 5.1 Modules

```
src/
  main.ts                 app bootstrap
  map/
    mapInit.ts            MapLibre setup, basemap, controls
    layers.ts             layer registry: id, source, style, legend, metadata
    isochrone.ts          Valhalla call, cache, fallback, traffic factor
  geo/
    geocode.ts            Census Geocoder → Nominatim fallback; CA bounds guard
    hitTest.ts            Turf point-in-polygon + nearest-feature distance
  state/
    store.ts              single serializable app state object
    persist.ts            localStorage read/write, schema migration
    portfolio.ts          import / export
  ui/
    AddressPanel.ts       work address, radius, traffic factor
    LayerPanel.ts         toggles, opacity, legend, "data as of" stamps
    ResultsTable.ts       sortable table, per-column filters
    Disclaimer.ts         persistent legal notice
data/                     build-time pipeline (Python + GDAL + Tippecanoe)
```

### 5.2 Geocoding

US Census Geocoder (free, keyless, US-only, returns match confidence) with Nominatim as
fallback for addresses Census can't resolve. Both are third-party: **the UI must state that
typed addresses are sent to an external geocoding service.** Results cached in
`localStorage`; a manual "drop pin instead" mode exists for addresses that won't geocode.

Any work address resolving outside California bounds is rejected with an explicit
out-of-scope message, not a silent failure.

### 5.3 Hit-testing

Candidate addresses are scored client-side with Turf.js:

- **Polygon layers** → point-in-polygon, returns the zone classification
- **Point/line layers** → nearest-feature distance in miles (more useful than a boolean —
  "0.3 mi from a freeway" beats "yes")
- **Tract layers (NRI)** → containing tract → rating lookup

Every result carries one of three states: **hit**, **no hit**, or **no data here**. The third
is not the same as "safe" and must never render as a clean cell. Layers with known coverage
gaps (liquefaction, landslide) will produce this state frequently.

---

## 6. Results table

One row per candidate address. Columns:

| Group | Columns |
|---|---|
| Identity | Address, label/nickname, lat/lon, geocode confidence |
| Commute | Drive time (min), within zone (Y/N) |
| Hazard zones | Flood zone, Fire severity, Liquefaction, Fault zone, Landslide, Sea level rise |
| NRI ratings | Composite risk, plus per-hazard ratings (flood, wildfire, earthquake, heat, landslide) |
| Proximity (mi) | Nearest airport, freeway, rail, industrial, mine, EPA facility, data center |
| User | Notes, price, status |

Sortable by any column, filterable, CSV-exportable. Clicking a row flies the map to the point.

---

## 7. Import / export

**Portfolio JSON** — the full session, round-trippable:

```jsonc
{
  "schema": "house-search/v1",
  "exportedAt": "2026-08-10T18:00:00Z",
  "work": { "address": "...", "lat": 0, "lon": 0, "minutes": 30, "trafficFactor": 1.35 },
  "view": { "center": [0, 0], "zoom": 11 },
  "layers": { "flood": { "visible": true, "opacity": 0.6 } },
  "addresses": [
    { "id": "a1", "address": "...", "lat": 0, "lon": 0, "label": "", "notes": "", "price": null }
  ]
}
```

- **Import:** file picker + drag-and-drop. Unknown schema versions are migrated or rejected
  with a clear message — never partially loaded.
- **Hazard results are recomputed on import, not restored from the file.** Data vintages
  change; a stale cached verdict is worse than no verdict.
- **Also export:** CSV (table only) and GeoJSON (points + current isochrone, for QGIS).
- **Shareable URL:** compressed state in the fragment. Degrades gracefully — if the address
  list is too long for URL limits, the link carries work address + settings only and says so.

---

## 8. Non-goals for v1

- Anything outside California
- Listing/price data, MLS integration, or scraping real estate sites (CORS + ToS blocked)
- Transit, walking, or cycling isochrones
- Multi-workplace or two-earner commute intersection *(strong v2 candidate)*
- Accounts, sync, or server-side persistence
- Mobile-optimized layout beyond basic responsiveness

---

## 9. Known limitations — to state in the UI, not bury

1. **Drive times are free-flow estimates**, adjusted by a blunt multiplier. They are not
   measured commutes and do not model time of day, day of week, or incidents.
2. **Data centers are poorly mapped.** No authoritative public dataset exists. OSM tagging is
   sparse and inconsistent; the curated CSV is manual and will be incomplete. This layer must
   be labeled "incomplete — known gaps" in the legend.
3. **Zoning is not available.** `landuse=industrial` from OSM is a crowd-sourced proxy for
   actual municipal zoning, which is not published as any statewide dataset.
4. **Coverage gaps in state hazard mapping.** CGS liquefaction and landslide zones exist only
   for mapped quadrangles — largely urban areas. Absence of a zone is not evidence of safety.
5. **Airport noise is approximated by runway buffers**, not modeled contours. FAA's national
   noise map exists but is raster and heavier; a v2 candidate.
6. **This is not a flood determination, insurance quote, or property disclosure.** A
   persistent, non-dismissible disclaimer says so, with per-layer source and vintage.
7. **Data freshness spans orders of magnitude** — fire perimeters refresh every 6 hours,
   FEMA flood maps change over years. Every layer displays its own "as of" date.

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| FOSSGIS Valhalla rate-limits, blocks, or disappears | Medium | Aggressive caching, 1 req/s cap, radius fallback, custom-endpoint field |
| CARTO/OSM basemap usage policy issue | Low | Self-hosted Protomaps CA extract as fallback |
| FEMA NFHL statewide exceeds size budget | Medium | Zoom-dependent simplification, attribute stripping, split by region |
| Build workflow exceeds Actions time limits | Medium | Per-layer caching; layers rebuild independently, not as one monolith |
| Upstream schema/endpoint change breaks a layer | Medium | Build fails loudly on empty/malformed results; last-good tiles retained |
| Someone relies on this for a real purchase decision | **High** | Disclaimers, provenance on every layer, honest "no data" states |

---

## 11. Open questions

1. **Repo layout** — archive the existing `commute-drivetime-map.html` under `legacy/`, or
   drop it? It's a hand-calibrated Bay Area artifact and cannot be generalized.
2. **`private/`** — currently gitignored, containing the requirements profile, avoidance
   sites, and Python scripts. Recommend it stays out of the repo permanently; anything on the
   Pages branch is world-readable. Is `avoidance_sites.csv` worth generalizing into the
   curated data-center/nuisance layer?
3. **Default map view** before a work address is entered — statewide California, or
   geolocate?
4. **Multi-workplace intersection** — confirmed v2, or wanted in v1?
5. **Price layer** — the existing artifact has a Redfin ZCTA choropleth. Carry it forward? It
   would need a licensed or manually refreshed source.

---

## 12. Milestones

| # | Deliverable |
|---|---|
| 0 | **Spike:** confirm Valhalla isochrone response, FEMA NFHL statewide extract size, and PMTiles-over-Pages range requests. Resolves the biggest unknowns before committing to the design. |
| 1 | Vite + TS + MapLibre skeleton on Pages; basemap, pan/zoom, geocode + pin |
| 2 | Live isochrone with caching, traffic factor, and fallback |
| 3 | Data pipeline: 3 layers end-to-end (flood, fire, freeways) |
| 4 | Remaining layers + layer panel with legends and provenance stamps |
| 5 | Address table with hit-testing and three-state results |
| 6 | Import/export/CSV/GeoJSON + share URL |
| 7 | Disclaimers, empty states, error states, mobile pass |
