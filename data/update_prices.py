#!/usr/bin/env python3
"""
Refresh the California ZIP-level sold-price dataset.

Source: Redfin Data Center, "zip_code_market_tracker" (public, free, attribution
required). https://www.redfin.com/news/data-center/

The upstream file is ~1.5 GB gzipped and covers every ZIP in the country for
every property type and period duration. We stream-decompress it and keep only
what we need, so nothing that large ever lands on disk:

  - STATE_CODE == CA
  - PROPERTY_TYPE == "Single Family Residential"
  - the most recent N months present in the file (default 12)

Redfin buckets each ZIP into rolling periods. At ZIP level the file is dominated
by 90-day buckets -- individual ZIPs sell too few houses a month for a monthly
median to mean much -- so we prefer 30-day periods where they exist and fall
back to 90-day. Because the 90-day buckets roll forward monthly they overlap, so
we deliberately pick only every third one; otherwise the same sale would be
counted three times.

Per ZIP we then compute a homes-sold-weighted trailing-12-month average of the
period medians. That is *not* a true 12-month median -- it is an average of
medians, weighted by sale volume so that a 2-sale period does not swing a ZIP as
hard as a 40-sale one. It is the right shape for "what do houses go for around
here" and the wrong tool for appraising a specific property.

Usage:
    python data/update_prices.py
    python data/update_prices.py --months 24 --out public/data/ca_zip_prices.csv

Run time is dominated by the download: expect 5-20 minutes on a home
connection. Use --local FILE to re-run the aggregation against an already
downloaded copy.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

SOURCE_URL = (
    "https://redfin-public-data.s3.us-west-2.amazonaws.com"
    "/redfin_market_tracker/zip_code_market_tracker.tsv000.gz"
)

# Columns we care about, by header name (we resolve indices from the header row
# rather than hardcoding positions -- Redfin has added columns before).
NEEDED = [
    "PERIOD_BEGIN",
    "PERIOD_END",
    "PERIOD_DURATION",
    "REGION",
    "CITY",
    "STATE_CODE",
    "PROPERTY_TYPE",
    "MEDIAN_SALE_PRICE",
    "MEDIAN_PPSF",
    "HOMES_SOLD",
]

PROPERTY_TYPE = "Single Family Residential"
STATE_CODE = "CA"
# Preference order. 30-day buckets are cleaner if present; 90-day is what the
# ZIP-level file actually ships in bulk.
ACCEPTED_DURATIONS = ("30", "90")


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1]
    return value


def zip_from_region(region: str) -> str | None:
    """Redfin encodes the region as 'Zip Code: 94087'."""
    if ":" not in region:
        return None
    candidate = region.split(":", 1)[1].strip()
    return candidate if len(candidate) == 5 and candidate.isdigit() else None


def to_float(value: str) -> float | None:
    value = unquote(value)
    if value in ("", "NA", "-", "null"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def open_source(local: str | None):
    """Yield decoded text lines from either a local .gz or the live URL."""
    if local:
        raw = open(local, "rb")
    else:
        request = urllib.request.Request(
            SOURCE_URL,
            headers={"User-Agent": "house-search-map/1.0 (data refresh script)"},
        )
        raw = urllib.request.urlopen(request, timeout=120)
    stream = gzip.GzipFile(fileobj=raw)
    return io.TextIOWrapper(stream, encoding="utf-8", errors="replace")


def collect(local: str | None, months: int, verbose: bool = True):
    """Stream the source and return (rows_by_zip, meta)."""
    rows: dict[str, list[dict]] = defaultdict(list)
    meta = {"scanned": 0, "kept": 0, "last_updated": None}

    with open_source(local) as handle:
        header = [unquote(h) for h in handle.readline().rstrip("\n").split("\t")]
        try:
            idx = {name: header.index(name) for name in NEEDED}
        except ValueError as exc:
            raise SystemExit(
                f"Redfin schema changed -- missing expected column: {exc}\n"
                f"Header was: {header}"
            )
        last_updated_idx = header.index("LAST_UPDATED") if "LAST_UPDATED" in header else None

        for line in handle:
            meta["scanned"] += 1
            if verbose and meta["scanned"] % 2_000_000 == 0:
                print(
                    f"  scanned {meta['scanned']:,} rows, kept {meta['kept']:,}",
                    file=sys.stderr,
                    flush=True,
                )

            # Cheap pre-filter before paying for the full split.
            if '"CA"' not in line or PROPERTY_TYPE not in line:
                continue

            fields = line.rstrip("\n").split("\t")
            if len(fields) <= idx["HOMES_SOLD"]:
                continue
            if unquote(fields[idx["STATE_CODE"]]) != STATE_CODE:
                continue
            if unquote(fields[idx["PROPERTY_TYPE"]]) != PROPERTY_TYPE:
                continue
            duration = unquote(fields[idx["PERIOD_DURATION"]])
            if duration not in ACCEPTED_DURATIONS:
                continue

            zip_code = zip_from_region(unquote(fields[idx["REGION"]]))
            if not zip_code:
                continue

            price = to_float(fields[idx["MEDIAN_SALE_PRICE"]])
            sold = to_float(fields[idx["HOMES_SOLD"]])
            if price is None or not sold:
                continue

            rows[zip_code].append(
                {
                    "period_end": unquote(fields[idx["PERIOD_END"]]),
                    "duration": duration,
                    "city": unquote(fields[idx["CITY"]]),
                    "price": price,
                    "ppsf": to_float(fields[idx["MEDIAN_PPSF"]]),
                    "sold": sold,
                }
            )
            meta["kept"] += 1
            if last_updated_idx is not None and meta["last_updated"] is None:
                meta["last_updated"] = unquote(fields[last_updated_idx])

    return rows, meta


def pick_duration(rows: dict[str, list[dict]]) -> str:
    """Prefer 30-day buckets, but only if they actually cover the state."""
    coverage = {
        duration: len({z for z, entries in rows.items() if any(e["duration"] == duration for e in entries)})
        for duration in ACCEPTED_DURATIONS
    }
    for duration in ACCEPTED_DURATIONS:
        if coverage.get(duration, 0) >= 500:
            return duration
    best = max(coverage, key=lambda d: coverage[d])
    if coverage[best] == 0:
        raise SystemExit("No CA single-family rows found -- upstream format may have changed.")
    return best


def aggregate(rows: dict[str, list[dict]], months: int):
    """Homes-sold-weighted average of period medians over the newest `months`."""
    duration = pick_duration(rows)
    stride = max(1, int(duration) // 30)   # 90-day buckets roll monthly -> take every 3rd

    # The window is defined globally, not per ZIP, so every ZIP is compared over
    # the same calendar span. A ZIP with no sales in the window drops out rather
    # than silently reporting a stale figure from two years ago.
    all_periods = sorted(
        {row["period_end"] for entries in rows.values() for row in entries if row["duration"] == duration}
    )
    if not all_periods:
        raise SystemExit("No CA single-family rows found -- upstream format may have changed.")

    # Walk backwards from the newest period in `stride` steps so the selected
    # buckets tile the window instead of overlapping.
    bucket_count = max(1, months // stride)
    selected = all_periods[::-1][::stride][:bucket_count]
    window = set(selected)
    rows = {
        z: [e for e in entries if e["duration"] == duration]
        for z, entries in rows.items()
    }

    out = []
    for zip_code, entries in rows.items():
        recent = [e for e in entries if e["period_end"] in window]
        if not recent:
            continue
        weight = sum(e["sold"] for e in recent)
        if weight <= 0:
            continue

        price = sum(e["price"] * e["sold"] for e in recent) / weight
        ppsf_entries = [e for e in recent if e["ppsf"] is not None]
        ppsf_weight = sum(e["sold"] for e in ppsf_entries)
        ppsf = (
            sum(e["ppsf"] * e["sold"] for e in ppsf_entries) / ppsf_weight
            if ppsf_weight > 0
            else None
        )

        city = next((e["city"] for e in sorted(recent, key=lambda e: e["period_end"], reverse=True) if e["city"]), "")

        out.append(
            {
                "zip": zip_code,
                "city": city,
                "median_sale_price": round(price),
                "median_ppsf": round(ppsf, 1) if ppsf is not None else "",
                "homes_sold": int(round(weight)),
                "periods": len(recent),
            }
        )

    out.sort(key=lambda r: r["zip"])
    return out, sorted(window), duration


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--months", type=int, default=12, help="trailing window length (default 12)")
    parser.add_argument("--out", default="public/data/ca_zip_prices.csv")
    parser.add_argument("--local", help="path to an already-downloaded .tsv000.gz")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    verbose = not args.quiet
    if verbose:
        print(f"Streaming {SOURCE_URL if not args.local else args.local} ...", file=sys.stderr)

    rows, meta = collect(args.local, args.months, verbose)
    records, window, duration = aggregate(rows, args.months)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["zip", "city", "median_sale_price", "median_ppsf", "homes_sold", "periods"],
        )
        writer.writeheader()
        writer.writerows(records)

    manifest = {
        "source": "Redfin Data Center - zip_code_market_tracker",
        "source_url": SOURCE_URL,
        "attribution": "Data provided by Redfin, a national real estate brokerage.",
        "license_note": "Free to use with attribution to Redfin. See redfin.com/news/data-center/",
        "property_type": PROPERTY_TYPE,
        "metric": (
            f"Homes-sold-weighted average of {duration}-day median sale prices over the "
            f"trailing {args.months} months"
        ),
        "period_duration_days": int(duration),
        "periods_used": len(window),
        "period_start": window[0] if window else None,
        "period_end": window[-1] if window else None,
        "upstream_last_updated": meta["last_updated"],
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "zip_count": len(records),
        "rows_scanned": meta["scanned"],
    }
    manifest_path = os.path.splitext(args.out)[0] + ".meta.json"
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    print(
        f"Wrote {len(records):,} CA ZIPs to {args.out} "
        f"(periods {window[0]} .. {window[-1]})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
