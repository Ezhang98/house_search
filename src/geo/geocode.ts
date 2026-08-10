import { CA_BOUNDS, CENSUS_ENDPOINT, NOMINATIM_ENDPOINT } from '../config/constants';

export interface GeocodeResult {
  address: string;
  lat: number;
  lon: number;
  source: 'census' | 'nominatim';
  /** Set when the result is outside California, so callers can refuse it. */
  outOfState: boolean;
}

export class GeocodeError extends Error {}

function inCalifornia(lat: number, lon: number): boolean {
  const [west, south, east, north] = CA_BOUNDS;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

/**
 * The Census geocoder gives much better US street-address matches than
 * Nominatim, but it does not send an Access-Control-Allow-Origin header, so a
 * normal fetch from the browser is blocked. It does support a JSONP callback,
 * which is the documented way to use it from client-side code.
 */
function censusJsonp(address: string, timeoutMs = 8000): Promise<GeocodeResult | null> {
  return new Promise((resolve) => {
    const callbackName = `__geocode_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[callbackName];
      script.remove();
    };
    const finish = (value: GeocodeResult | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    (window as unknown as Record<string, unknown>)[callbackName] = (payload: {
      result?: { addressMatches?: Array<{ matchedAddress: string; coordinates: { x: number; y: number } }> };
    }) => {
      const match = payload?.result?.addressMatches?.[0];
      if (!match) return finish(null);
      const lat = match.coordinates.y;
      const lon = match.coordinates.x;
      finish({
        address: match.matchedAddress,
        lat,
        lon,
        source: 'census',
        outOfState: !inCalifornia(lat, lon),
      });
    };

    const params = new URLSearchParams({
      address,
      benchmark: 'Public_AR_Current',
      format: 'jsonp',
      callback: callbackName,
    });
    script.src = `${CENSUS_ENDPOINT}?${params}`;
    script.onerror = () => finish(null);
    document.head.appendChild(script);
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function nominatim(address: string): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    q: address,
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'us',
    addressdetails: '0',
  });
  const response = await fetch(`${NOMINATIM_ENDPOINT}?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const rows = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const first = rows[0];
  if (!first) return null;
  const lat = Number(first.lat);
  const lon = Number(first.lon);
  return {
    address: first.display_name,
    lat,
    lon,
    source: 'nominatim',
    outOfState: !inCalifornia(lat, lon),
  };
}

const cache = new Map<string, GeocodeResult>();

export async function geocode(address: string): Promise<GeocodeResult> {
  const key = address.trim().toLowerCase();
  if (!key) throw new GeocodeError('Enter an address first.');

  const cached = cache.get(key);
  if (cached) return cached;

  // Census first for street-level precision; Nominatim covers everything it
  // cannot match (place names, partial addresses, unusual formatting).
  let result = await censusJsonp(address);
  if (!result) result = await nominatim(address);

  if (!result) {
    throw new GeocodeError(
      `Could not find "${address}". Try adding the city and state, or drop a pin on the map instead.`,
    );
  }

  cache.set(key, result);
  return result;
}
