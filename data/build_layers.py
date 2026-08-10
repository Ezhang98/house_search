#!/usr/bin/env python3
"""
Prebake every map layer into static GeoJSON under public/data/.

The app is hosted on GitHub Pages, which serves files and nothing else. There is
no request-time backend, so all bulk GIS work happens here at build time and the
browser only ever loads static files.

What this does NOT do is decide hazard status for a specific address. The
geometry written here is simplified for display; asking whether one parcel sits
inside a flood zone is done live against the authoritative service (see
`point_query_url` in sources.py). Simplified polygons are fine for painting a
map and not fine for a purchase decision.

Usage:
    python data/build_layers.py                 # everything
    python data/build_layers.py --only flood    # one layer
    python data/build_layers.py --skip roads,rail
    python data/build_layers.py --list

Each layer is fetched independently. One failing source does not abort the run;
it is recorded as failed in the manifest and the front end hides it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sources import (  # noqa: E402
    ALL_SOURCE_IDS,
    ARCGIS_SOURCES,
    CA_BBOX,
    OVERPASS_SOURCES,
    ArcGisSource,
    OverpassSource,
)

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "data")
USER_AGENT = "house-search-map/1.0 (+https://github.com/Ezhang98/house_search)"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def http_post(url: str, data: bytes, timeout: int = 900) -> bytes:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def http_post_json(url: str, params: dict, timeout: int = 180, retries: int = 4) -> dict:
    """POST rather than GET.

    An objectIds list of a thousand ids is tens of kilobytes, which blows past
    the URL length ArcGIS will accept and comes back as a bare 400. ArcGIS
    accepts the same parameters form-encoded in a POST body with no such limit.
    """
    body = urllib.parse.urlencode(params, doseq=True).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                url,
                data=body,
                headers={
                    "User-Agent": USER_AGENT,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if isinstance(payload, dict) and "error" in payload:
                raise RuntimeError(f"service error: {payload['error']}")
            return payload
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            last_error = exc
            wait = 2 ** attempt
            log(f"    retry {attempt + 1}/{retries} in {wait}s ({exc})")
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last_error}")


# --------------------------------------------------------------------------
# ArcGIS
# --------------------------------------------------------------------------

def arcgis_object_ids(source: ArcGisSource) -> list[int]:
    """Fetch all matching OBJECTIDs first, then page by ID.

    Paging by resultOffset depends on `supportsPagination`, which not every
    service advertises honestly. Chunking an explicit ID list works everywhere
    and, unlike offset paging, cannot silently skip or duplicate features if the
    service reorders results between requests.
    """
    params = {"where": source.where, "returnIdsOnly": "true", "f": "json"}
    if source.use_bbox:
        params.update(
            {
                "geometry": ",".join(str(v) for v in CA_BBOX),
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
            }
        )
    payload = http_post_json(f"{source.url}/query", params)
    ids = payload.get("objectIds") or []
    return sorted(int(i) for i in ids)


def esri_to_geojson_geometry(geometry: dict, geom_kind: str) -> dict | None:
    """Minimal Esri JSON -> GeoJSON fallback for services without f=geojson."""
    if not geometry:
        return None
    if geom_kind == "point":
        if "x" not in geometry:
            return None
        return {"type": "Point", "coordinates": [geometry["x"], geometry["y"]]}
    if geom_kind == "line":
        paths = geometry.get("paths") or []
        if not paths:
            return None
        if len(paths) == 1:
            return {"type": "LineString", "coordinates": paths[0]}
        return {"type": "MultiLineString", "coordinates": paths}
    rings = geometry.get("rings") or []
    if not rings:
        return None

    # Esri packs outer and inner rings into one flat list, distinguished only by
    # winding order: clockwise is outer, counter-clockwise is a hole.
    def signed_area(ring: list) -> float:
        total = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[i + 1][0], ring[i + 1][1]
            total += (x2 - x1) * (y2 + y1)
        return total

    polygons: list[list] = []
    for ring in rings:
        if len(ring) < 4:
            continue
        if signed_area(ring) > 0 or not polygons:
            polygons.append([ring])
        else:
            polygons[-1].append(ring)
    if not polygons:
        return None
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def fetch_arcgis(source: ArcGisSource) -> tuple[list[dict], dict]:
    log(f"  [{source.id}] listing object ids ...")
    ids = arcgis_object_ids(source)
    log(f"  [{source.id}] {len(ids):,} features to fetch")
    if not ids:
        raise RuntimeError("service returned zero object ids -- check `where` clause")

    features: list[dict] = []
    dropped = 0
    chunk = source.page_size
    use_geojson = True

    for start in range(0, len(ids), chunk):
        batch = ids[start : start + chunk]
        params = {
            "objectIds": ",".join(str(i) for i in batch),
            "outFields": ",".join(source.out_fields),
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": str(source.precision),
            "maxAllowableOffset": str(source.simplify_deg),
            "f": "geojson" if use_geojson else "json",
        }
        payload = http_post_json(f"{source.url}/query", params, timeout=300)

        if use_geojson and "features" not in payload:
            use_geojson = False
            params["f"] = "json"
            payload = http_post_json(f"{source.url}/query", params, timeout=300)

        raw_features = payload.get("features", [])
        for raw in raw_features:
            if use_geojson:
                props = raw.get("properties") or {}
                geometry = raw.get("geometry")
            else:
                props = raw.get("attributes") or {}
                geometry = esri_to_geojson_geometry(raw.get("geometry") or {}, source.geometry)
            if not geometry:
                dropped += 1
                continue
            cls = source.classify(props)
            if cls is None:
                dropped += 1
                continue
            features.append({"type": "Feature", "properties": {"c": cls}, "geometry": geometry})

        done = min(start + chunk, len(ids))
        if done % (chunk * 10) == 0 or done == len(ids):
            log(f"  [{source.id}] {done:,}/{len(ids):,}")

    return features, {"requested": len(ids), "dropped": dropped}


# --------------------------------------------------------------------------
# Overpass / OpenStreetMap
# --------------------------------------------------------------------------

def overpass_query(query: str) -> dict:
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                log(f"    querying {endpoint} (attempt {attempt + 1})")
                raw = http_post(endpoint, query.encode("utf-8"), timeout=1200)
                return json.loads(raw.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                log(f"    failed: {exc}")
                time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"all Overpass endpoints failed: {last_error}")


def round_coords(coords, precision: int):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], precision), round(coords[1], precision)]
    return [round_coords(c, precision) for c in coords]


def overpass_element_geometry(element: dict, want: str, precision: int) -> dict | None:
    etype = element.get("type")

    if etype == "node":
        if "lat" not in element:
            return None
        return {"type": "Point", "coordinates": [round(element["lon"], precision), round(element["lat"], precision)]}

    if etype == "way":
        geometry = element.get("geometry") or []
        if len(geometry) < 2:
            return None
        line = [[round(p["lon"], precision), round(p["lat"], precision)] for p in geometry]
        closed = len(line) >= 4 and line[0] == line[-1]
        if want == "polygon" and closed:
            return {"type": "Polygon", "coordinates": [line]}
        if want == "polygon" and not closed:
            return None
        return {"type": "LineString", "coordinates": line}

    if etype == "relation":
        # Approximate a multipolygon by taking closed outer members. Stitching
        # open ways into rings is out of scope; those members are skipped rather
        # than drawn wrong.
        polygons = []
        for member in element.get("members", []):
            if member.get("role") not in ("outer", ""):
                continue
            geometry = member.get("geometry") or []
            if len(geometry) < 4:
                continue
            ring = [[round(p["lon"], precision), round(p["lat"], precision)] for p in geometry]
            if ring[0] != ring[-1]:
                continue
            polygons.append([ring])
        if not polygons:
            return None
        if len(polygons) == 1:
            return {"type": "Polygon", "coordinates": polygons[0]}
        return {"type": "MultiPolygon", "coordinates": polygons}

    return None


def fetch_overpass(source: OverpassSource) -> tuple[list[dict], dict]:
    payload = overpass_query(source.query)
    elements = payload.get("elements", [])
    log(f"  [{source.id}] {len(elements):,} raw OSM elements")

    features: list[dict] = []
    dropped = 0
    for element in elements:
        tags = element.get("tags") or {}
        cls = source.classify(tags)
        if cls is None:
            dropped += 1
            continue
        geometry = overpass_element_geometry(element, source.geometry, source.precision)
        if not geometry:
            dropped += 1
            continue
        props: dict = {"c": cls}
        name = tags.get("name")
        if name:
            props["n"] = name[:80]
        features.append({"type": "Feature", "properties": props, "geometry": geometry})

    return features, {"requested": len(elements), "dropped": dropped}


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

def write_layer(source_id: str, features: list[dict]) -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{source_id}.geojson")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": features}, handle, separators=(",", ":"))
    return os.path.getsize(path)


def load_manifest() -> dict:
    path = os.path.join(OUT_DIR, "manifest.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    return {"layers": {}}


def save_manifest(manifest: dict) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated layer ids to build")
    parser.add_argument("--skip", help="comma-separated layer ids to skip")
    parser.add_argument("--list", action="store_true", help="list layer ids and exit")
    args = parser.parse_args()

    if args.list:
        for source in ARCGIS_SOURCES + OVERPASS_SOURCES:
            print(f"{source.id:14s} {source.kind:15s} {source.label}")
        return 0

    wanted = set(args.only.split(",")) if args.only else set(ALL_SOURCE_IDS)
    skipped = set(args.skip.split(",")) if args.skip else set()
    targets = [s for s in ARCGIS_SOURCES + OVERPASS_SOURCES if s.id in wanted and s.id not in skipped]
    if not targets:
        log("Nothing to build.")
        return 1

    manifest = load_manifest()
    failures: list[str] = []

    for source in targets:
        log(f"\n=== {source.id}: {source.label}")
        started = time.time()
        try:
            if isinstance(source, ArcGisSource):
                features, stats = fetch_arcgis(source)
            else:
                features, stats = fetch_overpass(source)

            if not features:
                raise RuntimeError("no features survived classification")

            size = write_layer(source.id, features)
            entry = {
                "id": source.id,
                "label": source.label,
                "kind": source.kind,
                "geometry": source.geometry,
                "file": f"data/{source.id}.geojson",
                "attribution": source.attribution,
                "feature_count": len(features),
                "bytes": size,
                "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "status": "ok",
                "notes": source.notes,
            }
            if isinstance(source, ArcGisSource):
                entry["source_url"] = source.url
                entry["simplify_deg"] = source.simplify_deg
                entry["point_query_url"] = source.point_query_url
            else:
                entry["source_url"] = "https://overpass-api.de/"
                entry["coverage_caveat"] = source.coverage_caveat
            manifest["layers"][source.id] = entry
            save_manifest(manifest)

            log(
                f"  [{source.id}] OK - {len(features):,} features, "
                f"{size / 1_048_576:.1f} MB, {time.time() - started:.0f}s "
                f"({stats['dropped']:,} dropped)"
            )
        except Exception as exc:  # noqa: BLE001 - one bad source must not kill the run
            failures.append(source.id)
            previous = manifest["layers"].get(source.id, {})
            manifest["layers"][source.id] = {
                **previous,
                "id": source.id,
                "label": source.label,
                "kind": source.kind,
                "status": "failed",
                "error": str(exc)[:400],
                "failed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            save_manifest(manifest)
            log(f"  [{source.id}] FAILED: {exc}")

    total = sum(
        entry.get("bytes", 0)
        for entry in manifest["layers"].values()
        if entry.get("status") == "ok"
    )
    log(f"\nTotal prebaked layer size: {total / 1_048_576:.1f} MB")
    if failures:
        log(f"Failed layers: {', '.join(failures)}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
