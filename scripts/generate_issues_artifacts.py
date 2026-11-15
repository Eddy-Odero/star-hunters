#!/usr/bin/env python3
"""Generate topologically ordered JSON and Markdown issue files for Star Hunters."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


REPO_ROOT = Path(__file__).resolve().parent.parent
ISSUES_DIR = REPO_ROOT / "issues"


ISSUE_ASSIGNEES: Dict[str, List[str]] = {
    "ISS-01": ["carsonak"],
    "ISS-02": ["carsonak"],
    "ISS-03": ["14Emanuel"],
    "ISS-04": ["paowuor"],
    "ISS-05": ["14Emanuel"],
    "ISS-06": ["14Emanuel"],
    "ISS-07": ["Eddy-Odero"],
    "ISS-08": ["paowuor"],
    "ISS-09": ["paowuor"],
    "ISS-10": ["atienosharzy-boop"],
    "ISS-11": ["atienosharzy-boop"],
    "ISS-12": ["paowuor"],
    "ISS-13": ["14Emanuel"],
    "ISS-14": ["atienosharzy-boop"],
    "ISS-15": ["Eddy-Odero"],
    "ISS-16": ["Eddy-Odero"],
    "ISS-17": ["Eddy-Odero"],
    "ISS-18": ["atienosharzy-boop"],
    "ISS-19": ["atienosharzy-boop"],
    "ISS-20": ["paowuor"],
    "ISS-21": ["carsonak"],
    "ISS-22": ["carsonak"],
}

COMPLETED_ISSUES = {"ISS-01", "ISS-02"}


RAW_ISSUES: List[Dict[str, Any]] = [
    {
        "order": 1,
        "id": "ISS-01",
        "slug": "01-monorepo-scaffolding-and-shared-contracts",
        "title": "[ISS-01] Monorepo Scaffolding & Immutable Phase 0 Shared Contracts",
        "status": "completed",
        "phase": "Phase 1 (Hours 0-2) — Completed",
        "preferred_role": "Fullstack / QA Lead (@carsonak)",
        "estimated_minutes": 45,
        "labels": [
            "phase:1",
            "area:architecture",
            "area:contracts",
            "area:backend",
            "area:frontend",
            "role:dev-1",
            "role:dev-4",
        ],
        "blocked_by": [],
        "summary": (
            "Initialize the `/backend` (Python 3.11+ / FastAPI) and `/frontend` (React + TypeScript + Vite) "
            "monorepo structure and lock in the Phase 0 shared schemas (`SkyPatchManifest`, `CatalogsResponse`, "
            "`KnownCelestialObject` with multi-epoch positions and `default_checked`, `TracedObjectSummary` with "
            "backward/forward `waypoints`, overlapped-body branches, and colored tracking squares, `SpectrumPayload`, "
            "`EarthToSkyResponse` with random capital city fallback, and `SkyExplorerContextValue` with pan/zoom)."
        ),
        "architectural_context": (
            "All 5 developers build in parallel against the immutable contracts defined in "
            "`plans/phase_0_master_architecture_shared_contracts.md`. This foundation issue is **completed**, "
            "unblocking all Phase 2 backend and frontend workstreams immediately."
        ),
        "files_to_touch": [
            "backend/pyproject.toml",
            "backend/requirements.txt",
            "backend/app/models/contracts.py",
            "backend/app/main.py",
            "backend/tests/test_contracts_and_api.py",
            "frontend/package.json",
            "frontend/tsconfig.json",
            "frontend/vite.config.ts",
            "frontend/src/types/contracts.ts",
            "frontend/src/context/SkyExplorerContext.tsx",
        ],
        "implementation_steps": [
            "Define backend contract models and JSON Schemas in `backend/app/models/contracts.py` covering `SkyPatchManifest`, `CatalogsResponse`, `KnownCelestialObject` (`object_id`, `label`, `catalog`, `object_type`, `default_checked`, `epoch_positions`), `SpectrumPayload`, `EarthToSkyResponse` (including `WORLD_CAPITAL_CITIES` and `is_fallback_capital`), and binary buffer validators (`Float32`, `Float16`, `Uint8`).",
            "Expose `/health` and contract-validated endpoints in `backend/app/main.py`.",
            "Define TypeScript interfaces in `frontend/src/types/contracts.ts` including `ViewportRenderSettings` (`checkedObjectIds`, `zoom`, `panX`, `panY`), `TracedWaypoint` (`status`, `visible`), `TracedObjectSummary` (`trackId`, `color`, `isOverlappedAtOrigin`, `originEpochIndex`, `waypoints`, `lostEpochIds`), and `SkyExplorerContextValue` (`trackedTargets`, `removeTrackedTarget`, `clearTrackedTargets`, `setViewportZoomPan`, `resetViewportZoomPan`, `inspectPixelOrCoord`).",
            "Create `SkyExplorerProvider` in `frontend/src/context/SkyExplorerContext.tsx` with non-looping default playback (`isLooping: false`).",
        ],
        "acceptance_criteria": [
            "`GET /health` returns `200 OK` with `{\"status\": \"ok\", \"service\": \"star-hunters-backend\", \"version\": \"0.1.0\"}`.",
            "Sample payloads for all 6 showcase targets pass both backend schema validation and frontend TypeScript contract tests.",
            "`KnownCelestialObject` includes `default_checked: boolean` and `epoch_positions: KnownObjectEpochPosition[]`.",
            "`TracedObjectSummary` includes `originEpochIndex`, `color`, `isOverlappedAtOrigin`, and `waypoints: TracedWaypoint[]` for backward/forward frame tracking.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 2,
        "id": "ISS-02",
        "slug": "02-synthetic-preset-generator-and-fixtures",
        "title": "[ISS-02] Deterministic Synthetic Preset Generator for 6 Showcase Targets",
        "status": "completed",
        "phase": "Phase 1 (Hours 0-2) — Completed",
        "preferred_role": "Fullstack / QA Lead (@carsonak)",
        "estimated_minutes": 45,
        "labels": [
            "phase:1",
            "area:presets",
            "area:spherex-pipeline",
            "area:contracts",
            "role:dev-2",
        ],
        "blocked_by": [],
        "summary": (
            "Generate deterministic, contract-compliant static preset bundles (`manifest.json`, `pass_1.bin`, "
            "`pass_2.bin`, `pass_1_flags.bin`, `pass_2_flags.bin`, `spectrum.json`) in `frontend/public/presets/{slug}/` "
            "for all 6 benchmark targets (`wise_0855`, `barnards_star`, `epsilon_indi_b`, `rw_aurigae`, `r_draconis`, "
            "`comet_3i_atlas`) so Frontend Devs are unblocked immediately."
        ),
        "architectural_context": (
            "Live NASA IRSA downloads take time to build and run. Having static binary and JSON bundles in "
            "`frontend/public/presets/{slug}/` (now **completed**) lets Frontend engineers build and test 60 FPS pixel math, "
            "known-object checkbox filtering, backward/forward click-to-track, pan/zoom, and the 102-band spectral plot immediately."
        ),
        "files_to_touch": [
            "scripts/generate_synthetic_presets.py",
            "frontend/public/presets/wise_0855/manifest.json",
            "frontend/public/presets/barnards_star/manifest.json",
            "frontend/public/presets/epsilon_indi_b/manifest.json",
            "frontend/public/presets/rw_aurigae/manifest.json",
            "frontend/public/presets/r_draconis/manifest.json",
            "frontend/public/presets/comet_3i_atlas/manifest.json",
        ],
        "implementation_steps": [
            "Implement `scripts/generate_synthetic_presets.py` to generate 6 target folders under `frontend/public/presets/`.",
            "Place stationary background stars at identical `(x, y)` coordinates across `pass_1.bin` and `pass_2.bin` so `Pass B - Pass A` subtraction cancels them cleanly.",
            "Encode each target's signature astrophysical behavior: shifting infrared PSFs in Detectors 5-6 for `wise_0855`, all-detector high-PM shift for `barnards_star`, stationary flux change for `rw_aurigae` and `r_draconis`, and MOST solar system movement for `comet_3i_atlas`.",
            "Populate `catalog_overlays.known_objects` with multi-epoch `epoch_positions`, setting `default_checked: true` for the primary moving/variable target and `default_checked: false` for stationary field stars.",
        ],
        "acceptance_criteria": [
            "Running `python3 scripts/generate_synthetic_presets.py` creates all 6 preset folders under `frontend/public/presets/`.",
            "Every `pass_{N}.bin` is exactly `1,572,864` bytes (`Float32Array` of shape `(6, 256, 256)`) with zero `NaN`/`Inf` values.",
            "Every `pass_{N}_flags.bin` is exactly `65,536` bytes (`Uint8Array` of shape `(256, 256)`).",
            "Every `manifest.json` and `spectrum.json` passes `validate_sky_patch_manifest` and `validate_spectrum_payload`.",
        ],
        "verification_commands": [
            "python3 scripts/generate_synthetic_presets.py",
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 3,
        "id": "ISS-03",
        "slug": "03-quantized-sqlite-spatial-cache-lru",
        "title": "[ISS-03] Quantized SQLite Spatial Cache (0.05° Grid, WAL Mode, Capital City Cache & Automatic LRU Pruning)",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend Lead (@14Emanuel)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:backend",
            "area:caching-3g",
            "area:database",
            "role:dev-1",
        ],
        "blocked_by": [],
        "summary": (
            "Implement the Tier-1 backend spatial cache in SQLite (`WAL` mode) keyed by a quantized `0.05°` "
            "(`3 arcmin`) spatial grid (`ra{ra:.2f}_dec{dec:.2f}_fov{fov:.1f}`) to persist preprocessed manifests, "
            "zlib-compressed binary detector/flag buffers, asynchronous catalog overlays, spectra, and fallback "
            "capital city Zenith lookups with automatic LRU size-cap eviction."
        ),
        "architectural_context": (
            "Supports the 3G-Optimised Two-Tier Caching architecture: heavy FITS preprocessing (`ZODI` subtraction, "
            "WCS alignment, catalog queries, and fallback capital city Zenith sky patches) happens once on the backend "
            "and is stored in SQLite so repeat or nearby queries resolve in `<20 ms` while staying strictly within "
            "the Fly.io persistent volume limit."
        ),
        "files_to_touch": [
            "backend/app/services/spatial_cache.py",
            "backend/tests/test_contracts_and_api.py",
        ],
        "implementation_steps": [
            "Implement `compute_grid_key(ra, dec, fov_arcmin, grid_step_deg=0.05)` normalizing RA into `[0, 360)` and clamping Dec into `[-90, 90]`.",
            "Configure SQLite in `WAL` mode (`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`) with tables `sky_patches`, `binary_frames` (`ON DELETE CASCADE`), `spectra_cache`, and `capital_zenith_cache`.",
            "Compress binary frames with `zlib` inside `binary_frames` and update `last_accessed` timestamps on reads.",
            "Implement `_prune_if_needed` to evict the oldest `last_accessed` sky patches whenever `SUM(byte_size) > MAX_CACHE_BYTES` (default 750 MB).",
        ],
        "acceptance_criteria": [
            "Two queries within `0.02°` of each other map to the exact same `grid_key` and return `query.cached = true` on the second lookup in `<20 ms`.",
            "Capital city Zenith lookups and their sky patches are persisted and retrieved from SQLite (`earth.cached = true`).",
            "Exceeding `max_cache_bytes` automatically evicts the least-recently-accessed patches and cascades deletion to `binary_frames`.",
            "All database connections close cleanly without `ResourceWarning`.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 4,
        "id": "ISS-04",
        "slug": "04-spherex-irsa-cutout-ingestion-zodi-flags",
        "title": "[ISS-04] SPHEREx IRSA Cutout Ingestion, IMAGE - ZODI Cleaning & 8-Bit FLAGS Hygiene Mask",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend — Science & Spectral Pipeline (@paowuor)",
        "estimated_minutes": 75,
        "labels": [
            "phase:2",
            "area:backend",
            "area:spherex-pipeline",
            "area:astronomy",
            "role:dev-2",
        ],
        "blocked_by": [],
        "summary": (
            "Query NASA/IPAC IRSA CAOM-2 TAP (`spherex.artifact` + `spherex.plane`) for SPHEREx Level 2 MEF cutouts "
            "covering `(ra, dec, fov_arcmin)`, subtract the `ZODI` zodiacal dust model from `IMAGE`, and map the 32-bit "
            "`FLAGS` extension into the 8-bit web hygiene bitmask."
        ),
        "architectural_context": (
            "Raw SPHEREx infrared exposures are dominated by zodiacal light foreground (`ZODI`) and contain cosmic rays, "
            "saturated cores, and bad reference pixels tracked in `FLAGS`. Performing `IMAGE - ZODI` subtraction and "
            "bitmask extraction on the backend ensures clean, calibrated `MJy/sr` frames for the frontend."
        ),
        "files_to_touch": [
            "backend/app/services/spherex_ingest.py",
            "backend/tests/test_spherex_ingest.py",
        ],
        "implementation_steps": [
            "Build an ADQL query against `https://irsa.ipac.caltech.edu/TAP` joining `spherex.artifact` and `spherex.plane` where `1 = CONTAINS(POINT('ICRS', ra, dec), p.poly)` for bandpasses `SPHEREx-D1`..`SPHEREx-D6`.",
            "Download spatial cutouts using `https://irsa.ipac.caltech.edu/{uri}?center={ra},{dec}d&size={fov_deg}` with async HTTP timeouts and automatic fallback to synthetic/cached fixtures if IRSA is unreachable.",
            "Compute cleaned surface brightness `clean_image = HDU['IMAGE'].data - HDU['ZODI'].data` (`MJy/sr`) and extract `HDU['VARIANCE'].data` and `MJD-OBS`.",
            "Map the 32-bit SPHEREx `FLAGS` bitmask into the 8-bit web hygiene mask: Bit 0 (`1`) Transient/Cosmic Ray, Bit 1 (`2`) Saturated, Bit 2 (`4`) Dead/Bad Reference, Bit 3 (`8`) Stray Light/Border.",
        ],
        "acceptance_criteria": [
            "Given a SPHEREx MEF cutout (or test fixture FITS), produces finite `IMAGE - ZODI` arrays, variance maps, observation MJD, and 8-bit `uint8` flag masks.",
            "Corrupted or `NaN` pixels are masked in the variance weight map and flagged in Bit 2 (`4`).",
            "Closes FITS HDU lists immediately after reading to keep peak RAM below 600 MB.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 5,
        "id": "ISS-05",
        "slug": "05-earth-to-sky-zenith-coordinate-bridge",
        "title": "[ISS-05] Earth-to-Sky Zenith Coordinate Bridge, Random Capital City Fallback & SQLite Caching",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend Lead (@14Emanuel)",
        "estimated_minutes": 45,
        "labels": [
            "phase:2",
            "area:backend",
            "area:multi-mission",
            "area:astronomy",
            "area:caching-3g",
            "role:dev-1",
            "role:dev-3",
        ],
        "blocked_by": [],
        "summary": (
            "Implement the Earth-to-Sky Zenith coordinate transformer that converts any geographic `(lat, lon)` "
            "and UTC `iso_time` into the exact overhead `ICRS` celestial coordinates `(ra, dec)` and host constellation "
            "to power the \"What's Above Me?\" discovery workflow — automatically picking a **random world capital city** "
            "when user location data is unavailable and caching capital city Zenith lookups and sky patches in the backend."
        ),
        "architectural_context": (
            "Everyday users can click \"Use My Location\" to explore the infrared sky directly above their head right now. "
            "If the user's geolocation permission is denied or unavailable (or `lat`/`lon` are omitted), the backend "
            "selects a random capital city from `WORLD_CAPITAL_CITIES`, returns `city_name`, `country`, and "
            "`is_fallback_capital: true`, and caches the capital city's Zenith lookup and overhead sky patch in SQLite."
        ),
        "files_to_touch": [
            "backend/app/services/zenith_bridge.py",
            "backend/app/main.py",
            "backend/app/models/contracts.py",
            "backend/tests/test_contracts_and_api.py",
        ],
        "implementation_steps": [
            "Use `astropy.coordinates` (`EarthLocation`, `AltAz(alt=90*u.deg, az=0*u.deg)`, `.transform_to(ICRS())`, `get_constellation`) when `astropy` is installed, with accurate GMST/LST sidereal fallback.",
            "When `lat` or `lon` is omitted (`None`), pick a random capital city from `WORLD_CAPITAL_CITIES` (`pick_random_capital_city`) and populate `city_name`, `country`, and `is_fallback_capital: true` in `EarthToSkyResponse.earth`.",
            "Default `iso_time` to current UTC when omitted and validate `lat in [-90, 90]` and `lon in [-180, 180]` when provided.",
            "Cache capital city Zenith lookups in `SpatialSqliteCache` (`capital_zenith_cache`) and pre-warm/cache the corresponding overhead sky patch in `sky_patches`.",
        ],
        "acceptance_criteria": [
            "Shifting longitude by `+15.0°` at a fixed UTC timestamp shifts the returned Zenith `ra` by `+15.0°` (mod 360°).",
            "Calling `compute_zenith_icrs` or `/api/v1/earth-to-sky` without `lat`/`lon` picks a random capital city from `WORLD_CAPITAL_CITIES` with `is_fallback_capital: true` and non-empty `city_name` and `country`, and caches its sky patch in SQLite.",
            "Out-of-range latitude (`>90` or `<-90`) or longitude (`>180` or `<-180`) raises a `400 Bad Request` validation error.",
            "Response validates cleanly against `EARTH_TO_SKY_JSON_SCHEMA`.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 6,
        "id": "ISS-06",
        "slug": "06-async-multi-mission-catalog-queries",
        "title": "[ISS-06] Asynchronous Multi-Mission Catalog Queries (Gaia DR3, WISE & NASA MOST)",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend Lead (@14Emanuel)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:backend",
            "area:multi-mission",
            "area:catalogs",
            "role:dev-1",
            "role:dev-3",
        ],
        "blocked_by": [],
        "summary": (
            "Query ESA Gaia DR3 (`gaiadr3.gaia_source`), IRSA AllWISE/NEOWISE (`allwise_p3as_psd`), and NASA's "
            "MOST Solar System service asynchronously in parallel (`asyncio.gather` with per-service timeouts) "
            "and project catalog `(ra, dec)` coordinates onto the `256x256` TAN WCS pixel grid `(x, y)`."
        ),
        "architectural_context": (
            "Decoupling fast catalog queries (`~1-2 s`) from heavier FITS cutout processing (`15-35 s` cold) allows "
            "the frontend to immediately populate known objects and sky map overlays while cutouts are still resolving."
        ),
        "files_to_touch": [
            "backend/app/services/catalog_queries.py",
            "backend/tests/test_catalog_queries.py",
        ],
        "implementation_steps": [
            "Implement async cone-search queries for Gaia DR3 (`phot_g_mean_mag < 20.5`, returning `source_id, ra, dec, g_mag, bp_rp, pmra, pmdec`), WISE (`source_id, ra, dec, w1mpro, w2mpro`), and NASA MOST (`object_name, ra, dec, v_mag`).",
            "Project every catalog entry's `(ra, dec)` onto the shared `256x256` TAN WCS header so the patch center maps to `(128.0, 128.0)`.",
            "Enforce a strict `3.0 s` per-archive timeout using `asyncio.wait_for` so a slow external TAP archive degrades gracefully without failing the request.",
        ],
        "acceptance_criteria": [
            "Concurrent queries return validated `gaia_dr3`, `wise_sources`, and `most_solar_system` arrays with accurate `(x, y)` pixel coordinates on the `256x256` grid.",
            "Simulated timeout or failure on any single archive still returns the remaining archives without raising an unhandled exception.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 7,
        "id": "ISS-07",
        "slug": "07-known-object-epoch-tracker-and-ranking",
        "title": "[ISS-07] Backend Known-Object Multi-Epoch Trajectory Propagator & Default Notable Ranking",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Fullstack (@Eddy-Odero)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:backend",
            "area:multi-mission",
            "area:known-objects",
            "role:dev-3",
        ],
        "blocked_by": ["ISS-06"],
        "summary": (
            "Synthesize raw Gaia DR3, WISE, and NASA MOST catalog sources into the unified `catalog_overlays.known_objects` "
            "list (`KnownCelestialObject[]`), propagating each known object's coordinates across all patch epochs "
            "(`epoch_positions`) and ranking notable/moving objects (`default_checked: true`) vs. stationary field stars "
            "(`default_checked: false`)."
        ),
        "architectural_context": (
            "Powers the Known Celestial Objects Checkbox UI: the backend tracks known objects across frames asynchronously "
            "and flags only notable/moving objects as `default_checked: true` so the initial viewport highlights key movers "
            "with low visual clutter while allowing the user to Check All / Uncheck All or toggle individual objects."
        ),
        "files_to_touch": [
            "backend/app/services/known_objects_tracker.py",
            "backend/app/main.py",
            "backend/tests/test_contracts_and_api.py",
        ],
        "implementation_steps": [
            "Cross-match WISE sources against Gaia DR3 within `2.5 arcsec` to classify optical+IR stars vs. infrared-only brown dwarf candidates (`w1_w2_color >= 0.8` without a bright optical counterpart).",
            "For every object, compute `epoch_positions: KnownObjectEpochPosition[]` (`epoch_id, mjd, ra, dec, x, y`) across each epoch in `epochs` by propagating Gaia proper motions (`pmra`, `pmdec` from J2016.0 to epoch MJD) or MOST ephemeris positions.",
            "Set `default_checked = True` for notable targets (MOST Solar System movers, high proper motion stars `>= 0.15 arcsec/yr`, brown dwarf candidates, or the patch's central target, capped to top 8 objects) and `default_checked = False` for stationary field stars.",
        ],
        "acceptance_criteria": [
            "Every `KnownCelestialObject` in `catalog_overlays.known_objects` has an `epoch_positions` entry for every epoch in `manifest.epochs`.",
            "High proper-motion stars (e.g. Barnard's Star) and WISE 0855 have distinct `(x, y)` coordinates across epochs matching their proper motion vector.",
            "Notable movers have `default_checked: true` while stationary background stars have `default_checked: false`.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 8,
        "id": "ISS-08",
        "slug": "08-adaptive-epoch-clustering-and-wcs-coadd",
        "title": "[ISS-08] Adaptive Epoch Clustering & 6-Detector 256x256 TAN WCS Co-Addition",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend — Science & Spectral Pipeline (@paowuor)",
        "estimated_minutes": 75,
        "labels": [
            "phase:2",
            "area:backend",
            "area:spherex-pipeline",
            "area:wcs",
            "role:dev-2",
        ],
        "blocked_by": ["ISS-04"],
        "summary": (
            "Cluster cleaned SPHEREx exposures by observation timestamp (`MJD`) into distinct comparison epochs "
            "and reproject/co-add all exposures per detector (`1..6`) onto the shared `256x256` tangential (`TAN`) "
            "WCS grid using inverse-variance weighting."
        ),
        "architectural_context": (
            "Client-side pass subtraction (`Pass B - Pass A`) and multi-frame tracking require every detector plane "
            "(`0..5`) and every epoch (`pass_1`, `pass_2`, ...) to share an identical `256x256` WCS pixel grid so "
            "stationary stars align to `<0.5 px`."
        ),
        "files_to_touch": [
            "backend/app/services/spherex_coadd.py",
            "backend/tests/test_spherex_coadd.py",
        ],
        "implementation_steps": [
            "Implement adaptive MJD clustering: group into 6-month survey passes when `delta_mjd > 60 days`; split into earliest vs. latest clusters when `1 <= delta_mjd <= 60 days`; flag `needs_wise_fallback = True` when `<2` epochs exist.",
            "Construct the canonical `256x256` TAN WCS header centered on `(ra, dec)` with pixel scale `fov_deg / 256`.",
            "Reproject cleaned detector cutouts onto the target WCS grid and combine via inverse-variance weighting `w_k = 1 / variance_k` (excluding pixels with hygiene flag bits set).",
            "Pack each epoch into a contiguous `(6, 256, 256)` little-endian `float32` buffer (`1,572,864` bytes) and `(256, 256)` `uint8` flags buffer (`65,536` bytes), replacing any residual `NaN`/`Inf` with `0.0`.",
        ],
        "acceptance_criteria": [
            "Outputs `1,572,864`-byte `float32` detector buffers and `65,536`-byte `uint8` flag buffers with zero `NaN` or `Inf` values.",
            "Stationary sources align to within `<0.5 pixels` across epochs on the shared `256x256` WCS grid.",
            "Correctly sets `has_multi_epoch_spherex` and `baseline_days` in `data_source_summary`.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 9,
        "id": "ISS-09",
        "slug": "09-spherex-102-band-forced-photometry-spectrum",
        "title": "[ISS-09] On-the-Fly 102-Band Forced Photometry & Molecular Feature Extractor",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend — Science & Spectral Pipeline (@paowuor)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:backend",
            "area:spherex-pipeline",
            "area:spectrophotometry",
            "role:dev-2",
        ],
        "blocked_by": ["ISS-04"],
        "summary": (
            "Extract a 102-channel near-infrared spectrum (`0.75-5.0 um`) at any clicked sky coordinate `(ra, dec)` "
            "via circular aperture photometry with local background annulus subtraction and annotate the 4 key "
            "molecular absorption/emission bands (`H2O`, `CH4`, `CO2`, `CO`)."
        ),
        "architectural_context": (
            "When a user clicks an object in the viewport, the Scientist Drawer displays its 102-channel SPHEREx "
            "spectrum (`GET /api/v1/spectrum?ra=...&dec=...`) to distinguish ultra-cold brown dwarfs (`H2O`/`CH4` troughs), "
            "comets (`H2O`/`CO2` emission), and stars."
        ),
        "files_to_touch": [
            "backend/app/services/spectrum_extractor.py",
            "backend/app/main.py",
            "backend/tests/test_contracts_and_api.py",
        ],
        "implementation_steps": [
            "Perform circular aperture photometry (`r = 2.5 px`) with local background annulus subtraction (`r_in = 5 px, r_out = 8 px`) across available SPHEREx Linear Variable Filter sub-exposures (`WCS-WAVE`) or detector bands.",
            "Sort all 102 channels monotonically by `wavelength_um` (`0.75` to `5.00 um`) with finite `flux` (`MJy/sr`), `variance`, and `flagged` status.",
            "Include the 4 standard `molecular_features` (`H2O` `2.95-3.30 um`, `CH4` `3.20-3.55 um`, `CO2` `4.20-4.35 um`, `CO` `4.55-4.80 um`).",
        ],
        "acceptance_criteria": [
            "Returns a valid `SpectrumPayload` with 102 monotonically increasing wavelength channels (`0.75-5.00 um`).",
            "All `flux` and `variance` values are finite numbers (`variance >= 0`).",
            "Includes all 4 diagnostic molecular feature ranges (`H2O`, `CH4`, `CO2`, `CO`).",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 10,
        "id": "ISS-10",
        "slug": "10-client-two-tier-cache-indexeddb-float16",
        "title": "[ISS-10] 3G-Optimised Two-Tier Client Cache (Memory + IndexedDB) & Float16/Float32 Decoder",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Frontend Lead (@atienosharzy-boop)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:caching-3g",
            "area:pixel-engine",
            "role:dev-4",
        ],
        "blocked_by": [],
        "summary": (
            "Implement the frontend Two-Tier Cache (`in-memory Map` + persistent browser `IndexedDB` "
            "`star_hunters_patch_cache_v1`) and IEEE-754 `Float16`/`Float32` binary frame decoder so raw sky patch "
            "data is downloaded once over 3G and cached locally in the browser for all client-side calculations."
        ),
        "architectural_context": (
            "Directly fulfills the 3G-Optimised Two-Tier Caching requirement: the backend sends compact compressed "
            "raw binary frames (`Float16`/`Float32`) and catalog DTOs once, and the frontend caches them in Memory + "
            "IndexedDB so changing epoch combinations, wavelengths, pan/zoom, or object checkboxes never triggers extra network calls."
        ),
        "files_to_touch": [
            "frontend/src/services/clientPatchCache.ts",
            "frontend/src/types/contracts.ts",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "Implement `decodeFloat16Word` and `decodeDetectorBinaryBuffer(buffer, dtype)` in `frontend/src/types/contracts.ts` supporting both `float32` (`1,572,864` B) and 3G-optimised `float16` (`786,432` B) wire buffers, returning 6 `Float32Array` detector planes of `256x256`.",
            "Implement `ClientPatchCache` in `frontend/src/services/clientPatchCache.ts` with an in-memory LRU `Map` backed by browser `IndexedDB` (`star_hunters_patch_cache_v1`) stores `sky_patches` and `catalogs`.",
            "Ensure graceful fallback to in-memory caching when running in headless/Node test environments where `indexedDB` is absent.",
        ],
        "acceptance_criteria": [
            "`decodeDetectorBinaryBuffer` accurately decodes both `786,432`-byte `float16` buffers and `1,572,864`-byte `float32` buffers into `Float32Array[6]`.",
            "`ClientPatchCache` returns cached sky patches in `<5 ms` and evicts the least-recently-used entry when capacity is exceeded.",
            "Zero network requests are made when retrieving a previously cached `grid_key` or `preset:{slug}`.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 11,
        "id": "ISS-11",
        "slug": "11-client-60fps-pixel-math-wavelength-engine",
        "title": "[ISS-11] Client-Side 60 FPS Pixel Math (Blink, Subtract, Co-Add) & Wavelength \"Dim & Pop\" Engine",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Frontend Lead (@atienosharzy-boop)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:pixel-engine",
            "area:caching-3g",
            "role:dev-4",
        ],
        "blocked_by": ["ISS-10"],
        "summary": (
            "Build the pure client-side 60 FPS pixel engine (`frontend/src/utils/pixelEngine.ts`) that combines cached "
            "epochs (`blink`, `subtract` `Pass B - Pass A`, `coadd`), applies dynamic wavelength \"Dim & Pop\" filtering "
            "(`0.75-5.0 um` mapped to RGB channels), applies contrast stretch (`asinh`, `linear`, `zscale`), and "
            "renders a `256x256` `ImageData` buffer in `<5 ms` with zero network calls."
        ),
        "architectural_context": (
            "All frequently changing user-configurable options—combining different epochs (blink, pass subtraction, "
            "co-addition), wavelength colorization, and contrast stretch—must be calculated on the client from cached "
            "raw binary buffers without refetching from the backend."
        ),
        "files_to_touch": [
            "frontend/src/utils/pixelEngine.ts",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "Implement epoch combination modes over `epochBuffers`: `blink` (`activeEpochIndex`), `subtract` (`Pass B - Pass A` for any chosen `passAIndex`, `passBIndex`), and `coadd` (mean across `coaddIndices`).",
            "Weight Detectors `1..6` using `computeDetectorWeights(wavelengthRangeUm)` (keeping a 5% context floor on out-of-band detectors) and map `D1+D2 -> Blue`, `D3+D4 -> Green`, `D5+D6 -> Red`.",
            "In `subtract` mode, render positive residuals (`+Delta`) in warm orange/red and negative residuals (`-Delta`) in cool cyan/blue around a neutral dark background so moving dipoles are unmistakable.",
            "Support `asinh`, `linear`, and `zscale` contrast stretches and optional `showFlagsOverlay` magenta/amber pixel tinting for non-zero `flagsBuffers` bits.",
        ],
        "acceptance_criteria": [
            "Subtracting an epoch from itself (`passAIndex === passBIndex`) produces a uniform neutral background.",
            "Setting `wavelengthRangeUm` to `[3.8, 5.0]` dims short-wavelength stars (`D1-D3`) by `>=90%` while preserving cold brown dwarfs (`D5-D6`) at full intensity.",
            "Computing a `256x256` RGBA `Uint8ClampedArray` frame completes in `<5 ms`.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 12,
        "id": "ISS-12",
        "slug": "12-wise-neowise-archival-cutout-fallback",
        "title": "[ISS-12] WISE/NEOWISE (W1/W2) Archival Cutout Fallback, Cross-Mission WCS Reprojection & Capital City Patch Caching",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend — Science & Multi-Mission Pipeline (@paowuor)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:backend",
            "area:multi-mission",
            "area:wcs",
            "area:caching-3g",
            "role:dev-2",
            "role:dev-3",
        ],
        "blocked_by": ["ISS-08"],
        "summary": (
            "Fetch archival WISE/NEOWISE (`W1 3.4 um` and `W2 4.6 um`) image cutouts from IRSA and reproject them "
            "onto the shared `256x256` TAN WCS grid whenever a queried sky coordinate has fewer than 2 SPHEREx passes, "
            "and cache fallback **world capital city** sky patches in the backend SQLite cache."
        ),
        "architectural_context": (
            "Guarantees multi-epoch infrared resiliency across the entire sky: if a user clicks \"What's Above Me?\" "
            "at a coordinate where SPHEREx has only 1 pass (or 0 passes) — or when the user's location data is not "
            "available and the system picks a random capital city (`WORLD_CAPITAL_CITIES`) — pairing with archival "
            "WISE `W1/W2` provides a 10-15 year baseline in the exact same `(6, 256, 256)` binary format, and caching "
            "these capital city sky patches in the backend SQLite cache makes fallback discovery instantaneous."
        ),
        "files_to_touch": [
            "backend/app/services/wise_fallback.py",
            "backend/app/main.py",
            "backend/tests/test_wise_fallback.py",
        ],
        "implementation_steps": [
            "Query IRSA SIA / WISE Image Atlas for calibrated `W1` (`3.4 um`) and `W2` (`4.6 um`) cutouts covering `(ra, dec, fov_arcmin)`.",
            "Reproject `W1` and `W2` onto the shared `256x256` TAN WCS header from `ISS-08` and convert units to surface brightness (`MJy/sr`).",
            "Map `W1` into Plane `3` (Detector 4: `2.42-3.80 um`) and `W2` into Planes `4` and `5` (Detectors 5-6: `3.80-5.00 um`) of the `(6, 256, 256)` `float32` buffer, setting `mission: \"WISE\"`, `available_detectors: [4, 5, 6]`, and `uses_wise_fallback: true`.",
            "When a user's location data is unavailable and `/api/v1/earth-to-sky` selects a random capital city from `WORLD_CAPITAL_CITIES`, pre-warm and cache that capital city's multi-epoch SPHEREx/WISE sky patch in the backend SQLite cache (`SpatialSqliteCache`).",
        ],
        "acceptance_criteria": [
            "Produces valid `1,572,864`-byte `(6, 256, 256)` `float32` buffers with non-zero calibrated flux in Detector Planes `3, 4, 5` and `available_detectors = [4, 5, 6]`.",
            "Updates `data_source_summary.uses_wise_fallback = True` and calculates the multi-year `baseline_days` between WISE and SPHEREx epochs.",
            "Fallback random capital city lookups automatically cache both the Zenith response and the overhead sky patch in the backend SQLite cache.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 13,
        "id": "ISS-13",
        "slug": "13-fastapi-progressive-endpoints-3g-streaming",
        "title": "[ISS-13] FastAPI Progressive Endpoints, GZip Float16/Float32 Binary Streaming & Cache-Control",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend Lead (@14Emanuel)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:backend",
            "area:api",
            "area:caching-3g",
            "role:dev-1",
        ],
        "blocked_by": [
            "ISS-03",
            "ISS-05",
            "ISS-06",
            "ISS-07",
            "ISS-08",
            "ISS-09",
            "ISS-12",
        ],
        "summary": (
            "Wire all Phase 0 REST endpoints (`/api/v1/catalogs`, `/api/v1/sky-patch`, `/api/v1/frames/{grid_key}/{filename}`, "
            "`/api/v1/spectrum`, `/api/v1/earth-to-sky`, `/api/v1/admin/clear-cache`) in FastAPI with SQLite cache "
            "orchestration, `GZipMiddleware`, `?precision=float16|float32` 3G binary streaming, and strong HTTP "
            "`Cache-Control` headers."
        ),
        "architectural_context": (
            "Connects the SQLite spatial cache (`ISS-03`) with the SPHEREx pipeline (`ISS-04`, `ISS-08`, `ISS-09`) and "
            "WISE/Gaia/MOST/Zenith services (`ISS-05`, `ISS-06`, `ISS-07`, `ISS-12`), delivering compact, immutable "
            "binary frames and fast asynchronous catalog responses to the frontend."
        ),
        "files_to_touch": [
            "backend/app/main.py",
            "backend/tests/test_contracts_and_api.py",
        ],
        "implementation_steps": [
            "Wire `GET /api/v1/catalogs` to return `CatalogsResponse` (`query`, `wcs`, `catalog_overlays` with `known_objects`) within `<=3.5 s` with `Cache-Control: public, max-age=3600`.",
            "Wire `GET /api/v1/sky-patch` to check `SpatialSqliteCache` first, orchestrating SPHEREx + WISE fallback + known-object tracking on cache miss and persisting the result.",
            "Wire `GET /api/v1/frames/{grid_key}/{filename}?precision=float32|float16` to stream binary frames with `X-Binary-Dtype: float32|float16|uint8`, `GZipMiddleware`, and `Cache-Control: public, max-age=31536000, immutable`.",
            "Wire `GET /api/v1/spectrum`, `GET /api/v1/earth-to-sky` (supporting optional `lat`/`lon` with random capital city fallback and SQLite caching), and `POST /api/v1/admin/clear-cache` (protected by `X-Admin-Token`).",
        ],
        "acceptance_criteria": [
            "All `/api/v1/*` endpoints return payloads passing Phase 0 JSON Schema and byte-length validation.",
            "`GET /api/v1/frames/{grid_key}/pass_1.bin?precision=float16` returns `786,432` bytes (`50%` smaller than `float32`) with header `X-Binary-Dtype: float16` and `Cache-Control: public, max-age=31536000, immutable`.",
            "`POST /api/v1/admin/clear-cache` returns `403` without a valid `X-Admin-Token` and `200` when valid.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 14,
        "id": "ISS-14",
        "slug": "14-aladin-lite-v3-sky-map-and-url-sync",
        "title": "[ISS-14] Aladin Lite v3 Global Sky Map Synchronization & Shareable URL Query State",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Frontend Lead (@atienosharzy-boop)",
        "estimated_minutes": 45,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:sky-map",
            "area:ui-ux",
            "role:dev-4",
        ],
        "blocked_by": [],
        "summary": (
            "Embed an interactive CDS Aladin Lite v3 wide-field sky map synchronized with `SkyExplorerContext.coordinates` "
            "(showing the `5'x5'` SPHEREx patch reticle) and synchronize browser URL query parameters "
            "(`?target=...&ra=...&dec=...&fov=...&mode=...&wlMin=...&wlMax=...`) via `history.replaceState`."
        ),
        "architectural_context": (
            "Provides immediate wide-field astronomical context (`Stage A` of progressive loading) when panning to any "
            "`(RA, Dec)` or clicking \"What's Above Me?\", and lets users share discoveries via a single URL."
        ),
        "files_to_touch": [
            "frontend/src/components/AladinSkyMap.tsx",
            "frontend/src/utils/urlStateSync.ts",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "Build `urlStateSync.ts` (`parseUrlState`, `serializeUrlState`) to read and update `?target`, `?ra`, `?dec`, `?fov`, `?mode`, `?wlMin`, and `?wlMax` without triggering page reloads.",
            "Build `AladinSkyMap.tsx` that loads CDS Aladin Lite v3 (with an interactive SVG wide-field reticle fallback when offline), pans immediately on `coordinates` updates, and invokes `navigateToCoordinates(ra, dec)` when the user clicks a new sky region.",
        ],
        "acceptance_criteria": [
            "Parsing `?ra=269.4521&dec=4.6934&mode=subtract&wlMin=3.8&wlMax=5.0` initializes the exact coordinates, comparison mode, and wavelength filter.",
            "Changing presets or coordinates updates the Aladin reticle position and browser query string.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 15,
        "id": "ISS-15",
        "slug": "15-app-shell-target-tour-and-zenith-ui",
        "title": "[ISS-15] Application Shell, 6-Target Tour Carousel & \"What's Above Me?\" Zenith Discovery Flow (with Random Capital City Fallback)",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Fullstack (@Eddy-Odero)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:ui-ux",
            "area:discovery-flow",
            "role:dev-5",
        ],
        "blocked_by": [],
        "summary": (
            "Design and build the dark-room astronomical application shell, the 6-Target Showcase Tour selector with "
            "plain-English discovery guides, the \"What's Above Me?\" Earth-to-Sky Zenith modal/bar (Geolocation API + "
            "automatic **random capital city fallback** when location data is unavailable + city presets + custom Lat/Lon), "
            "and the progressive/3G cache status banner."
        ),
        "architectural_context": (
            "Makes the application immediately intuitive for non-technical space enthusiasts while surfacing rich mission "
            "telemetry (`data_source_summary`, baseline days, fallback capital city indicator, and 3G browser cache hits) for scientists."
        ),
        "files_to_touch": [
            "frontend/src/components/TargetTourBar.tsx",
            "frontend/src/components/WhatsAboveMeBar.tsx",
            "frontend/src/App.tsx",
            "frontend/src/index.css",
        ],
        "implementation_steps": [
            "Build `TargetTourBar.tsx` with cards for all 6 showcase targets (`wise_0855`, `barnards_star`, `epsilon_indi_b`, `rw_aurigae`, `r_draconis`, `comet_3i_atlas`) showing category badges and \"What to look for\" tips.",
            "Build `WhatsAboveMeBar.tsx` supporting Browser Geolocation (`navigator.geolocation.getCurrentPosition`), automatic fallback to `/api/v1/earth-to-sky` (without `lat`/`lon`) when geolocation is unavailable or denied so the backend picks a cached random capital city (`is_fallback_capital: true`, `city_name`, `country`), quick city presets, and manual `(Lat, Lon)` input.",
            "Display `manifest.data_source_summary` (`status_note`, `baseline_days`, `uses_wise_fallback`), fallback capital city banner, and two-stage loading / browser-cache indicators in the header banner.",
        ],
        "acceptance_criteria": [
            "Clicking any of the 6 Target Tour cards selects the preset in `SkyExplorerContext` and displays its category and discovery guide.",
            "Submitting Earth `(Lat, Lon)` or clicking a city preset resolves the overhead Zenith `(RA, Dec, constellation)` and navigates the viewport.",
            "When user location data is unavailable or denied, clicking \"What's Above Me?\" automatically falls back to a random capital city from the backend and displays `city_name` and `country`.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 16,
        "id": "ISS-16",
        "slug": "16-viewport-controls-and-known-objects-checkbox-ui",
        "title": "[ISS-16] Viewport Controls Bar & Known Celestial Objects Checkbox UI (with Check All / Uncheck All)",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Fullstack (@Eddy-Odero)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:ui-ux",
            "area:known-objects",
            "area:caching-3g",
            "role:dev-5",
        ],
        "blocked_by": ["ISS-15"],
        "summary": (
            "Build the Viewport Controls Bar (Comparison Mode switcher, Pass A/B & Co-Add epoch selectors, Non-Looping "
            "Playback transport, Wavelength \"Dim & Pop\" dual slider + quick-filter pills, Contrast Stretch, Pan/Zoom buttons) "
            "AND the **Known Celestial Objects Checkbox Menu/Modal** with **Check All**, **Uncheck All**, and **Notable Only** "
            "buttons."
        ),
        "architectural_context": (
            "Directly implements User Review Addition #1 & #3: users get a checkbox list of all known celestial objects "
            "in the current view (with Check All / Uncheck All and low-noise defaults) to select which objects are "
            "highlighted and labeled on each image to track their movement, computed 100% client-side."
        ),
        "files_to_touch": [
            "frontend/src/components/ViewportControlsBar.tsx",
            "frontend/src/components/KnownObjectsCheckboxMenu.tsx",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "Build `ViewportControlsBar.tsx` with segmented controls for `blink`, `subtract` (including Pass A and Pass B epoch dropdowns), and `coadd` (epoch checkboxes), playback buttons (`Play/Pause`, `Step <`, `Step >`, FPS, `Loop` toggle defaulting to `false`), zoom controls (`Zoom In`, `Zoom Out`, `Reset 1x`), and wavelength range slider (`0.75-5.0 um`) with 4 quick-filter pills (`All Bands`, `Cold Objects / Planet X 3.8-5.0 um`, `H2O/CH4 Band 2.4-3.8 um`, `Hot Stars 0.75-2.4 um`).",
            "Build `KnownObjectsCheckboxMenu.tsx` displaying a dropdown/panel with a checkbox list of all `knownObjects` in the current view (`label`, `catalog` badge, `object_type`, `magnitude`, `proper_motion_arcsec_yr`).",
            "Wire **Check All** (`checkAllKnownObjects`), **Uncheck All** (`uncheckAllKnownObjects`), **Notable Movers Default** (`resetDefaultKnownObjects`), search/filter input, and individual object checkboxes (`toggleKnownObject(object_id)`).",
        ],
        "acceptance_criteria": [
            "Opening the Known Celestial Objects menu shows notable/moving objects checked by default (`default_checked: true`) and stationary background stars unchecked (`default_checked: false`).",
            "Clicking **Check All** checks every object in `knownObjects`; clicking **Uncheck All** clears `checkedObjectIds` to `[]`.",
            "Changing comparison modes, epoch pairs, wavelength pills, zoom/pan, or known-object checkboxes updates `SkyExplorerContext.renderSettings` immediately with zero network fetches.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 17,
        "id": "ISS-17",
        "slug": "17-scientist-drawer-102-band-spectrum-and-csv",
        "title": "[ISS-17] Multi-Target Source Inspector, Scientist Drawer & 102-Band Spectral Plot with CSV Export",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Fullstack (@Eddy-Odero)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:ui-ux",
            "area:spectrophotometry",
            "role:dev-5",
        ],
        "blocked_by": ["ISS-15"],
        "summary": (
            "Build the Selected & Multi-Target Source Inspector Card (showing all `trackedTargets` with their distinct "
            "colored tracking squares, overlapped-body branch badges, backward/forward `waypoints` across frames, "
            "edge-case diagnostics for `no_body_found` / `lost` / `low_snr`, proper motion in `arcsec/yr`, and catalog "
            "match or \"Uncataloged Infrared Mover Candidate\" badge) and the Scientist Drawer featuring the interactive "
            "102-band near-infrared spectrum (`0.75-5.0 um`), shaded molecular absorption bands (`H2O`, `CH4`, `CO2`, `CO`), "
            "and one-click CSV export."
        ),
        "architectural_context": (
            "Connects multi-target astrometric motion discovery with astrophysical characterization: after clicking "
            "one or more spots (including overlapped bodies that separate across epochs), users inspect each tracked "
            "target's waypoints, status diagnostics, and 102-band SPHEREx spectrum."
        ),
        "files_to_touch": [
            "frontend/src/components/SourceInspectorCard.tsx",
            "frontend/src/components/SpectrumDrawer.tsx",
            "frontend/src/utils/csvExport.ts",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "Build `SourceInspectorCard.tsx` displaying `trackedTargets` (with each track's color swatch `track.color`, `isOverlappedAtOrigin` branch badge, `removeTrackedTarget`, and `clearTrackedTargets`), `lastClickDiagnostic` warning when no body is found, and the focused `selectedObject`'s per-epoch `waypoints` table (highlighting `status: 'tracked' | 'lost' | 'low_snr' | 'out_of_bounds'`).",
            "Build `SpectrumDrawer.tsx` rendering an interactive SVG spectrophotometry chart (`0.75-5.0 um` vs `flux` in `MJy/sr` with `+-sqrt(variance)` uncertainty ribbons, segmented by Detectors `1..6`) and shaded vertical regions for `H2O`, `CH4`, `CO2`, and `CO`.",
            "Implement `formatSpectrumCsv(spectrum: SpectrumPayload): string` in `csvExport.ts` and wire a \"Download 102-Band Spectrum CSV\" button.",
        ],
        "acceptance_criteria": [
            "When one or more spots are clicked (`trackedTargets`), `SourceInspectorCard` lists each tracked target with its distinct tracking square color, overlapped-body branch status, and detected `(x, y, ra, dec, status)` waypoints across all previous and future epochs.",
            "`SpectrumDrawer` renders all 102 spectral channels and shades all 4 molecular feature bands (`H2O`, `CH4`, `CO2`, `CO`).",
            "`formatSpectrumCsv` produces a valid 103-line CSV (`header + 102 channels`) with columns `band_index,detector,wavelength_um,flux,variance,flagged`.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 18,
        "id": "ISS-18",
        "slug": "18-bright-body-click-detector-multi-frame-tracker",
        "title": "[ISS-18] Multi-Spot & Overlapped Bright-Body Detector, Colored Tracking Squares & Backward/Forward Trajectory Tracker",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Frontend Lead (@atienosharzy-boop)",
        "estimated_minutes": 75,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:pixel-engine",
            "area:tracking",
            "role:dev-4",
        ],
        "blocked_by": ["ISS-11"],
        "summary": (
            "Refine and verify the client-side bright-body detector and multi-frame trajectory tracker (`detectAndTrackBodiesAtClick` "
            "and `detectAndTrackBrightBodyAcrossEpochs`) so clicking any spot `(clickX, clickY)` on any currently viewed "
            "image (`originEpochIndex`) detects the local bright body(s), **tracks \"overlapped\" bodies** that are blended "
            "at the moment of clicking and separate in earlier or later epochs, assigns **different tracking square colors** "
            "to each tracked body, supports **clicking multiple spots** to track different targets simultaneously, and "
            "handles edge cases such as **unable to identify a body** at the clicked spot or **losing track of a body** in other epochs."
        ),
        "architectural_context": (
            "Directly fulfills the user's tracking requirements: (1) backward and forward trajectory tracking from any "
            "clicked frame (`originEpochIndex`), (2) tracking overlapped bodies at the clicked epoch that separate in "
            "earlier or later epochs into distinct colored tracking squares, (3) multi-spot target tracking (`trackedTargets`), "
            "and (4) graceful edge-case handling (`status: 'no_body_found'`, `waypoint.status: 'tracked' | 'lost' | 'low_snr' | 'out_of_bounds'`)."
        ),
        "files_to_touch": [
            "frontend/src/types/contracts.ts",
            "frontend/src/context/SkyExplorerContext.tsx",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "In `detectAndTrackBodiesAtClick`, search within `localRadiusPx` (`6 px`) around `(clickX, clickY)` on `originEpochIndex` using the active wavelength-weighted detector composite to find the local bright body peak and compute its background-subtracted 5x5 flux-weighted centroid `(originCentroidX, originCentroidY)` and SNR.",
            "Handle the **unable to identify body** edge case: if `clickX/Y` is out of bounds or `originDetection.snr < minSnrThreshold` (`3.0`), return `status: 'no_body_found'` and `tracks: []` with a descriptive diagnostic message (`lastClickDiagnostic`) without adding a bogus track.",
            "Detect and track **overlapped bodies**: scan earlier and later epochs (`transientDifferenceFrames` and `compositeFrames`) for multiple separated local peaks (both stationary + moving overlap and 2+ diverging moving bodies that were blended at `originEpochIndex`), creating a separate `TracedObjectSummary` branch for each body with `isOverlappedAtOrigin: true` and a distinct color from `TRACKING_SQUARE_COLORS`.",
            "Propagate each branch **backward** (`idx = originEpochIndex - 1` down to `0`) and **forward** (`idx = originEpochIndex + 1` up to `numEpochs - 1`), handling the **lost track in other epochs** edge case by marking waypoints where the source leaves the FOV or drops below SNR as `status: 'out_of_bounds' | 'low_snr' | 'lost'` (`visible: false`, `lostEpochIds`) while holding the predicted/last-known position.",
            "Support **clicking multiple spots** in `SkyExplorerContext` by accumulating tracks into `trackedTargets: TracedObjectSummary[]` with cycling colors from `TRACKING_SQUARE_COLORS`, plus `removeTrackedTarget(trackId)` and `clearTrackedTargets()`.",
        ],
        "acceptance_criteria": [
            "Clicking near `wise_0855` on Pass 1 (`originEpochIndex = 0`) snaps to the bright body centroid on Pass 1 and finds its forward position on Pass 2; clicking on Pass 2 (`originEpochIndex = 1`) finds its backward position on Pass 1.",
            "Clicking a spot where two bodies are overlapped at `originEpochIndex` and separate in earlier or later epochs returns 2 distinct `TracedObjectSummary` tracks (`isOverlappedAtOrigin: true`) with different tracking square `color` values.",
            "Clicking multiple spots adds multiple targets to `trackedTargets`, each with a distinct color from `TRACKING_SQUARE_COLORS`.",
            "Clicking empty sky noise returns `status: 'no_body_found'` with `tracks: []`; a body that fades or leaves the FOV in another epoch marks that epoch's waypoint with `status: 'lost' | 'low_snr' | 'out_of_bounds'` and `track.status === 'partially_lost'`.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 19,
        "id": "ISS-19",
        "slug": "19-interactive-viewport-canvas-svg-overlays",
        "title": "[ISS-19] Interactive 256x256 Canvas + SVG Overlay Viewport with Pan/Zoom, Colored Tracking Squares & Non-Looping Playback",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Frontend Lead (@atienosharzy-boop)",
        "estimated_minutes": 75,
        "labels": [
            "phase:2",
            "area:frontend",
            "area:pixel-engine",
            "area:known-objects",
            "area:tracking",
            "role:dev-4",
        ],
        "blocked_by": ["ISS-11", "ISS-16", "ISS-18"],
        "summary": (
            "Build the interactive `256x256` `<canvas>` + aligned `<svg>` viewport component with **interactive panning "
            "and zooming** (`1x` to `8x`), rendering the 60 FPS pixel-math image, highlighting and labeling all checked "
            "`knownObjects` (`checkedObjectIds`) at their epoch-specific `epoch_positions` across frames, and rendering "
            "**distinctly colored tracking squares**, backward/forward `waypoints`, and motion vectors for all clicked "
            "targets and overlapped-body branches (`trackedTargets`)."
        ),
        "architectural_context": (
            "Brings together the 60 FPS pixel engine (`ISS-11`), Known Celestial Objects checkbox selection (`ISS-16`), "
            "multi-spot & overlapped-body tracking (`ISS-18`), and interactive pan/zoom into a responsive scientific viewport."
        ),
        "files_to_touch": [
            "frontend/src/components/SkyPatchViewport.tsx",
            "frontend/src/types/contracts.ts",
            "frontend/src/App.tsx",
        ],
        "implementation_steps": [
            "Render the `256x256` `ImageData` output from `pixelEngine.ts` onto an HTML5 `<canvas>` whenever `epochBuffers`, `flagsBuffers`, or `renderSettings` change.",
            "Implement interactive **panning and zooming** (`renderSettings.zoom` in `1.0..8.0`, `panX`, `panY` via `clampViewportPanZoom` and `computeViewportViewBox`) supporting mouse-wheel zoom, drag-to-pan when zoomed in, and toolbar zoom buttons (`+`, `-`, `Reset 1x`), keeping `<canvas>` and `<svg>` transforms strictly synchronized.",
            "Render an aligned `<svg>` overlay displaying markers, trajectory dashed lines, and crisp text labels for every object in `knownObjects` whose `object_id` is in `renderSettings.checkedObjectIds`, positioning each marker at the current `activeEpochIndex` entry of `obj.epoch_positions`.",
            "For every tracked target/branch in `trackedTargets`, render a **colored tracking square** (`stroke={track.color}`) at its current epoch waypoint `(wp.x, wp.y)` (rendering a dashed ghost square when `wp.status !== 'tracked'`), draw its backward/forward `waypoints` trail, and draw a directional vector arrow from `Pass 1` to `Pass N`.",
            "Map `<canvas>`/`<svg>` click coordinates `(clientX, clientY)` under active `(zoom, panX, panY)` back to `[0..255, 0..255]` via `screenToImageCoordinates` and invoke `inspectPixelOrCoord(x, y, renderSettings.activeEpochIndex)`.",
        ],
        "acceptance_criteria": [
            "Zooming (`1x..8x`) and panning transform the `<canvas>` and `<svg>` overlays in lockstep, and clicking a zoomed/panned spot accurately maps to the underlying `(0..256, 0..256)` sky patch pixel via `screenToImageCoordinates`.",
            "Only objects whose `object_id` is in `renderSettings.checkedObjectIds` are highlighted and labeled on the SVG overlay, and their marker positions shift accurately as `activeEpochIndex` steps across epochs.",
            "Clicking multiple spots or overlapped bodies renders distinct colored tracking squares (`track.color`) for each target across epochs, and non-looping playback pauses on the final frame (`isLooping === false` by default).",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
        ],
    },
    {
        "order": 20,
        "id": "ISS-20",
        "slug": "20-golden-target-real-archive-batch-builder",
        "title": "[ISS-20] Golden Target Pre-Computation Batch Script (Real IRSA/Gaia/MOST Archive Data + Fallback)",
        "status": "open",
        "phase": "Phase 2 (Hours 2-9)",
        "preferred_role": "Backend — Science & Multi-Mission Pipeline (@paowuor)",
        "estimated_minutes": 60,
        "labels": [
            "phase:2",
            "area:presets",
            "area:spherex-pipeline",
            "area:multi-mission",
            "role:dev-2",
            "role:dev-3",
        ],
        "blocked_by": ["ISS-07", "ISS-08", "ISS-09", "ISS-12"],
        "summary": (
            "Create `scripts/build_presets.py` to run the full SPHEREx + WISE/NEOWISE fallback + Gaia/MOST known-object "
            "tracking + 102-band photometry pipeline for the 6 showcase targets (with `--fallback-synthetic` resilience "
            "when offline) and write validated static preset bundles to `frontend/public/presets/{slug}/`."
        ),
        "architectural_context": (
            "Ensures all 6 showcase targets load in `0 ms` during live judging with real (or verified fallback) "
            "multi-epoch cutouts, epoch-aware `known_objects`, and 102-channel spectra."
        ),
        "files_to_touch": [
            "scripts/build_presets.py",
            "frontend/public/presets/wise_0855/manifest.json",
        ],
        "implementation_steps": [
            "Implement `scripts/build_presets.py` iterating over the 6 `SHOWCASE_TARGETS` (`wise_0855`, `barnards_star`, `epsilon_indi_b`, `rw_aurigae`, `r_draconis`, `comet_3i_atlas`).",
            "Attempt live IRSA SPHEREx + WISE + Gaia + MOST ingestion with a configurable timeout, automatically falling back to `generate_synthetic_presets` when offline or `--fallback-synthetic` is passed.",
            "Validate every output `manifest.json`, `spectrum.json`, `pass_{N}.bin`, and `pass_{N}_flags.bin` before writing.",
        ],
        "acceptance_criteria": [
            "`python3 scripts/build_presets.py --fallback-synthetic` populates and validates all 6 preset folders in `frontend/public/presets/` with zero schema or byte-length errors.",
            "All 6 presets contain populated `catalog_overlays.known_objects` with multi-epoch positions and 102-band spectra.",
        ],
        "verification_commands": [
            "python3 scripts/build_presets.py --fallback-synthetic",
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 21,
        "id": "ISS-21",
        "slug": "21-end-to-end-progressive-wiring-and-zero-refetch",
        "title": "[ISS-21] End-to-End Progressive API Wiring, 3G Client Cache Integration & Zero-Refetch Option Switching",
        "status": "open",
        "phase": "Phase 3 (Hours 9-12)",
        "preferred_role": "Fullstack / QA Lead (@carsonak)",
        "estimated_minutes": 60,
        "labels": [
            "phase:3",
            "area:integration",
            "area:caching-3g",
            "area:frontend",
            "area:backend",
            "role:dev-4",
            "role:dev-1",
        ],
        "blocked_by": [
            "ISS-10",
            "ISS-13",
            "ISS-14",
            "ISS-15",
            "ISS-16",
            "ISS-17",
            "ISS-19",
            "ISS-20",
        ],
        "summary": (
            "Connect `SkyExplorerProvider` to the 2-stage progressive live backend flow (`GET /api/v1/catalogs` -> "
            "`GET /api/v1/sky-patch` -> `GET /api/v1/frames/...` with `?precision=float16` 3G support -> "
            "`GET /api/v1/spectrum`), backed by `ClientPatchCache` (Memory + IndexedDB), and verify that all "
            "user-configurable options execute with zero extra network calls."
        ),
        "architectural_context": (
            "Completes the end-to-end progressive loading and 3G two-tier caching architecture across presets and "
            "arbitrary live `(RA, Dec)` / \"What's Above Me?\" (including random capital city fallback) coordinates."
        ),
        "files_to_touch": [
            "frontend/src/context/SkyExplorerContext.tsx",
            "frontend/tests/contracts_and_tracking.test.mjs",
        ],
        "implementation_steps": [
            "In `navigateToCoordinates(ra, dec, fovArcmin)`, check `defaultClientPatchCache` first; on cache miss, fire Stage A (`GET /api/v1/catalogs`) and Stage B (`GET /api/v1/sky-patch` + `.bin` frames with `?precision=float16`) in parallel with `AbortController` cancellation for stale navigations.",
            "Populate `knownObjects` and `checkedObjectIds` immediately when Stage A resolves so the Known Celestial Objects Checkbox Menu is interactive while Stage B cutouts finish.",
            "Verify that switching comparison modes (`blink`, `subtract`, `coadd`), changing wavelength ranges, panning/zooming, checking/unchecking known objects (`Check All`, `Uncheck All`), and clicking multiple spots or overlapped bodies to track across epochs trigger zero network requests.",
        ],
        "acceptance_criteria": [
            "Rapidly switching presets or coordinates cancels in-flight `fetch` requests via `AbortController` so stale responses never overwrite the active patch.",
            "Stage A (`/api/v1/catalogs`) populates `knownObjects` before Stage B (`/api/v1/sky-patch`) completes.",
            "Changing any `ViewportRenderSettings` option, panning/zooming, or clicking to track bodies across epochs makes `0` HTTP requests.",
        ],
        "verification_commands": [
            "cd frontend && pnpm test",
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
        ],
    },
    {
        "order": 22,
        "id": "ISS-22",
        "slug": "22-docker-flyio-suspend-deploy-and-verification",
        "title": "[ISS-22] Unified Multi-Stage Docker Packaging, Fly.io Suspend Deployment & Golden Target Verification",
        "status": "open",
        "phase": "Phase 3 (Hours 9-12)",
        "preferred_role": "Fullstack / QA Lead (@carsonak)",
        "estimated_minutes": 60,
        "labels": [
            "phase:3",
            "area:devops",
            "area:verification",
            "role:dev-1",
        ],
        "blocked_by": ["ISS-13", "ISS-20", "ISS-21"],
        "summary": (
            "Finalize the unified multi-stage `Dockerfile` (serving the built Vite SPA and `/api/v1/*` from a single "
            "FastAPI container), configure `fly.toml` for Fly.io `iad` scale-to-zero (`auto_stop_machines = \"suspend\"`) "
            "with a 1 GB persistent SQLite volume at `/data`, and run the end-to-end verification suite across all 6 "
            "showcase targets."
        ),
        "architectural_context": (
            "Eliminates CORS latency in production by serving both static preset assets and live API endpoints from "
            "a single Fly.io machine located near Caltech/IPAC IRSA (`iad`), with persistent SQLite caching across "
            "machine suspend/resume cycles."
        ),
        "files_to_touch": [
            "Dockerfile",
            "fly.toml",
            "backend/app/main.py",
            "README.md",
        ],
        "implementation_steps": [
            "Configure `backend/app/main.py` to mount `frontend/dist` static files (when present in the container build) with SPA `index.html` fallback.",
            "Verify `Dockerfile` multi-stage build and `fly.toml` (`primary_region = \"iad\"`, `auto_stop_machines = \"suspend\"`, `/data` volume mount).",
            "Run end-to-end verification checks across all 6 showcase presets, Known Objects Check/Uncheck All, multi-spot & overlapped bright-body click tracking, pan/zoom, and Zenith conversion (with random capital city fallback).",
        ],
        "acceptance_criteria": [
            "`Dockerfile` and `fly.toml` pass configuration validation with `auto_stop_machines = \"suspend\"` and `/data` volume mount.",
            "All backend and frontend automated test suites pass with zero errors.",
            "All 6 showcase targets (`wise_0855`, `barnards_star`, `epsilon_indi_b`, `rw_aurigae`, `r_draconis`, `comet_3i_atlas`) pass contract, binary buffer, known-object, and trajectory tracking verification.",
        ],
        "verification_commands": [
            "PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v",
            "cd frontend && pnpm test",
        ],
    },
]


def compute_blocking_relations(issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Populate `blocking` lists, assignees, and status, and verify strict topological ordering."""
    id_to_order = {item["id"]: item["order"] for item in issues}
    blocking_map: Dict[str, List[str]] = {item["id"]: [] for item in issues}

    for item in issues:
        curr_id = item["id"]
        curr_order = item["order"]
        for dep_id in item["blocked_by"]:
            if dep_id in COMPLETED_ISSUES:
                raise ValueError(
                    f"Completed issue {dep_id} must be stripped from {curr_id}.blocked_by"
                )
            dep_order = id_to_order[dep_id]
            if dep_order >= curr_order:
                raise ValueError(
                    f"Topological order violation: {curr_id} (order {curr_order}) "
                    f"is blocked by {dep_id} (order {dep_order})"
                )
            blocking_map[dep_id].append(curr_id)

    enriched: List[Dict[str, Any]] = []
    for item in issues:
        curr_id = item["id"]
        copy_item = dict(item)
        copy_item["status"] = "completed" if curr_id in COMPLETED_ISSUES else item.get("status", "open")
        copy_item["blocking"] = sorted(
            blocking_map[curr_id], key=lambda x: id_to_order[x]
        )
        copy_item["assignees"] = list(ISSUE_ASSIGNEES.get(curr_id, []))
        copy_item["json_file"] = f"issues/{item['slug']}.json"
        copy_item["markdown_file"] = f"issues/{item['slug']}.md"
        enriched.append(copy_item)
    return enriched


def render_issue_markdown(issue: Dict[str, Any], id_to_slug: Dict[str, str]) -> str:
    """Render a detailed, human-readable Markdown specification for an issue."""
    blocked_by_links = (
        ", ".join(
            f"[`{dep}`](./{id_to_slug[dep]}.md)" for dep in issue["blocked_by"]
        )
        if issue["blocked_by"]
        else "None (Can start immediately)"
    )
    blocking_links = (
        ", ".join(
            f"[`{dep}`](./{id_to_slug[dep]}.md)" for dep in issue["blocking"]
        )
        if issue["blocking"]
        else (
            "None (Completed in Phase 1 — all dependents unblocked)"
            if issue["status"] == "completed"
            else "None (Terminal milestone)"
        )
    )
    assignees_str = (
        ", ".join(f"`@{u}`" for u in issue["assignees"])
        if issue["assignees"]
        else "*Unassigned*"
    )
    status_badge = "✅ `completed`" if issue["status"] == "completed" else "🟢 `open`"
    labels_str = ", ".join(f"`{lbl}`" for lbl in issue["labels"])
    files_md = "\n".join(f"- `{f}`" for f in issue["files_to_touch"])
    steps_md = "\n".join(
        f"{idx}. {step}" for idx, step in enumerate(issue["implementation_steps"], start=1)
    )
    checkbox_mark = "x" if issue["status"] == "completed" else " "
    ac_md = "\n".join(f"- [{checkbox_mark}] {ac}" for ac in issue["acceptance_criteria"])
    verify_md = "\n".join(issue["verification_commands"])

    return f"""# {issue['title']}

| Field | Value |
| :--- | :--- |
| **Issue ID** | `{issue['id']}` (Topological Order: `{issue['order']:02d}` of `22`) |
| **Status** | {status_badge} |
| **Phase** | {issue['phase']} |
| **Preferred Role** | {issue['preferred_role']} |
| **Assignees** | {assignees_str} |
| **Estimated Effort** | ~{issue['estimated_minutes']} mins (Single AI Context Window) |
| **Labels / Tags** | {labels_str} |
| **Blocked By (`blocked_by`)** | {blocked_by_links} |
| **Is Blocking (`blocking`)** | {blocking_links} |
| **Machine-Readable JSON** | [`{issue['slug']}.json`](./{issue['slug']}.json) |

---

## 1. Objective & Summary
{issue['summary']}

## 2. Architectural Context
{issue['architectural_context']}

- **Master Architecture Reference:** [`plans/phase_0_master_architecture_shared_contracts.md`](../plans/phase_0_master_architecture_shared_contracts.md)

## 3. Files to Create or Modify
{files_md}

## 4. Detailed Implementation Steps
{steps_md}

## 5. Acceptance Criteria
{ac_md}

## 6. Verification Commands
```bash
{verify_md}
```
"""


def build_github_body(issue: Dict[str, Any]) -> str:
    """Build the Markdown body used when publishing the issue to GitHub via `gh` CLI."""
    blocked_by_str = (
        ", ".join(f"`{b}`" for b in issue["blocked_by"])
        if issue["blocked_by"]
        else "None (Ready immediately)"
    )
    blocking_str = (
        ", ".join(f"`{b}`" for b in issue["blocking"])
        if issue["blocking"]
        else ("None (Completed foundation issue)" if issue["status"] == "completed" else "None")
    )
    assignees_str = ", ".join(f"@{u}" for u in issue["assignees"]) or "Unassigned"
    files_md = "\n".join(f"- `{f}`" for f in issue["files_to_touch"])
    steps_md = "\n".join(
        f"{idx}. {step}" for idx, step in enumerate(issue["implementation_steps"], start=1)
    )
    checkbox_mark = "x" if issue["status"] == "completed" else " "
    ac_md = "\n".join(f"- [{checkbox_mark}] {ac}" for ac in issue["acceptance_criteria"])
    verify_md = "\n".join(issue["verification_commands"])

    return f"""### Topological Dependency Graph & Metadata
- **Issue ID:** `{issue['id']}` (Topological Order `{issue['order']:02d}/22`)
- **Status:** `{issue['status']}`
- **Phase:** {issue['phase']}
- **Preferred Role:** {issue['preferred_role']}
- **Assignee:** {assignees_str}
- **Estimated Effort:** ~{issue['estimated_minutes']} minutes (Single AI Context Window)
- **Blocked By:** {blocked_by_str}
- **Is Blocking:** {blocking_str}

---

### 1. Summary
{issue['summary']}

### 2. Architectural Context
{issue['architectural_context']}

### 3. Files to Touch
{files_md}

### 4. Implementation Steps
{steps_md}

### 5. Acceptance Criteria
{ac_md}

### 6. Verification
```bash
{verify_md}
```
"""


def render_master_readme(issues: List[Dict[str, Any]]) -> str:
    """Render `issues/README.md` with topological index table, team assignments, Mermaid DAG, and `gh` CLI guide."""
    rows: List[str] = []
    for item in issues:
        blocked = ", ".join(f"`{b}`" for b in item["blocked_by"]) or "—"
        blocking = ", ".join(f"`{b}`" for b in item["blocking"]) or "—"
        assignees_str = ", ".join(f"`@{u}`" for u in item["assignees"]) or "—"
        status_str = "✅ Completed" if item["status"] == "completed" else "🟢 Open"
        rows.append(
            f"| `{item['order']:02d}` | **`{item['id']}`** | [{item['title']}](./{item['slug']}.md) "
            f"| {status_str} | {assignees_str} | {blocked} | {blocking} | "
            f"[MD](./{item['slug']}.md) / [JSON](./{item['slug']}.json) |"
        )
    table_md = "\n".join(rows)

    mermaid_edges: List[str] = []
    for item in issues:
        for dep in item["blocked_by"]:
            mermaid_edges.append(f"  {dep.replace('-', '')} --> {item['id'].replace('-', '')}")
    mermaid_str = "\n".join(mermaid_edges)

    return f"""# Star Hunters — Topologically Ordered Issue Backlog (`ISS-01` to `ISS-22`)

All **22 issues** are scoped for a **single AI context window (~45–75 minutes each)** and ordered in **strict topological order (`01` through `22`)**:
- `ISS-01` and `ISS-02` are marked **`"status": "completed"`** and removed from all active `blocked_by` lists so the first wave of active issues (`ISS-03`, `ISS-04`, `ISS-05`, `ISS-06`, `ISS-10`, `ISS-14`, `ISS-15`) can start immediately (`blocked_by: []`).
- For every issue `i`, all of its `blocked_by` dependencies have issue numbers `< i`, and all of its `blocking` dependents have issue numbers `> i`.
- Every issue has both a **human-readable Markdown specification** (`issues/NN-*.md`) and a **machine-readable JSON file** (`issues/NN-*.json`), plus the combined [`all_issues.json`](./all_issues.json).

---

## 1. Team Assignments & Workload Distribution

| Team Member | Role | Assigned Issues | Active / Completed Count |
| :--- | :--- | :--- | :--- |
| **`@14Emanuel`** | **Backend Lead** | `ISS-03`, `ISS-05`, `ISS-06`, `ISS-13` | 4 active (`ISS-03`, `ISS-05`, `ISS-06` ready immediately) |
| **`@paowuor`** | **Backend (SPHEREx & Multi-Mission)** | `ISS-04`, `ISS-08`, `ISS-09`, `ISS-12`, `ISS-20` | 5 active (`ISS-04` ready immediately) |
| **`@Eddy-Odero`** | **Fullstack** | `ISS-07`, `ISS-15`, `ISS-16`, `ISS-17` | 4 active (`ISS-15` ready immediately) |
| **`@atienosharzy-boop`** | **Frontend Lead** | `ISS-10`, `ISS-11`, `ISS-14`, `ISS-18`, `ISS-19` | 5 active (`ISS-10`, `ISS-14` ready immediately) |
| **`@carsonak`** | **Fullstack / QA / Integration & Deployment** | `ISS-01` ✅, `ISS-02` ✅, `ISS-21`, `ISS-22` | 2 completed + 2 active (`ISS-21`, `ISS-22` + PR review/merge) |

---

## 2. Key User Review Additions Incorporated Across Issues
1. **`ISS-01` & `ISS-02` Completed & Unblocked:**
   - Marked `"status": "completed"` and stripped from all downstream `blocked_by` arrays; automatically closed when published via `scripts/publish_github_issues.py`.
2. **Random World Capital City Fallback & Backend SQLite Caching (`ISS-05`, `ISS-12`, `ISS-15`):**
   - When user geolocation is unavailable/denied, `/api/v1/earth-to-sky` picks a random capital city from `WORLD_CAPITAL_CITIES` (`is_fallback_capital: true`, `city_name`, `country`) and caches both the Zenith lookup and the overhead SPHEREx/WISE sky patch in SQLite.
3. **Overlapped Bodies at Click, Multi-Spot Tracking, Colored Tracking Squares & Edge Cases (`ISS-17`, `ISS-18`, `ISS-19`):**
   - `detectAndTrackBodiesAtClick` detects and tracks multiple overlapped bodies that are blended at `originEpochIndex` and separate in earlier or later epochs, assigns distinct colors (`TRACKING_SQUARE_COLORS`) to each tracking square, supports clicking multiple spots (`trackedTargets`), and handles edge cases (`no_body_found`, `lost`, `low_snr`, `out_of_bounds`).
4. **Interactive Viewport Panning & Zooming (`ISS-19`):**
   - Synchronized `<canvas>` and `<svg>` pan and zoom (`zoom: 1..8`, `panX`, `panY`, `computeViewportViewBox`, `screenToImageCoordinates`).

---

## 3. Active Topological Dependency Graph (`ISS-03` → `ISS-22`)

```mermaid
flowchart TD
{mermaid_str}
```

---

## 4. Master Topological Issue Table

| Order | ID | Issue Title | Status | Assignee | `blocked_by` | `blocking` | Files |
| :---: | :---: | :--- | :---: | :---: | :--- | :--- | :---: |
{table_md}

---

## 5. Publishing Issues, Assignees & Native `blocked_by` Relations with GitHub CLI (`gh`)

```bash
# 1. Dry-run preview (verifies topological order, assignees, labels, and GraphQL mutations)
python3 scripts/publish_github_issues.py --dry-run

# 2. Publish all 22 issues with assignees, close ISS-01 & ISS-02 as completed, and wire blockedBy relations
python3 scripts/publish_github_issues.py --execute
```
"""


def main() -> None:
    ISSUES_DIR.mkdir(parents=True, exist_ok=True)
    enriched = compute_blocking_relations(RAW_ISSUES)
    id_to_slug = {item["id"]: item["slug"] for item in enriched}

    all_labels = sorted({lbl for item in enriched for lbl in item["labels"]})

    for item in enriched:
        item["github_body"] = build_github_body(item)
        json_path = ISSUES_DIR / f"{item['slug']}.json"
        md_path = ISSUES_DIR / f"{item['slug']}.md"

        json_path.write_text(json.dumps(item, indent=2) + "\n", encoding="utf-8")
        md_path.write_text(
            render_issue_markdown(item, id_to_slug), encoding="utf-8"
        )

    all_issues_payload = {
        "project": "Star Hunters (Planet X & SPHEREx Blinker)",
        "total_issues": len(enriched),
        "topologically_sorted": True,
        "assignees_populated": True,
        "completed_issues": sorted(COMPLETED_ISSUES),
        "team_members": {
            "14Emanuel": "Backend Lead",
            "atienosharzy-boop": "Frontend Lead",
            "carsonak": "Fullstack (QA, Integration & Deployment)",
            "Eddy-Odero": "Fullstack",
            "paowuor": "Backend",
        },
        "labels": all_labels,
        "issues": enriched,
    }
    (ISSUES_DIR / "all_issues.json").write_text(
        json.dumps(all_issues_payload, indent=2) + "\n", encoding="utf-8"
    )
    (ISSUES_DIR / "README.md").write_text(
        render_master_readme(enriched), encoding="utf-8"
    )
    print(
        f"Generated {len(enriched)} JSON files, {len(enriched)} Markdown files, "
        f"issues/all_issues.json, and issues/README.md."
    )


if __name__ == "__main__":
    main()
