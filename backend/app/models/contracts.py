"""Immutable shared contracts for Star Hunters (Phase 0).

Supports both Pydantic v2 (when installed) and stdlib dataclasses + jsonschema so contract
validation, unit tests, and preset generators run cleanly in any Python 3.11+ environment.
"""

from __future__ import annotations

import csv
import math
import re
import struct
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import jsonschema

try:
    from pydantic import BaseModel as _PydanticBaseModel
    from pydantic import ConfigDict
    from pydantic import Field as _PydanticField

    HAS_PYDANTIC = True
except ImportError:  # pragma: no cover
    _PydanticBaseModel = object  # type: ignore[assignment,misc]
    _PydanticField = None  # type: ignore[assignment]
    ConfigDict = None  # type: ignore[assignment]
    HAS_PYDANTIC = False


# ---------------------------------------------------------------------------
# Constants: Detector Wavelength Bands, Binary Frame Sizes & Hygiene Flags
# ---------------------------------------------------------------------------

GRID_WIDTH = 256
GRID_HEIGHT = 256
NUM_DETECTORS = 6
PIXELS_PER_PLANE = GRID_WIDTH * GRID_HEIGHT  # 65,536
TOTAL_DETECTOR_VALUES = NUM_DETECTORS * PIXELS_PER_PLANE  # 393,216

BINARY_DETECTOR_FLOAT32_BYTES = TOTAL_DETECTOR_VALUES * 4  # 1,572,864 bytes
BINARY_DETECTOR_FLOAT16_BYTES = TOTAL_DETECTOR_VALUES * 2  # 786,432 bytes
BINARY_FLAGS_UINT8_BYTES = PIXELS_PER_PLANE * 1  # 65,536 bytes

DETECTOR_BANDS_UM: dict[int, tuple[float, float]] = {
    1: (0.75, 1.10),
    2: (1.10, 1.60),
    3: (1.60, 2.42),
    4: (2.42, 3.80),  # WISE W1 (3.4 um) fallback maps here
    5: (3.80, 4.40),  # WISE W2 (4.6 um) fallback maps here
    6: (4.40, 5.00),  # WISE W2 (4.6 um) fallback maps here
}

FLAG_BITS: dict[str, int] = {
    "TRANSIENT_OR_COSMIC_RAY": 1 << 0,  # 1
    "SATURATED_PIXEL": 1 << 1,  # 2
    "DEAD_OR_BAD_REFERENCE": 1 << 2,  # 4
    "STRAY_LIGHT_OR_BORDER": 1 << 3,  # 8
}

DEFAULT_MOLECULAR_FEATURES: list[dict[str, Any]] = [
    {"molecule": "H2O", "min_um": 2.95, "max_um": 3.30, "label": "Water Ice & Vapor"},
    {"molecule": "CH4", "min_um": 3.20, "max_um": 3.55, "label": "Methane Absorption"},
    {"molecule": "CO2", "min_um": 4.20, "max_um": 4.35, "label": "Carbon Dioxide"},
    {"molecule": "CO", "min_um": 4.55, "max_um": 4.80, "label": "Carbon Monoxide"},
]


def _slugify_capital(city_name: str) -> str:
    """Convert a capital city name to an ASCII snake_case slug."""
    ascii_text = unicodedata.normalize("NFKD", city_name).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "_", ascii_text.lower()).strip("_")


def _load_world_capital_cities() -> list[dict[str, Any]]:
    """Load the full list of world capital cities from world_capital_cities.csv."""
    csv_path = Path(__file__).with_name("world_capital_cities.csv")
    cities: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            city_name = row["Capital City"].strip()
            country = row["Country"].strip()
            cities.append(
                {
                    "slug": _slugify_capital(city_name),
                    "city_name": city_name,
                    "country": country,
                    "lat": float(row["Latitude"]),
                    "lon": float(row["Longitude"]),
                }
            )
    return cities


WORLD_CAPITAL_CITIES: list[dict[str, Any]] = _load_world_capital_cities()

SHOWCASE_TARGETS: dict[str, dict[str, Any]] = {
    "wise_0855": {
        "slug": "wise_0855",
        "name": "WISE 0855",
        "ra": 133.7951,
        "dec": -7.2451,
        "category": "Ultra-Cold Brown Dwarf",
        "description": (
            "Closest/fastest known sub-brown dwarf (~250 K); invisible in optical/short-IR "
            "(Detectors 1-3) and blazes at 4.5 microns (Detectors 5-6)."
        ),
        "constellation": "Hydra",
    },
    "barnards_star": {
        "slug": "barnards_star",
        "name": "Barnard's Star",
        "ra": 269.4521,
        "dec": 4.6934,
        "category": "Fastest Proper Motion Star",
        "description": (
            "Fastest proper motion star (10.3 arcsec/yr); bright across all 6 detectors and "
            "produces a sharp positive/negative dipole in Pass B - Pass A subtraction mode."
        ),
        "constellation": "Ophiuchus",
    },
    "epsilon_indi_b": {
        "slug": "epsilon_indi_b",
        "name": "Epsilon Indi B",
        "ra": 331.0438,
        "dec": -56.7827,
        "category": "Binary Brown Dwarf (T1 + T6)",
        "description": (
            "Co-moving near-infrared brown dwarf binary with deep H2O (3.0 um) and CH4 (3.3 um) "
            "molecular absorption troughs in the 102-band spectrum."
        ),
        "constellation": "Indus",
    },
    "rw_aurigae": {
        "slug": "rw_aurigae",
        "name": "RW Aurigae",
        "ra": 76.9565,
        "dec": 30.4014,
        "category": "T Tauri Variable Star",
        "description": (
            "Young variable star with stationary sky coordinates that leaves a strong brightness "
            "residual ring in Pass subtraction due to circumstellar disk dimming/flaring."
        ),
        "constellation": "Auriga",
    },
    "r_draconis": {
        "slug": "r_draconis",
        "name": "R Draconis",
        "ra": 248.1676,
        "dec": 66.7548,
        "category": "Mira-Type Pulsating Red Giant",
        "description": (
            "Stationary pulsating red giant with dramatic periodic infrared flux swings across "
            "epochs and strong H2O and CO molecular bands."
        ),
        "constellation": "Draco",
    },
    "comet_3i_atlas": {
        "slug": "comet_3i_atlas",
        "name": "Comet 3I/ATLAS",
        "ra": 295.3200,
        "dec": -18.4100,
        "category": "Moving Solar System / Interstellar Comet",
        "description": (
            "Rapidly shifting comet across exposures with prominent H2O ice/vapor (3.0 um) "
            "and CO2 (4.26 um) coma emission peaks."
        ),
        "constellation": "Sagittarius",
    },
}


# ---------------------------------------------------------------------------
# JSON Schemas (Draft-07 / Draft 2020-12 compatible)
# ---------------------------------------------------------------------------

QUERY_INFO_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["ra", "dec", "fov_arcmin", "grid_key", "cached"],
    "properties": {
        "ra": {"type": "number", "minimum": 0.0, "maximum": 360.0},
        "dec": {"type": "number", "minimum": -90.0, "maximum": 90.0},
        "fov_arcmin": {"type": "number", "exclusiveMinimum": 0.0, "maximum": 60.0},
        "grid_key": {"type": "string", "minLength": 3},
        "cached": {"type": "boolean"},
    },
    "additionalProperties": False,
}

WCS_HEADER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["width", "height", "crval", "crpix", "cdelt"],
    "properties": {
        "width": {"type": "integer", "enum": [256]},
        "height": {"type": "integer", "enum": [256]},
        "crval": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 2,
            "maxItems": 2,
        },
        "crpix": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 2,
            "maxItems": 2,
        },
        "cdelt": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 2,
            "maxItems": 2,
        },
    },
    "additionalProperties": False,
}

KNOWN_OBJECT_EPOCH_POSITION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["epoch_id", "mjd", "ra", "dec", "x", "y"],
    "properties": {
        "epoch_id": {"type": "string", "minLength": 1},
        "mjd": {"type": "number"},
        "ra": {"type": "number", "minimum": 0.0, "maximum": 360.0},
        "dec": {"type": "number", "minimum": -90.0, "maximum": 90.0},
        "x": {"type": "number"},
        "y": {"type": "number"},
    },
    "additionalProperties": False,
}

KNOWN_CELESTIAL_OBJECT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": [
        "object_id",
        "label",
        "catalog",
        "object_type",
        "ra",
        "dec",
        "x",
        "y",
        "magnitude",
        "proper_motion_arcsec_yr",
        "w1_w2_color",
        "default_checked",
        "epoch_positions",
    ],
    "properties": {
        "object_id": {"type": "string", "minLength": 1},
        "label": {"type": "string", "minLength": 1},
        "catalog": {"type": "string", "enum": ["gaia_dr3", "wise", "most"]},
        "object_type": {
            "type": "string",
            "enum": [
                "star",
                "high_pm_star",
                "brown_dwarf_candidate",
                "solar_system",
                "variable_star",
                "infrared_source",
            ],
        },
        "ra": {"type": "number", "minimum": 0.0, "maximum": 360.0},
        "dec": {"type": "number", "minimum": -90.0, "maximum": 90.0},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "magnitude": {"type": ["number", "null"]},
        "proper_motion_arcsec_yr": {"type": ["number", "null"], "minimum": 0.0},
        "w1_w2_color": {"type": ["number", "null"]},
        "default_checked": {"type": "boolean"},
        "epoch_positions": {
            "type": "array",
            "items": KNOWN_OBJECT_EPOCH_POSITION_SCHEMA,
        },
    },
    "additionalProperties": False,
}

CATALOG_OVERLAYS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["gaia_dr3", "wise_sources", "most_solar_system"],
    "properties": {
        "known_objects": {
            "type": "array",
            "items": KNOWN_CELESTIAL_OBJECT_SCHEMA,
        },
        "gaia_dr3": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["source_id", "ra", "dec", "x", "y", "g_mag", "bp_rp", "pmra", "pmdec"],
                "properties": {
                    "source_id": {"type": "string"},
                    "ra": {"type": "number"},
                    "dec": {"type": "number"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "g_mag": {"type": "number"},
                    "bp_rp": {"type": ["number", "null"]},
                    "pmra": {"type": ["number", "null"]},
                    "pmdec": {"type": ["number", "null"]},
                },
                "additionalProperties": False,
            },
        },
        "wise_sources": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["source_id", "ra", "dec", "x", "y", "w1_mag", "w2_mag", "w1_w2_color"],
                "properties": {
                    "source_id": {"type": "string"},
                    "ra": {"type": "number"},
                    "dec": {"type": "number"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "w1_mag": {"type": "number"},
                    "w2_mag": {"type": "number"},
                    "w1_w2_color": {"type": "number"},
                },
                "additionalProperties": False,
            },
        },
        "most_solar_system": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["object_name", "epoch_id", "ra", "dec", "x", "y", "v_mag"],
                "properties": {
                    "object_name": {"type": "string"},
                    "epoch_id": {"type": "string"},
                    "ra": {"type": "number"},
                    "dec": {"type": "number"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "v_mag": {"type": "number"},
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

SKY_PATCH_MANIFEST_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": [
        "query",
        "target_metadata",
        "data_source_summary",
        "wcs",
        "epochs",
        "default_spectrum_url",
        "catalog_overlays",
    ],
    "properties": {
        "query": QUERY_INFO_SCHEMA,
        "target_metadata": {
            "type": "object",
            "required": ["slug", "name", "category", "description", "constellation"],
            "properties": {
                "slug": {"type": "string"},
                "name": {"type": "string"},
                "category": {"type": "string"},
                "description": {"type": "string"},
                "constellation": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "data_source_summary": {
            "type": "object",
            "required": [
                "primary_mission",
                "has_multi_epoch_spherex",
                "uses_wise_fallback",
                "baseline_days",
                "status_note",
            ],
            "properties": {
                "primary_mission": {"type": "string", "enum": ["SPHEREx", "WISE"]},
                "has_multi_epoch_spherex": {"type": "boolean"},
                "uses_wise_fallback": {"type": "boolean"},
                "baseline_days": {"type": "number", "minimum": 0.0},
                "status_note": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "wcs": WCS_HEADER_SCHEMA,
        "epochs": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": [
                    "epoch_id",
                    "label",
                    "mission",
                    "mjd",
                    "iso_date",
                    "detectors_data_url",
                    "flags_mask_url",
                    "available_detectors",
                ],
                "properties": {
                    "epoch_id": {"type": "string"},
                    "label": {"type": "string"},
                    "mission": {"type": "string", "enum": ["SPHEREx", "WISE"]},
                    "mjd": {"type": "number"},
                    "iso_date": {"type": "string"},
                    "detectors_data_url": {"type": "string"},
                    "flags_mask_url": {"type": "string"},
                    "available_detectors": {
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "integer", "minimum": 1, "maximum": 6},
                    },
                    "binary_dtype": {
                        "type": "string",
                        "enum": ["float32", "float16"],
                    },
                },
                "additionalProperties": False,
            },
        },
        "default_spectrum_url": {"type": ["string", "null"]},
        "catalog_overlays": CATALOG_OVERLAYS_SCHEMA,
    },
    "additionalProperties": False,
}

CATALOGS_RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["query", "wcs", "catalog_overlays"],
    "properties": {
        "query": QUERY_INFO_SCHEMA,
        "wcs": WCS_HEADER_SCHEMA,
        "catalog_overlays": CATALOG_OVERLAYS_SCHEMA,
    },
    "additionalProperties": False,
}

SPECTRUM_PAYLOAD_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": [
        "ra",
        "dec",
        "source_label",
        "spectrum_origin",
        "units",
        "channels",
        "molecular_features",
    ],
    "properties": {
        "ra": {"type": "number", "minimum": 0.0, "maximum": 360.0},
        "dec": {"type": "number", "minimum": -90.0, "maximum": 90.0},
        "source_label": {"type": "string"},
        "spectrum_origin": {"type": "string"},
        "units": {
            "type": "object",
            "required": ["wavelength", "flux"],
            "properties": {
                "wavelength": {"type": "string", "enum": ["um"]},
                "flux": {"type": "string", "enum": ["MJy/sr"]},
            },
            "additionalProperties": False,
        },
        "channels": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": [
                    "band_index",
                    "detector",
                    "wavelength_um",
                    "flux",
                    "variance",
                    "flagged",
                ],
                "properties": {
                    "band_index": {"type": "integer", "minimum": 1, "maximum": 102},
                    "detector": {"type": "integer", "minimum": 1, "maximum": 6},
                    "wavelength_um": {"type": "number", "minimum": 0.70, "maximum": 5.20},
                    "flux": {"type": "number"},
                    "variance": {"type": "number", "minimum": 0.0},
                    "flagged": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
        },
        "molecular_features": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["molecule", "min_um", "max_um", "label"],
                "properties": {
                    "molecule": {"type": "string"},
                    "min_um": {"type": "number"},
                    "max_um": {"type": "number"},
                    "label": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

EARTH_TO_SKY_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["earth", "zenith_icrs"],
    "properties": {
        "earth": {
            "type": "object",
            "required": ["lat", "lon", "iso_time"],
            "properties": {
                "lat": {"type": "number", "minimum": -90.0, "maximum": 90.0},
                "lon": {"type": "number", "minimum": -180.0, "maximum": 180.0},
                "iso_time": {"type": "string", "minLength": 10},
                "city_name": {"type": ["string", "null"]},
                "country": {"type": ["string", "null"]},
                "is_fallback_capital": {"type": "boolean"},
                "cached": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
        "zenith_icrs": {
            "type": "object",
            "required": ["ra", "dec", "constellation"],
            "properties": {
                "ra": {"type": "number", "minimum": 0.0, "maximum": 360.0},
                "dec": {"type": "number", "minimum": -90.0, "maximum": 90.0},
                "constellation": {"type": "string", "minLength": 1},
            },
            "additionalProperties": False,
        },
    },
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Contract Model Classes (Dataclass + Pydantic v2 API compatibility)
# ---------------------------------------------------------------------------


class _ContractModelMixin:
    """Provides Pydantic v2-compatible `.model_dump()` and `.model_validate()`."""

    SCHEMA: dict[str, Any] = {}

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)  # type: ignore[arg-type]

    @classmethod
    def model_validate(cls, data: dict[str, Any]) -> Any:
        if cls.SCHEMA:
            jsonschema.validate(instance=data, schema=cls.SCHEMA)
        return cls._from_dict(data)

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> Any:
        return cls(**data)


@dataclass
class QueryInfo(_ContractModelMixin):
    SCHEMA = QUERY_INFO_SCHEMA
    ra: float
    dec: float
    fov_arcmin: float
    grid_key: str
    cached: bool = False


@dataclass
class TargetMetadata(_ContractModelMixin):
    slug: str
    name: str
    category: str
    description: str
    constellation: str


@dataclass
class DataSourceSummary(_ContractModelMixin):
    primary_mission: Literal["SPHEREx", "WISE"]
    has_multi_epoch_spherex: bool
    uses_wise_fallback: bool
    baseline_days: float
    status_note: str


@dataclass
class WcsHeader(_ContractModelMixin):
    SCHEMA = WCS_HEADER_SCHEMA
    width: int
    height: int
    crval: list[float]
    crpix: list[float]
    cdelt: list[float]


@dataclass
class EpochEntry(_ContractModelMixin):
    epoch_id: str
    label: str
    mission: Literal["SPHEREx", "WISE"]
    mjd: float
    iso_date: str
    detectors_data_url: str
    flags_mask_url: str
    available_detectors: list[int]
    binary_dtype: Literal["float32", "float16"] = "float32"


@dataclass
class KnownObjectEpochPosition(_ContractModelMixin):
    SCHEMA = KNOWN_OBJECT_EPOCH_POSITION_SCHEMA
    epoch_id: str
    mjd: float
    ra: float
    dec: float
    x: float
    y: float


@dataclass
class KnownCelestialObject(_ContractModelMixin):
    SCHEMA = KNOWN_CELESTIAL_OBJECT_SCHEMA
    object_id: str
    label: str
    catalog: Literal["gaia_dr3", "wise", "most"]
    object_type: Literal[
        "star",
        "high_pm_star",
        "brown_dwarf_candidate",
        "solar_system",
        "variable_star",
        "infrared_source",
    ]
    ra: float
    dec: float
    x: float
    y: float
    magnitude: float | None
    proper_motion_arcsec_yr: float | None
    w1_w2_color: float | None
    default_checked: bool
    epoch_positions: list[KnownObjectEpochPosition] = field(default_factory=list)

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> KnownCelestialObject:
        positions = [
            KnownObjectEpochPosition._from_dict(p) if isinstance(p, dict) else p
            for p in data.get("epoch_positions", [])
        ]
        copy_data = dict(data)
        copy_data["epoch_positions"] = positions
        return cls(**copy_data)


@dataclass
class GaiaDr3Source(_ContractModelMixin):
    source_id: str
    ra: float
    dec: float
    x: float
    y: float
    g_mag: float
    bp_rp: float | None
    pmra: float | None
    pmdec: float | None


@dataclass
class WiseSource(_ContractModelMixin):
    source_id: str
    ra: float
    dec: float
    x: float
    y: float
    w1_mag: float
    w2_mag: float
    w1_w2_color: float


@dataclass
class MostSolarSystemObject(_ContractModelMixin):
    object_name: str
    epoch_id: str
    ra: float
    dec: float
    x: float
    y: float
    v_mag: float


@dataclass
class CatalogOverlays(_ContractModelMixin):
    SCHEMA = CATALOG_OVERLAYS_SCHEMA
    gaia_dr3: list[GaiaDr3Source] = field(default_factory=list)
    wise_sources: list[WiseSource] = field(default_factory=list)
    most_solar_system: list[MostSolarSystemObject] = field(default_factory=list)
    known_objects: list[KnownCelestialObject] = field(default_factory=list)

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> CatalogOverlays:
        return cls(
            gaia_dr3=[
                GaiaDr3Source._from_dict(item) if isinstance(item, dict) else item
                for item in data.get("gaia_dr3", [])
            ],
            wise_sources=[
                WiseSource._from_dict(item) if isinstance(item, dict) else item
                for item in data.get("wise_sources", [])
            ],
            most_solar_system=[
                MostSolarSystemObject._from_dict(item) if isinstance(item, dict) else item
                for item in data.get("most_solar_system", [])
            ],
            known_objects=[
                KnownCelestialObject._from_dict(item) if isinstance(item, dict) else item
                for item in data.get("known_objects", [])
            ],
        )


@dataclass
class SkyPatchManifest(_ContractModelMixin):
    SCHEMA = SKY_PATCH_MANIFEST_JSON_SCHEMA
    query: QueryInfo
    target_metadata: TargetMetadata
    data_source_summary: DataSourceSummary
    wcs: WcsHeader
    epochs: list[EpochEntry]
    default_spectrum_url: str | None
    catalog_overlays: CatalogOverlays

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> SkyPatchManifest:
        return cls(
            query=QueryInfo._from_dict(data["query"]),
            target_metadata=TargetMetadata._from_dict(data["target_metadata"]),
            data_source_summary=DataSourceSummary._from_dict(data["data_source_summary"]),
            wcs=WcsHeader._from_dict(data["wcs"]),
            epochs=[EpochEntry._from_dict(ep) for ep in data["epochs"]],
            default_spectrum_url=data.get("default_spectrum_url"),
            catalog_overlays=CatalogOverlays._from_dict(data["catalog_overlays"]),
        )


@dataclass
class CatalogsResponse(_ContractModelMixin):
    SCHEMA = CATALOGS_RESPONSE_JSON_SCHEMA
    query: QueryInfo
    wcs: WcsHeader
    catalog_overlays: CatalogOverlays

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> CatalogsResponse:
        return cls(
            query=QueryInfo._from_dict(data["query"]),
            wcs=WcsHeader._from_dict(data["wcs"]),
            catalog_overlays=CatalogOverlays._from_dict(data["catalog_overlays"]),
        )


@dataclass
class SpectrumUnits(_ContractModelMixin):
    wavelength: Literal["um"] = "um"
    flux: Literal["MJy/sr"] = "MJy/sr"


@dataclass
class SpectrumChannel(_ContractModelMixin):
    band_index: int
    detector: int
    wavelength_um: float
    flux: float
    variance: float
    flagged: bool = False


@dataclass
class MolecularFeature(_ContractModelMixin):
    molecule: str
    min_um: float
    max_um: float
    label: str


@dataclass
class SpectrumPayload(_ContractModelMixin):
    SCHEMA = SPECTRUM_PAYLOAD_JSON_SCHEMA
    ra: float
    dec: float
    source_label: str
    spectrum_origin: str
    units: SpectrumUnits
    channels: list[SpectrumChannel]
    molecular_features: list[MolecularFeature]

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> SpectrumPayload:
        return cls(
            ra=data["ra"],
            dec=data["dec"],
            source_label=data["source_label"],
            spectrum_origin=data["spectrum_origin"],
            units=SpectrumUnits._from_dict(data["units"]),
            channels=[SpectrumChannel._from_dict(ch) for ch in data["channels"]],
            molecular_features=[
                MolecularFeature._from_dict(mf) for mf in data["molecular_features"]
            ],
        )


@dataclass
class EarthCoordinates(_ContractModelMixin):
    lat: float
    lon: float
    iso_time: str
    city_name: str | None = None
    country: str | None = None
    is_fallback_capital: bool = False
    cached: bool = False


@dataclass
class ZenithIcrsCoordinates(_ContractModelMixin):
    ra: float
    dec: float
    constellation: str


@dataclass
class EarthToSkyResponse(_ContractModelMixin):
    SCHEMA = EARTH_TO_SKY_JSON_SCHEMA
    earth: EarthCoordinates
    zenith_icrs: ZenithIcrsCoordinates

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> EarthToSkyResponse:
        return cls(
            earth=EarthCoordinates._from_dict(data["earth"]),
            zenith_icrs=ZenithIcrsCoordinates._from_dict(data["zenith_icrs"]),
        )


# ---------------------------------------------------------------------------
# Validation & 3G Binary Frame Utilities
# ---------------------------------------------------------------------------


def validate_sky_patch_manifest(payload: dict[str, Any]) -> SkyPatchManifest:
    """Validate a SkyPatchManifest dictionary against the Phase 0 schema."""
    manifest = SkyPatchManifest.model_validate(payload)
    for ep in manifest.epochs:
        if not math.isfinite(ep.mjd):
            raise ValueError(f"Epoch {ep.epoch_id} has non-finite MJD: {ep.mjd}")
    return manifest


def validate_catalogs_response(payload: dict[str, Any]) -> CatalogsResponse:
    """Validate a GET /api/v1/catalogs response payload."""
    return CatalogsResponse.model_validate(payload)


def validate_spectrum_payload(payload: dict[str, Any]) -> SpectrumPayload:
    """Validate a SpectrumPayload dictionary and check monotonic wavelength ordering."""
    spectrum = SpectrumPayload.model_validate(payload)
    wavelengths = [ch.wavelength_um for ch in spectrum.channels]
    if len(wavelengths) != 102:
        raise ValueError(f"Spectrum must contain exactly 102 channels, got {len(wavelengths)}")
    for i in range(1, len(wavelengths)):
        if wavelengths[i] <= wavelengths[i - 1]:
            raise ValueError(
                f"Spectrum channels must be strictly increasing at index {i}: "
                f"{wavelengths[i - 1]} -> {wavelengths[i]}"
            )
    if not math.isclose(wavelengths[0], 0.75, abs_tol=0.01):
        raise ValueError("Spectrum must start at approximately 0.75 um")
    if not math.isclose(wavelengths[-1], 5.00, abs_tol=0.01):
        raise ValueError("Spectrum must end at approximately 5.00 um")
    for ch in spectrum.channels:
        if not (math.isfinite(ch.flux) and math.isfinite(ch.variance)):
            raise ValueError(f"Non-finite flux/variance at band_index={ch.band_index}")
        if ch.variance < 0.0:
            raise ValueError(f"Negative variance at band_index={ch.band_index}")
    return spectrum


def validate_earth_to_sky_response(payload: dict[str, Any]) -> EarthToSkyResponse:
    """Validate an EarthToSkyResponse dictionary."""
    return EarthToSkyResponse.model_validate(payload)


def validate_detector_binary_buffer(
    raw_bytes: bytes,
    precision: Literal["float32", "float16"] = "float32",
) -> tuple[int, float, float]:
    """Validate raw pass_{N}.bin bytes for exact byte length and finite values.

    Returns (num_values, min_value, max_value).
    """
    expected = (
        BINARY_DETECTOR_FLOAT32_BYTES if precision == "float32" else BINARY_DETECTOR_FLOAT16_BYTES
    )
    if len(raw_bytes) != expected:
        raise ValueError(
            f"Invalid detector binary buffer size for {precision}: "
            f"expected {expected} bytes, got {len(raw_bytes)} bytes"
        )
    fmt = f"<{TOTAL_DETECTOR_VALUES}f" if precision == "float32" else f"<{TOTAL_DETECTOR_VALUES}e"
    values = struct.unpack(fmt, raw_bytes)
    min_val = float("inf")
    max_val = float("-inf")
    for val in values:
        if not math.isfinite(val):
            raise ValueError("Detector binary buffer contains NaN or Inf values")
        if val < min_val:
            min_val = val
        if val > max_val:
            max_val = val
    return len(values), min_val, max_val


def validate_flags_binary_buffer(raw_bytes: bytes) -> tuple[int, int]:
    """Validate raw pass_{N}_flags.bin bytes for exact 65,536-byte length.

    Returns (num_pixels, nonzero_count).
    """
    if len(raw_bytes) != BINARY_FLAGS_UINT8_BYTES:
        raise ValueError(
            f"Invalid flags binary buffer size: expected {BINARY_FLAGS_UINT8_BYTES} bytes, "
            f"got {len(raw_bytes)} bytes"
        )
    nonzero = sum(1 for b in raw_bytes if b != 0)
    return len(raw_bytes), nonzero


def convert_float32_bytes_to_float16_bytes(float32_bytes: bytes) -> bytes:
    """Convert a (6, 256, 256) float32 buffer to float16 (786,432 B) for 3G transfer."""
    if len(float32_bytes) != BINARY_DETECTOR_FLOAT32_BYTES:
        raise ValueError(
            f"Expected {BINARY_DETECTOR_FLOAT32_BYTES} bytes, got {len(float32_bytes)}"
        )
    values = struct.unpack(f"<{TOTAL_DETECTOR_VALUES}f", float32_bytes)
    clamped = [max(-65504.0, min(65504.0, v)) for v in values]
    return struct.pack(f"<{TOTAL_DETECTOR_VALUES}e", *clamped)


def convert_float16_bytes_to_float32_bytes(float16_bytes: bytes) -> bytes:
    """Convert a (6, 256, 256) float16 buffer (786,432 B) back to float32 (1,572,864 B)."""
    if len(float16_bytes) != BINARY_DETECTOR_FLOAT16_BYTES:
        raise ValueError(
            f"Expected {BINARY_DETECTOR_FLOAT16_BYTES} bytes, got {len(float16_bytes)}"
        )
    values = struct.unpack(f"<{TOTAL_DETECTOR_VALUES}e", float16_bytes)
    return struct.pack(f"<{TOTAL_DETECTOR_VALUES}f", *values)
