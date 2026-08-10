import type { Candidate } from '../types';
import { blankCandidate } from './store';

/**
 * CSV import for candidate addresses.
 *
 * The format we care most about is the "Download All" export from Redfin and
 * Zillow, because that is what a real search produces. Those files split the
 * address across ADDRESS / CITY / STATE / ZIP columns and — crucially — already
 * carry LATITUDE and LONGITUDE, so a 200-row export imports instantly instead of
 * spending four minutes at the geocoder.
 *
 * Anything else with a recognisable address column works too; it just has to be
 * geocoded a row at a time.
 */

export interface ParsedRow {
  /** Full single-line address, assembled from whatever columns existed. */
  address: string;
  lat: number | null;
  lon: number | null;
  label: string;
  price: number | null;
  notes: string;
  /** 1-based line number in the source file, for error reporting. */
  line: number;
}

export interface CsvPlan {
  rows: ParsedRow[];
  needGeocoding: number;
  /** Rows we could not use at all, with the reason. */
  rejected: Array<{ line: number; reason: string }>;
  headers: string[];
  matched: Record<string, string | null>;
}

export class CsvError extends Error {}

/**
 * RFC 4180-ish parser. Written out rather than split(',') because listing
 * exports routinely contain quoted commas ("San Jose, CA") and embedded
 * newlines in remarks fields, both of which a naive split silently mangles.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM; Excel adds one and it corrupts the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function sniffDelimiter(firstLine: string): string {
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header aliases, in priority order. First match wins. */
const COLUMNS: Record<string, string[]> = {
  address: ['address', 'streetaddress', 'fulladdress', 'propertyaddress', 'addr', 'street', 'siteaddress', 'location'],
  city: ['city', 'town', 'municipality'],
  state: ['stateorprovince', 'state', 'st'],
  zip: ['ziporpostalcode', 'zipcode', 'zip', 'postalcode'],
  lat: ['latitude', 'lat', 'y'],
  lon: ['longitude', 'lon', 'lng', 'long', 'x'],
  label: ['label', 'nickname', 'name', 'title', 'mls', 'mlsnumber'],
  price: ['price', 'listprice', 'askingprice', 'asking', 'saleprice', 'lastsoldprice'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'description'],
  beds: ['beds', 'bedrooms'],
  baths: ['baths', 'bathrooms'],
  sqft: ['squarefeet', 'sqft', 'livingarea'],
  url: ['url', 'link', 'listingurl'],
};

function matchColumns(headers: string[]): Record<string, number | undefined> {
  const normalized = headers.map(normalize);
  const found: Record<string, number | undefined> = {};

  for (const [key, aliases] of Object.entries(COLUMNS)) {
    for (const alias of aliases) {
      // Exact match first, so a "LOCATION" column never beats a real "ADDRESS".
      const exact = normalized.indexOf(alias);
      if (exact !== -1) {
        found[key] = exact;
        break;
      }
    }
  }
  return found;
}

function toNumber(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read a CSV into rows ready to plot. Nothing is geocoded here — this is the
 * cheap pass that tells the caller how much work importing will actually be.
 */
export function planCsvImport(text: string): CsvPlan {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const table = parseDelimited(text, sniffDelimiter(firstLine));
  if (table.length < 2) {
    throw new CsvError('That file has no data rows — expected a header row plus at least one address.');
  }

  const headers = table[0].map((h) => h.trim());
  const col = matchColumns(headers);

  const hasCoords = col.lat !== undefined && col.lon !== undefined;
  if (col.address === undefined && !hasCoords) {
    throw new CsvError(
      `No address column found. Expected one of: address, street address, property address — ` +
        `or latitude and longitude columns. Found: ${headers.join(', ')}`,
    );
  }

  const rows: ParsedRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];

  for (let r = 1; r < table.length; r += 1) {
    const cells = table[r];
    const line = r + 1;
    const at = (key: string) => {
      const index = col[key];
      return index === undefined ? undefined : cells[index]?.trim();
    };

    const lat = toNumber(at('lat'));
    const lon = toNumber(at('lon'));
    const hasValidCoords =
      lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

    // Listing exports split the address across columns; rejoin them so the
    // geocoder gets something it can actually resolve.
    const street = at('address') ?? '';
    const parts = [street, at('city'), at('state'), at('zip')].filter((p) => p && p.trim() !== '');
    let address = parts.join(', ');

    if (!address && !hasValidCoords) {
      rejected.push({ line, reason: 'no address and no usable coordinates' });
      continue;
    }
    if (!address) address = `Pin at ${lat!.toFixed(5)}, ${lon!.toFixed(5)}`;

    // Keep the listing details that would otherwise be thrown away.
    const detail = [
      at('beds') ? `${at('beds')} bd` : null,
      at('baths') ? `${at('baths')} ba` : null,
      at('sqft') ? `${at('sqft')} sqft` : null,
      at('url') || null,
    ].filter(Boolean);
    const notes = at('notes') || detail.join(' · ');

    rows.push({
      address,
      lat: hasValidCoords ? lat : null,
      lon: hasValidCoords ? lon : null,
      label: at('label') ?? '',
      price: toNumber(at('price')),
      notes,
      line,
    });
  }

  if (rows.length === 0) {
    throw new CsvError('No usable rows — every row was missing both an address and coordinates.');
  }

  const matched: Record<string, string | null> = {};
  for (const key of Object.keys(COLUMNS)) {
    const index = col[key];
    matched[key] = index === undefined ? null : headers[index];
  }

  return {
    rows,
    needGeocoding: rows.filter((row) => row.lat === null).length,
    rejected,
    headers,
    matched,
  };
}

export function candidateFromRow(row: ParsedRow, lat: number, lon: number, address?: string): Candidate {
  const candidate = blankCandidate(address ?? row.address, lat, lon);
  candidate.label = row.label;
  candidate.price = row.price;
  candidate.notes = row.notes;
  return candidate;
}

/** Normalised key used to avoid importing the same address twice. */
export function dedupeKey(address: string, lat: number, lon: number): string {
  const cleaned = address.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || `${lat.toFixed(5)},${lon.toFixed(5)}`;
}
