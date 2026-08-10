import maplibregl, { Map as MapLibreMap, Marker, Popup } from 'maplibre-gl';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import {
  BASEMAP_STYLE,
  CA_CENTER,
  CA_ZOOM,
  DEFAULT_LAYER_COLOR,
  LAYER_COLORS,
} from '../config/constants';
import type { Candidate, Workplace } from '../types';
import { loadLayerData, type LayerDef } from './layerRegistry';

const ZONE_SOURCE = 'commute-zone';
const PRICE_SOURCE = 'zcta-price';

/** Fallback style used if the vector basemap CDN is unreachable. */
const RASTER_FALLBACK: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

function colorExpression(layerId: string): maplibregl.DataDrivenPropertyValueSpecification<string> {
  const palette = LAYER_COLORS[layerId];
  if (!palette) return DEFAULT_LAYER_COLOR;
  const match: unknown[] = ['match', ['get', 'c']];
  for (const [key, color] of Object.entries(palette)) match.push(key, color);
  match.push(DEFAULT_LAYER_COLOR);
  return match as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>;
}

export class MapView {
  readonly map: MapLibreMap;
  private markers = new Map<string, Marker>();
  private workMarkers = new Map<string, Marker>();
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private loadedLayers = new Set<string>();
  private onCandidateClick?: (id: string) => void;
  private onMapClick?: (lat: number, lon: number) => void;

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: CA_CENTER,
      zoom: CA_ZOOM,
      attributionControl: false,
    });

    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: 'Hazard data: FEMA, CAL FIRE, CGS · Prices: Redfin',
      }),
      'bottom-right',
    );
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    this.map.on('error', (event) => {
      // A failed style load leaves a blank canvas, which reads as a broken app.
      if (String(event.error?.message ?? '').includes('style')) {
        this.map.setStyle(RASTER_FALLBACK);
      }
    });

    this.map.on('load', () => {
      this.initSources();
      this.ready = true;
      this.readyWaiters.forEach((resolve) => resolve());
      this.readyWaiters = [];
    });

    this.map.on('click', (event) => {
      if (this.onMapClick) this.onMapClick(event.lngLat.lat, event.lngLat.lng);
    });
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  setCandidateClickHandler(handler: (id: string) => void): void {
    this.onCandidateClick = handler;
  }

  setMapClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onMapClick = handler;
  }

  private initSources(): void {
    this.map.addSource(ZONE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    this.map.addLayer({
      id: 'zone-fill',
      type: 'fill',
      source: ZONE_SOURCE,
      paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: 'zone-outline',
      type: 'line',
      source: ZONE_SOURCE,
      paint: { 'line-color': '#1d4ed8', 'line-width': 2 },
    });

    this.map.addSource(PRICE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    this.map.addLayer({
      id: 'price-fill',
      type: 'fill',
      source: PRICE_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'case',
          ['!', ['has', 'price']],
          '#e5e7eb',
          [
            'interpolate',
            ['linear'],
            ['get', 'price'],
            300000, '#1a9850',
            600000, '#a6d96a',
            900000, '#ffffbf',
            1400000, '#fdae61',
            2200000, '#d73027',
          ],
        ],
        'fill-opacity': 0.65,
      },
    });
    this.map.addLayer({
      id: 'price-outline',
      type: 'line',
      source: PRICE_SOURCE,
      layout: { visibility: 'none' },
      paint: { 'line-color': '#ffffff', 'line-width': 0.5, 'line-opacity': 0.6 },
    });

    this.map.on('click', 'price-fill', (event) => {
      const props = event.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!props) return;
      const price = props.price === undefined || props.price === null ? null : Number(props.price);
      new Popup({ closeButton: true })
        .setLngLat(event.lngLat)
        .setHTML(
          `<strong>ZIP ${props.zip}</strong><br>${
            price
              ? `${price.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} median<br><span class="muted">${props.homesSold} sales in window</span>`
              : 'No recent sales data'
          }`,
        )
        .addTo(this.map);
    });
  }

  async ensureLayer(def: LayerDef, baseUrl: string): Promise<void> {
    if (this.loadedLayers.has(def.id)) return;
    const data = await loadLayerData(def, baseUrl);
    await this.whenReady();
    if (this.loadedLayers.has(def.id)) return;

    const sourceId = `src-${def.id}`;
    this.map.addSource(sourceId, { type: 'geojson', data });

    if (def.geometry === 'line') {
      this.map.addLayer({
        id: `lyr-${def.id}`,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': colorExpression(def.id), 'line-width': 1.6, 'line-opacity': 0.85 },
      });
    } else if (def.geometry === 'point') {
      this.map.addLayer({
        id: `lyr-${def.id}`,
        type: 'circle',
        source: sourceId,
        paint: { 'circle-radius': 4, 'circle-color': colorExpression(def.id), 'circle-opacity': 0.85 },
      });
    } else {
      this.map.addLayer({
        id: `lyr-${def.id}`,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': colorExpression(def.id), 'fill-opacity': 0.35 },
      });
      this.map.addLayer({
        id: `lyr-${def.id}-line`,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': colorExpression(def.id), 'line-width': 0.6, 'line-opacity': 0.7 },
      });
    }

    this.loadedLayers.add(def.id);
    this.moveOverlaysToTop();
  }

  setLayerVisible(def: LayerDef, visible: boolean): void {
    for (const suffix of ['', '-line']) {
      const id = `lyr-${def.id}${suffix}`;
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  /** Keep the commute zone and markers above whatever hazard layers just loaded. */
  private moveOverlaysToTop(): void {
    for (const id of ['zone-fill', 'zone-outline']) {
      if (this.map.getLayer(id)) this.map.moveLayer(id);
    }
  }

  setZone(zone: Feature<Polygon | MultiPolygon> | null, estimated: boolean): void {
    const source = this.map.getSource(ZONE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const collection: FeatureCollection = {
      type: 'FeatureCollection',
      features: zone ? [{ ...zone, properties: { estimated } }] : [],
    };
    source.setData(collection);

    // line-dasharray is not data-driven in MapLibre, so the estimated-vs-routed
    // distinction is set on the layer rather than expressed per feature.
    if (this.map.getLayer('zone-outline')) {
      this.map.setPaintProperty('zone-outline', 'line-dasharray', estimated ? [2, 2] : [1, 0]);
    }
  }

  setPriceData(data: FeatureCollection): void {
    const source = this.map.getSource(PRICE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(data);
  }

  setPriceVisible(visible: boolean): void {
    for (const id of ['price-fill', 'price-outline']) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  syncWorkplaces(workplaces: Workplace[]): void {
    const seen = new Set<string>();
    for (const workplace of workplaces) {
      seen.add(workplace.id);
      let marker = this.workMarkers.get(workplace.id);
      if (!marker) {
        const element = document.createElement('div');
        element.className = 'marker marker-work';
        element.title = workplace.address;
        marker = new Marker({ element }).setLngLat([workplace.lon, workplace.lat]).addTo(this.map);
        this.workMarkers.set(workplace.id, marker);
      }
      marker.setLngLat([workplace.lon, workplace.lat]);
    }
    for (const [id, marker] of this.workMarkers) {
      if (!seen.has(id)) {
        marker.remove();
        this.workMarkers.delete(id);
      }
    }
  }

  syncCandidates(candidates: Candidate[], bandOf: (c: Candidate) => string): void {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      seen.add(candidate.id);
      let marker = this.markers.get(candidate.id);
      if (!marker) {
        const element = document.createElement('div');
        element.className = 'marker marker-candidate';
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          this.onCandidateClick?.(candidate.id);
        });
        marker = new Marker({ element }).setLngLat([candidate.lon, candidate.lat]).addTo(this.map);
        this.markers.set(candidate.id, marker);
      }
      marker.setLngLat([candidate.lon, candidate.lat]);
      const element = marker.getElement();
      element.className = `marker marker-candidate band-${bandOf(candidate)}`;
      element.title = candidate.label || candidate.address;
    }
    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
  }

  flyTo(lat: number, lon: number, zoom = 14): void {
    this.map.flyTo({ center: [lon, lat], zoom, duration: 900 });
  }

  fitBounds(bounds: [number, number, number, number]): void {
    this.map.fitBounds(bounds, { padding: 60, duration: 900 });
  }

  resetView(): void {
    this.map.flyTo({ center: CA_CENTER, zoom: CA_ZOOM, duration: 800 });
  }
}
