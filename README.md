# California House Search

An interactive map for house hunting in California. Enter the workplaces you
need to commute to, see the drive-time zone they share, overlay published flood,
fire, seismic and industrial hazard data, and score candidate addresses against
all of it in one table.

**Live site:** https://ezhang98.github.io/house_search/

---

## What it does

- **Multiple workplaces.** Add one per commute that matters, each with its own
  time limit. The map shows where *all* of them are reachable — or any of them,
  if you switch the combine mode.
- **Hazard overlays.** FEMA flood zones, CAL FIRE hazard severity, CGS
  liquefaction, landslide and Alquist-Priolo fault zones, tsunami hazard areas.
- **Infrastructure and industry.** Freeways, rail, airports, industrial land,
  mines and quarries, data centers, electrical substations — each reported as a
  distance, because "0.2 mi from a freeway" tells you more than "yes".
- **Scored address table.** Every address is checked against every switched-on
  filter. Rows are green with no flags, yellow at one or two, red at three or
  more. Turning a filter off removes it from the map, the table, and the count.
- **Sold prices.** A second tab shows a ZIP-level choropleth of recent
  single-family sale prices, and every address picks up its surrounding ZIP's
  figure.
- **Import / export.** The whole session round-trips as JSON; the table also
  exports to CSV and the points to GeoJSON.

## What it is not

It is a screening tool. It is not a flood determination, an insurance quote, a
geotechnical report, or a property disclosure. A "clear" result frequently means
*this area was never mapped* — the table says "no data" when that is the case,
and you should read that as a gap, not as reassurance.

---

## How it works

GitHub Pages serves static files and nothing else, so there is no backend and
nothing is scraped at request time.

**Build time.** `data/build_layers.py` pulls each layer from the publishing
agency's ArcGIS REST service or from OpenStreetMap, normalises the fields down
to a single class string, simplifies the geometry for drawing, and writes
GeoJSON into `public/data/` along with a manifest recording the source, the
fetch date and the feature count. Those files are committed.

**Run time.** The browser loads layers lazily as you switch them on. Three
things do go over the network while you use the site:

| What | Where | Why it cannot be prebaked |
| --- | --- | --- |
| Geocoding | US Census, falling back to Nominatim | You type the address |
| Drive-time zone | Valhalla (FOSSGIS public instance) | Depends on your workplace |
| Per-address hazard check | FEMA / CAL FIRE / CGS | See below |

That last one matters. The prebaked polygons are simplified to keep the page
fast, and at parcel scale a simplified edge can be tens of metres off — the
difference between needing flood insurance and not. So the **map is drawn from
local data and the table's answers come from the authoritative service**, queried
for that exact coordinate. If the service is unreachable the app falls back to
the local copy and says so in the cell tooltip.

### Drive times

The public Valhalla instance routes at free-flow speeds; it has no traffic
model. A 30-minute zone built that way would be optimistic, so the requested
time is divided by a traffic allowance (1.35× by default, adjustable) before
being sent. The zone is therefore deliberately conservative.

Per-row minutes in the table are a **pessimistic estimate**, not a routed time:
straight-line distance inflated by a detour factor and divided by an average
speed that rises with trip length. Routing every row against every workplace
would mean hammering a shared community server on every edit. Zone membership —
the ✓/✕ column — does come from the real isochrone.

If routing is unavailable entirely, the zone degrades to a plain radius, drawn
with a dashed border and labelled as an estimate rather than passed off as a
drive-time zone.

---

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
```

Deployment is automatic: pushing to `main` runs `.github/workflows/deploy.yml`,
which builds and publishes to Pages.

```
data/          Python build pipeline (stdlib only, no dependencies)
  sources.py     declarative layer registry — add datasets here
  build_layers.py
  update_prices.py
public/data/   generated GeoJSON, the price CSV, and manifest.json
src/
  config/        colours, thresholds, endpoints
  geo/           geocoding, isochrones, hit-testing, scoring
  map/           MapLibre setup, layer registry, price join
  state/         store, persistence, import/export
  ui/            results table
legacy/        the original hand-calibrated Bay Area SVG map, kept for reference
```

Refreshing the datasets is documented separately in `data/UPDATING.md`.

---

## Data sources

| Layer | Source |
| --- | --- |
| Flood hazard | FEMA National Flood Hazard Layer |
| Fire hazard severity | CAL FIRE FHSZ (2024/25) |
| Liquefaction, landslide, Alquist-Priolo | California Geological Survey |
| Tsunami hazard areas | CGS / Cal OES |
| Roads, rail, industrial, mines, data centers, substations, airports | OpenStreetMap (ODbL) |
| ZIP boundaries | US Census Bureau TIGERweb (2020 ZCTAs) |
| Sold prices | Redfin Data Center |
| Routing | Valhalla, FOSSGIS public instance |
| Basemap | CARTO Positron |

Redfin data is used under their public data-center terms, which require
attribution; it is credited in the prices panel. OpenStreetMap data is ODbL.

### Known gaps

- **Data centers are barely mapped.** OpenStreetMap has ~114 in the entire
  state and no authoritative public dataset exists. Substations are included as
  a rough proxy for the infrastructure that clusters around them.
- **There is no statewide zoning dataset.** OSM `landuse=industrial` stands in
  for it and will disagree with official zoning in places.
- **CGS seismic zones only exist for mapped quadrangles**, largely urban. Those
  gaps are reported as "no data".
- **Airport proximity is distance to the aerodrome boundary**, not a modelled
  noise contour. A house well outside the boundary can still sit under an
  approach path.
