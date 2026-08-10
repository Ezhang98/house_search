"""
Declarative registry of every prebaked map layer.

Adding a layer means adding an entry here -- `build_layers.py` is generic and
does not know about any specific dataset.

Two kinds of source:

  ArcGisSource   paginated ArcGIS REST FeatureServer/MapServer query
  OverpassSource OpenStreetMap query via the Overpass API

`classify` maps a raw upstream feature's properties onto a short, stable class
string that the front end styles and reports. Keeping the mapping here means the
app never has to know upstream field names, and an upstream schema change breaks
the build loudly instead of silently mislabelling a hazard.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

# Rough California bounding box, used for ArcGIS envelope filters and Overpass.
CA_BBOX = (-124.55, 32.45, -114.05, 42.05)  # west, south, east, north


@dataclass
class ArcGisSource:
    id: str
    label: str
    url: str
    out_fields: list[str]
    classify: Callable[[dict], str | None]
    kind: str                      # "hazard" | "infrastructure"
    geometry: str                  # "polygon" | "line" | "point"
    attribution: str
    where: str = "1=1"
    simplify_deg: float = 0.0003   # ~33 m; display only, see point-query note
    precision: int = 5
    page_size: int = 1000
    use_bbox: bool = True
    # Live per-address point query. When set, the table asks the authoritative
    # service for this exact coordinate instead of trusting the simplified
    # display geometry. Parcel-level answers need the unsimplified polygon.
    point_query_url: str | None = None
    notes: str = ""


@dataclass
class OverpassSource:
    id: str
    label: str
    query: str
    classify: Callable[[dict], str | None]
    kind: str
    geometry: str
    attribution: str = "© OpenStreetMap contributors (ODbL)"
    precision: int = 5
    notes: str = ""
    coverage_caveat: str = ""


def _flood_class(props: dict) -> str | None:
    zone = (props.get("FLD_ZONE") or "").strip().upper()
    subtype = (props.get("ZONE_SUBTY") or "").strip().upper()
    if zone in ("V", "VE"):
        return "coastal-high"          # velocity / wave action
    if zone in ("A", "AE", "AH", "AO", "AR", "A99"):
        if "FLOODWAY" in subtype:
            return "floodway"
        return "sfha"                  # 1% annual chance, mandatory insurance
    return None


def _fhsz_class(props: dict) -> str | None:
    raw = props.get("FHSZ")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        text = (props.get("FHSZ_Description") or "").lower()
        if "very high" in text:
            return "very-high"
        if "high" in text:
            return "high"
        if "moderate" in text:
            return "moderate"
        return None
    return {1: "moderate", 2: "high", 3: "very-high"}.get(value)


def _present(_props: dict) -> str:
    """For layers where presence in the dataset is itself the finding."""
    return "zone"


def _zcta_class(props: dict) -> str | None:
    """ZCTAs are carriers for the price join, not a hazard -- keep the code."""
    zcta = (props.get("ZCTA5") or props.get("GEOID") or "").strip()
    return zcta if len(zcta) == 5 and zcta.isdigit() else None


def _tsunami_class(props: dict) -> str | None:
    evacuate = (props.get("Evacuate") or "").strip().lower()
    if evacuate.startswith("no"):
        return None
    return "zone"


def _osm_road_class(tags: dict) -> str | None:
    highway = tags.get("highway")
    if highway == "motorway":
        return "freeway"
    if highway == "trunk":
        return "trunk"
    if highway == "primary":
        return "primary"
    return None


def _osm_rail_class(tags: dict) -> str | None:
    if tags.get("service"):
        return None                    # yards, sidings, spurs -- not through traffic
    railway = tags.get("railway")
    if railway == "rail":
        return "rail"
    if railway in ("light_rail", "subway"):
        return "transit"
    return None


def _osm_airport_class(tags: dict) -> str | None:
    if tags.get("aeroway") != "aerodrome":
        return None
    if tags.get("military") or tags.get("landuse") == "military":
        return "military"
    kind = (tags.get("aerodrome:type") or "").lower()
    if tags.get("iata") or kind == "public":
        return "commercial"
    return "general-aviation"


def _osm_industrial_class(tags: dict) -> str | None:
    if tags.get("landuse") == "industrial":
        return "industrial"
    if tags.get("landuse") == "quarry" or tags.get("man_made") == "mineshaft":
        return "mine"
    return None


def _osm_datacenter_class(tags: dict) -> str | None:
    if tags.get("telecom") == "data_center" or tags.get("building") == "data_center":
        return "data-center"
    if tags.get("power") == "substation":
        return "substation"
    return None


BBOX_STR = ",".join(str(v) for v in CA_BBOX)
OVERPASS_AREA = 'area["ISO3166-2"="US-CA"][admin_level=4]->.ca;'


ARCGIS_SOURCES: list[ArcGisSource] = [
    ArcGisSource(
        id="flood",
        label="FEMA flood hazard (SFHA)",
        url="https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
        where="FLD_ZONE IN ('A','AE','AH','AO','AR','A99','V','VE')",
        out_fields=["FLD_ZONE", "ZONE_SUBTY"],
        classify=_flood_class,
        kind="hazard",
        geometry="polygon",
        attribution="FEMA National Flood Hazard Layer",
        simplify_deg=0.0003,
        page_size=1000,
        point_query_url="https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
        notes="1% annual chance floodplain. Mandatory insurance in an SFHA with a federally backed mortgage.",
    ),
    ArcGisSource(
        id="fire",
        label="Fire hazard severity zone",
        url="https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/fhsz24_5/FeatureServer/0",
        out_fields=["FHSZ", "FHSZ_Description"],
        classify=_fhsz_class,
        kind="hazard",
        geometry="polygon",
        attribution="CAL FIRE, Fire Hazard Severity Zones (2024/25)",
        simplify_deg=0.0004,
        page_size=2000,
        use_bbox=False,
        point_query_url="https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/fhsz24_5/FeatureServer/0",
        notes="Triggers statutory disclosure and defensible-space requirements in High and Very High zones.",
    ),
    ArcGisSource(
        id="liquefaction",
        label="Liquefaction zone",
        url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CGS_Liquefaction_Zones/FeatureServer/0",
        out_fields=["QUAD_NAME"],
        classify=_present,
        kind="hazard",
        geometry="polygon",
        attribution="California Geological Survey, Seismic Hazard Zones",
        simplify_deg=0.0002,
        page_size=2000,
        use_bbox=False,
        point_query_url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CGS_Liquefaction_Zones/FeatureServer/0",
        notes="Only mapped quadrangles are covered -- mostly urban areas. Absence is not evidence of safety.",
    ),
    ArcGisSource(
        id="landslide",
        label="Earthquake-induced landslide zone",
        url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CGS_Landslide_Zones/FeatureServer/0",
        out_fields=["QUAD_NAME"],
        classify=_present,
        kind="hazard",
        geometry="polygon",
        attribution="California Geological Survey, Seismic Hazard Zones",
        simplify_deg=0.0002,
        page_size=2000,
        use_bbox=False,
        point_query_url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CGS_Landslide_Zones/FeatureServer/0",
        notes="Same mapped-quadrangle limitation as liquefaction zones.",
    ),
    ArcGisSource(
        id="fault",
        label="Alquist-Priolo fault zone",
        url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CGS_Alquist_Priolo_Fault_Zones/FeatureServer/0",
        out_fields=["QUAD_NAME"],
        classify=_present,
        kind="hazard",
        geometry="polygon",
        attribution="California Geological Survey, Alquist-Priolo Earthquake Fault Zones",
        simplify_deg=0.0002,
        page_size=2000,
        use_bbox=False,
        point_query_url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CGS_Alquist_Priolo_Fault_Zones/FeatureServer/0",
        notes="Surface fault rupture zone. Restricts building across the trace and triggers disclosure.",
    ),
    ArcGisSource(
        id="tsunami",
        label="Tsunami hazard area",
        url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CA_Tsunami_Hazard_Area/FeatureServer/0",
        out_fields=["Evacuate", "County"],
        classify=_tsunami_class,
        kind="hazard",
        geometry="polygon",
        attribution="California Geological Survey / Cal OES, Tsunami Hazard Areas",
        simplify_deg=0.0003,
        page_size=2000,
        use_bbox=False,
        point_query_url="https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/CA_Tsunami_Hazard_Area/FeatureServer/0",
        notes="Coastal counties only.",
    ),
    ArcGisSource(
        id="zcta",
        label="ZIP Code Tabulation Areas",
        url="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1",
        out_fields=["ZCTA5", "GEOID"],
        classify=_zcta_class,
        kind="basemap",
        geometry="polygon",
        attribution="U.S. Census Bureau, TIGERweb (2020 ZCTAs)",
        simplify_deg=0.001,       # choropleth only; nothing is decided on this geometry
        page_size=500,
        use_bbox=True,
        notes="Carrier geometry for the sold-price choropleth. ZCTAs approximate but do not equal USPS ZIP codes.",
    ),
]


OVERPASS_SOURCES: list[OverpassSource] = [
    OverpassSource(
        id="roads",
        label="Freeways and major highways",
        query=(
            f"[out:json][timeout:900];{OVERPASS_AREA}"
            'way["highway"~"^(motorway|trunk)$"](area.ca);out geom;'
        ),
        classify=_osm_road_class,
        kind="infrastructure",
        geometry="line",
        notes="Distance to the nearest freeway or trunk route. Noise and air quality fall off sharply with distance.",
    ),
    OverpassSource(
        id="rail",
        label="Rail corridors",
        query=(
            f"[out:json][timeout:900];{OVERPASS_AREA}"
            'way["railway"~"^(rail|light_rail|subway)$"](area.ca);out geom;'
        ),
        classify=_osm_rail_class,
        kind="infrastructure",
        geometry="line",
        notes="Freight and passenger rail. Yard and siding tracks are excluded.",
    ),
    OverpassSource(
        id="airports",
        label="Airports",
        query=(
            f"[out:json][timeout:600];{OVERPASS_AREA}"
            '(way["aeroway"="aerodrome"](area.ca);relation["aeroway"="aerodrome"](area.ca););out geom;'
        ),
        classify=_osm_airport_class,
        kind="infrastructure",
        geometry="polygon",
        notes="Distance to the aerodrome boundary. This is a proxy for noise exposure, not a modelled contour.",
        coverage_caveat="Approach and departure paths extend well beyond the boundary; a distant house under a flight path may still be loud.",
    ),
    OverpassSource(
        id="industrial",
        label="Industrial land and mines",
        query=(
            f"[out:json][timeout:900];{OVERPASS_AREA}"
            '(way["landuse"~"^(industrial|quarry)$"](area.ca);'
            'relation["landuse"~"^(industrial|quarry)$"](area.ca);'
            'way["man_made"="mineshaft"](area.ca););out geom;'
        ),
        classify=_osm_industrial_class,
        kind="infrastructure",
        geometry="polygon",
        notes="OpenStreetMap land use, used as a stand-in for municipal zoning.",
        coverage_caveat="No statewide zoning dataset exists. This is crowd-sourced land use and will disagree with official zoning in places.",
    ),
    OverpassSource(
        id="datacenters",
        label="Data centers and substations",
        query=(
            f"[out:json][timeout:600];{OVERPASS_AREA}"
            '(nwr["telecom"="data_center"](area.ca);'
            'nwr["building"="data_center"](area.ca);'
            'way["power"="substation"](area.ca););out geom;'
        ),
        classify=_osm_datacenter_class,
        kind="infrastructure",
        geometry="polygon",
        notes="Substations are included as a proxy for the heavy electrical infrastructure that clusters near data centers.",
        coverage_caveat="Data centers are poorly and inconsistently tagged in OpenStreetMap and there is no authoritative public dataset. Expect real omissions; supplement via data/datacenters_manual.csv.",
    ),
]


ALL_SOURCE_IDS = [s.id for s in ARCGIS_SOURCES] + [s.id for s in OVERPASS_SOURCES]
