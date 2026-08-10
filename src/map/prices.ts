import type { FeatureCollection } from 'geojson';
import type { PriceMeta, ZipPrice } from '../types';
import { LayerIndex } from '../geo/hitTest';

export interface PriceData {
  byZip: Map<string, ZipPrice>;
  meta: PriceMeta;
  polygons: FeatureCollection;
  index: LayerIndex;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((name, i) => {
      row[name] = cells[i] ?? '';
    });
    return row;
  });
}

/**
 * Joins the Redfin price table onto Census ZCTA polygons.
 *
 * ZCTAs approximate USPS ZIP codes rather than matching them, so a handful of
 * ZIPs in the price table have no polygon and some polygons have no price.
 * Both cases are left visibly empty instead of being filled in from a neighbour.
 */
export async function loadPrices(baseUrl: string): Promise<PriceData> {
  const [csvText, metaJson, zctaJson] = await Promise.all([
    fetch(`${baseUrl}data/ca_zip_prices.csv`).then((r) => {
      if (!r.ok) throw new Error(`price data unavailable (${r.status})`);
      return r.text();
    }),
    fetch(`${baseUrl}data/ca_zip_prices.meta.json`).then((r) => r.json() as Promise<PriceMeta>),
    fetch(`${baseUrl}data/zcta.geojson`).then((r) => {
      if (!r.ok) throw new Error(`ZCTA geometry unavailable (${r.status})`);
      return r.json() as Promise<FeatureCollection>;
    }),
  ]);

  const byZip = new Map<string, ZipPrice>();
  for (const row of parseCsv(csvText)) {
    const zip = row.zip?.trim();
    if (!zip) continue;
    byZip.set(zip, {
      zip,
      medianSalePrice: Number(row.median_sale_price),
      medianPpsf: row.median_ppsf ? Number(row.median_ppsf) : null,
      homesSold: Number(row.homes_sold || 0),
    });
  }

  const polygons: FeatureCollection = {
    type: 'FeatureCollection',
    features: zctaJson.features.map((feature) => {
      const zip = String(feature.properties?.c ?? '');
      const price = byZip.get(zip);
      // `price` is omitted rather than set to null when a ZCTA has no recent
      // sales, so the map style can branch on ['has', 'price'] -- MapLibre
      // expressions cannot compare against null.
      return {
        ...feature,
        properties: price
          ? { zip, price: price.medianSalePrice, ppsf: price.medianPpsf, homesSold: price.homesSold }
          : { zip, homesSold: 0 },
      };
    }),
  };

  return { byZip, meta: metaJson, polygons, index: new LayerIndex('zcta', polygons) };
}

/** Which ZCTA contains this point, and what did homes there go for. */
export function priceAt(data: PriceData, lon: number, lat: number): ZipPrice | null {
  const feature = data.index.containing(lon, lat);
  if (!feature) return null;
  const zip = String(feature.properties?.zip ?? '');
  return data.byZip.get(zip) ?? null;
}
