# Phase 0: Master Architecture, Team Parallelization & Shared Contracts

## 1. Project Vision & End Goal
We are building **Star Hunters (Planet X & SPHEREx Blinker)** — an interactive web application for the NASA Space Apps Challenge that transforms NASA’s multi-epoch SPHEREx near-infrared dataset ($0.75\text{–}5.0\ \mu\text{m}$ across $6$ detector arrays and $102$ spectral channels), reinforced with **WISE/NEOWISE** and **Gaia DR3**, into an intuitive time-lapse discovery tool for both everyday space enthusiasts and professional astrophysicists.

### Core Capabilities of the Finished Application
1. **Instant Time-Lapse Blink, Subtraction & Co-Addition (100% Client-Side):** Users can step through observation epochs (non-looping by default so motion direction is unambiguous), subtract passes ($\text{Pass } B - \text{Pass } A$) across any chosen epoch pair to cancel stationary stars and expose moving dipoles or variable stars, or co-add passes to boost signal-to-noise for faint targets — all computed client-side in $<5\text{ ms}$ with zero network round-trips.
2. **Dynamic Wavelength "Dim & Pop" Filtering:** Users can filter across SPHEREx's $0.75\text{–}5.0\ \mu\text{m}$ range in real time at 60 FPS on the client canvas to dim hot background stars ($0.75\text{–}2.4\ \mu\text{m}$) and make ultra-cold brown dwarfs or outer-solar-system Planet X candidates ($3.8\text{–}5.0\ \mu\text{m}$) pop out.
3. **Multi-Mission Resiliency (SPHEREx + WISE/NEOWISE + Gaia DR3 + MOST):**
   - Where SPHEREx has $\ge 2$ epochs, users compare SPHEREx passes directly.
   - Where live SPHEREx coverage is sparse (only 1 pass or narrow time baseline, e.g., when a user clicks *"What's Above Me?"*), the pipeline automatically supplements the patch with archival **WISE/NEOWISE ($W1\ 3.4\ \mu\text{m}$ and $W2\ 4.6\ \mu\text{m}$)** cutouts aligned to the exact same $256 \times 256$ WCS grid (giving a 10–15 year baseline!) alongside **Gaia DR3** optical astrometry and **NASA MOST** Solar System asteroid/comet overlays.
4. **Asynchronous Known-Object Tracking & Interactive Checkbox Filter (with Check/Uncheck All):**
   - The backend asynchronously queries and cross-matches **Gaia DR3**, **WISE**, and **NASA MOST** for all known celestial objects in the current field of view and propagates their expected pixel positions `(x, y)` across every epoch (`epoch_positions`).
   - On the frontend, an interactive **Known Celestial Objects Checkbox Menu** (with **Check All**, **Uncheck All**, and **Notable Movers Default** controls) lets users choose exactly which cataloged objects are highlighted and labeled across each epoch image to track their movement without visual clutter.
5. **Automatic Bright-Body Detection & Backward/Forward Multi-Frame Tracking on Click:**
   - Clicking any spot on any currently viewed image (`originEpochIndex`) automatically detects and highlights the local **"bright" body** in the surrounding pixels on that image (`(x_origin, y_origin)`), and then searches both **backward (previous epochs)** and **forward (future epochs)** from that origin point to trace the body's multi-frame trajectory (`waypoints` across all frames), calculating its proper motion ($\text{arcsec/yr}$), cross-matching against known catalogs, flagging uncataloged movers, and opening its $102$-channel near-infrared spectrum ($0.75\text{–}5.0\ \mu\text{m}$) with highlighted molecular absorption bands ($\text{H}_2\text{O}, \text{CH}_4, \text{CO}_2, \text{CO}$).
6. **3G-Optimised Two-Tier Caching & Local Client Calculation:**
   - **Backend Preprocessing + SQLite Cache (Tier 1):** The backend handles heavy FITS cutout downloads, `IMAGE - ZODI` subtraction, WCS reprojection, and catalog extraction, caching processed artifacts in SQLite and serving GZip-compressed raw binary frames (`Float16`/`Float32`) with immutable `Cache-Control` headers.
   - **Browser HTTP Cache + IndexedDB (Tier 2):** The frontend persists raw patch manifests, catalog overlays, and decoded binary buffers in memory and **IndexedDB** (`star_hunters_patch_cache_v1`) so all user-configurable options — epoch combination (blink, subtract, co-add), wavelength colorization, known-object checkbox filtering, and click-to-track trajectory detection — run locally with zero repeated network fetches.

---

## 2. Team of 5 Parallelization Strategy (12-Hour Window)

Both **Frontend Lead (`@atienosharzy-boop`)** and **Fullstack (`@Eddy-Odero`)** split the React + TypeScript + Vite frontend into two parallel vertical domains so nobody waits on anyone else. **Backend (`@paowuor`)** and **Backend Lead (`@14Emanuel`)** split the scientific data pipeline, SQLite spatial caching, and FastAPI orchestration, while **Fullstack / QA (`@carsonak`)** owns shared foundation contracts (`ISS-01`, `ISS-02` — completed), end-to-end integration (`ISS-21`), PR verification/merging, and Fly.io deployment (`ISS-22`).

| Team Member | Preferred Role | Assigned Issues | Primary Ownership |
| :--- | :--- | :--- | :--- |
| **`@14Emanuel`** | **Backend Lead** | `ISS-03`, `ISS-05`, `ISS-06`, `ISS-13` | Quantized SQLite spatial cache ($0.05^\circ$ grid + LRU pruning + capital city cache), Earth-to-Sky Zenith coordinate bridge with random capital city fallback, asynchronous multi-mission catalog queries (Gaia DR3, WISE, MOST), and FastAPI progressive 3G binary streaming endpoints. |
| **`@paowuor`** | **Backend (SPHEREx & Multi-Mission)** | `ISS-04`, `ISS-08`, `ISS-09`, `ISS-12`, `ISS-20` | IRSA CAOM-2 TAP (`spherex.artifact` + `spherex.plane`) cutout ingestion, `IMAGE - ZODI` & `FLAGS` hygiene, adaptive epoch clustering, $256 \times 256$ WCS co-addition, $102$-band forced photometry, WISE/NEOWISE ($W1/W2$) archival cutout fallback & capital city patch caching, and Golden Target batch builder. |
| **`@Eddy-Odero`** | **Fullstack** | `ISS-07`, `ISS-15`, `ISS-16`, `ISS-17` | Backend known-object multi-epoch trajectory propagator & notable ranking, responsive application shell, 6-Target Tour carousel, *"What's Above Me?"* Zenith flow (with random capital city fallback), viewport controls bar, Known Celestial Objects Checkbox Menu (`Check All` / `Uncheck All`), and Scientist Drawer with 102-band spectrum & CSV export. |
| **`@atienosharzy-boop`** | **Frontend Lead** | `ISS-10`, `ISS-11`, `ISS-14`, `ISS-18`, `ISS-19` | Two-tier client cache (Memory + IndexedDB) & `Float16`/`Float32` decoder, 60 FPS pixel math & wavelength "Dim & Pop" engine, Aladin Lite v3 sky map & URL sync, multi-spot & overlapped bright-body detector + backward/forward multi-frame tracker with colored tracking squares & edge cases, and interactive $256 \times 256$ Canvas + SVG viewport with pan/zoom (`1x`–`8x`). |
| **`@carsonak`** | **Fullstack / QA / Integration & Deployment** | `ISS-01` ✅, `ISS-02` ✅, `ISS-21`, `ISS-22` | Completed Phase 1 monorepo scaffolding/contracts (`ISS-01`) and synthetic preset generator (`ISS-02`); owns PR review/verification/merging, end-to-end progressive API wiring (`ISS-21`), and unified Docker + Fly.io `suspend` deployment (`ISS-22`). |

### 12-Hour Execution Phases & Topological Issue Ordering
```mermaid
flowchart LR
  P0["Phase 0\nArchitecture & Contracts"]
  P1["Phase 1 (Hours 0–2)\nScaffolding, Mocks & Golden Presets"]
  P2["Phase 2 (Hours 2–9)\n5 Parallel Core Workstreams"]
  P3["Phase 3 (Hours 9–12)\nLive Integration, Fly.io & Verification"]
  P0 --> P1 --> P2 --> P3
```
- All work items are broken into small, single-context-sized issues (`ISS-01` through `ISS-22`) ordered in **strict topological order** with native GitHub `blocked_by` / `blocking` relations in [`/issues/README.md`](file:///home/line/hackathons/star-hunters/issues/README.md).
- **[Phase 1 (Hours 0–2)](file:///home/line/hackathons/star-hunters/plans/phase_1_foundation_scaffolding_and_presets.md):** Scaffold `/backend` (Python 3.11 + FastAPI) and `/frontend` (React + TypeScript + Vite), lock in shared types/context, generate instant synthetic mock bundles (within 45 mins), and run the Golden Target batch generator for the 6 showcase targets.
- **[Phase 2 (Hours 2–9)](file:///home/line/hackathons/star-hunters/plans/phase_2_core_parallel_workstreams.md):** All 5 developers build their independent tracks concurrently against the contracts below.
- **[Phase 3 (Hours 9–12)](file:///home/line/hackathons/star-hunters/plans/phase_3_integration_deployment_and_verification.md):** Connect the progressive live API flow (`Aladin pan` + `/api/v1/catalogs` in ~1–2s $\rightarrow$ `/api/v1/sky-patch` binary epochs cached in IndexedDB $\rightarrow$ `/api/v1/spectrum`), deploy to Fly.io scale-to-zero, and validate all 6 showcase targets plus live Zenith queries.

---

## 3. Immutable Shared Contracts

Both the static preset bundles (`/presets/{slug}/manifest.json`) and the live backend endpoints (`/api/v1/*`) **must** adhere to these schemas so Frontend and Backend integrate seamlessly.

### 3.1 Progressive Live Query Flow, 3G Two-Tier Caching & Static Preset Flow
To ensure fast loading even on constrained 3G connections and zero lag when adjusting UI controls:
1. **Static Preset Path ($0\text{ ms}$):** Selecting one of the 6 Golden Targets loads `/presets/{slug}/manifest.json`, its `.bin` epoch buffers, and `/presets/{slug}/spectrum.json` directly from static assets (and caches decoded buffers in the client's Memory/IndexedDB store).
2. **Live Coordinate Path (Progressive 2-Stage Load + Two-Tier Cache):**
   - **Client Cache Check ($<10\text{ ms}$):** Before making network requests, the frontend checks its local Two-Tier Cache (in-memory `Map` + **IndexedDB** `star_hunters_patch_cache_v1` keyed by quantized `grid_key`). If present, the patch renders immediately without network calls.
   - **Stage A — Asynchronous Known-Object Catalogs ($\sim 1\text{–}2\text{ s}$):** Frontend immediately pans Aladin Lite v3 to `(ra, dec)` and requests `GET /api/v1/catalogs?ra={deg}&dec={deg}&fov={arcmin}` to receive the asynchronously cross-matched `known_objects` list (Gaia DR3, WISE, and MOST with per-epoch coordinates and `default_checked` flags) so the checkbox menu and sky map markers populate immediately.
   - **Stage B — Compressed Cutout Resolution ($<50\text{ ms}$ SQLite hit / $15\text{–}35\text{ s}$ cold):** Frontend requests `GET /api/v1/sky-patch?ra={deg}&dec={deg}&fov={arcmin}` to receive the WCS-aligned binary epoch URLs (`pass_1.bin`, `pass_2.bin`). Binary frames are served with `GZipMiddleware`, optional `Float16` transfer encoding (`?precision=float16`, cutting raw size in half from $1.57\text{ MB}$ to $786\text{ KB}$ before GZip, or $\sim 180\text{ KB}$ over the wire), and `Cache-Control: public, max-age=31536000, immutable`.
   - **100% Client-Side Re-Computation ($<5\text{ ms}$):** Once the epoch buffers and `known_objects` are loaded in the browser, changing comparison modes (blink, pass subtraction, co-addition), scrubbing wavelengths ($0.75\text{–}5.0\ \mu\text{m}$), checking/unchecking known celestial objects, or clicking any bright body to track it backward/forward across epochs executes entirely in client memory without additional fetch calls.

---

### 3.2 `SkyPatchManifest` & `CatalogOverlays` Schema
Returned by `GET /api/v1/sky-patch?ra={deg}&dec={deg}&fov={arcmin}` and stored at `/presets/{slug}/manifest.json`:

```json
{
  "query": {
    "ra": 133.7951,
    "dec": -7.2451,
    "fov_arcmin": 5.0,
    "grid_key": "ra133.80_dec-7.25_fov5.0",
    "cached": true
  },
  "target_metadata": {
    "slug": "wise_0855",
    "name": "WISE 0855",
    "category": "Ultra-Cold Brown Dwarf",
    "description": "Closest/fastest known sub-brown dwarf (~250 K); invisible in optical/short-IR (Detectors 1-3) and blazes at 4.5 microns (Detectors 5-6).",
    "constellation": "Hydra"
  },
  "data_source_summary": {
    "primary_mission": "SPHEREx",
    "has_multi_epoch_spherex": true,
    "uses_wise_fallback": false,
    "baseline_days": 182.7,
    "status_note": "2 SPHEREx survey passes (6-month baseline)"
  },
  "wcs": {
    "width": 256,
    "height": 256,
    "crval": [133.7951, -7.2451],
    "crpix": [128.0, 128.0],
    "cdelt": [-0.0003255, 0.0003255]
  },
  "epochs": [
    {
      "epoch_id": "pass_1",
      "label": "Pass 1 (SPHEREx)",
      "mission": "SPHEREx",
      "mjd": 60810.5,
      "iso_date": "2025-05-15T12:00:00Z",
      "detectors_data_url": "/api/v1/frames/ra133.80_dec-7.25_fov5.0/pass_1.bin",
      "flags_mask_url": "/api/v1/frames/ra133.80_dec-7.25_fov5.0/pass_1_flags.bin",
      "available_detectors": [1, 2, 3, 4, 5, 6],
      "binary_dtype": "float32"
    },
    {
      "epoch_id": "pass_2",
      "label": "Pass 2 (SPHEREx)",
      "mission": "SPHEREx",
      "mjd": 60993.2,
      "iso_date": "2025-11-14T04:48:00Z",
      "detectors_data_url": "/api/v1/frames/ra133.80_dec-7.25_fov5.0/pass_2.bin",
      "flags_mask_url": "/api/v1/frames/ra133.80_dec-7.25_fov5.0/pass_2_flags.bin",
      "available_detectors": [1, 2, 3, 4, 5, 6],
      "binary_dtype": "float32"
    }
  ],
  "default_spectrum_url": "/presets/wise_0855/spectrum.json",
  "catalog_overlays": {
    "known_objects": [
      {
        "object_id": "wise:J085510.83-071442.5",
        "label": "WISE 0855 (Sub-Brown Dwarf)",
        "catalog": "wise",
        "object_type": "brown_dwarf_candidate",
        "ra": 133.7951,
        "dec": -7.2451,
        "x": 128.0,
        "y": 128.0,
        "magnitude": 14.0,
        "proper_motion_arcsec_yr": 8.12,
        "w1_w2_color": 3.8,
        "default_checked": true,
        "epoch_positions": [
          { "epoch_id": "pass_1", "mjd": 60810.5, "ra": 133.7956, "dec": -7.2452, "x": 126.4, "y": 127.7 },
          { "epoch_id": "pass_2", "mjd": 60993.2, "ra": 133.7945, "dec": -7.2450, "x": 129.8, "y": 128.3 }
        ]
      },
      {
        "object_id": "gaia:57648291038471",
        "label": "Gaia DR3 57648291038471",
        "catalog": "gaia_dr3",
        "object_type": "star",
        "ra": 133.7912,
        "dec": -7.2410,
        "x": 140.2,
        "y": 115.4,
        "magnitude": 16.4,
        "proper_motion_arcsec_yr": 0.013,
        "w1_w2_color": null,
        "default_checked": false,
        "epoch_positions": [
          { "epoch_id": "pass_1", "mjd": 60810.5, "ra": 133.7912, "dec": -7.2410, "x": 140.2, "y": 115.4 },
          { "epoch_id": "pass_2", "mjd": 60993.2, "ra": 133.7912, "dec": -7.2410, "x": 140.2, "y": 115.4 }
        ]
      }
    ],
    "gaia_dr3": [
      {
        "source_id": "57648291038471",
        "ra": 133.7912,
        "dec": -7.2410,
        "x": 140.2,
        "y": 115.4,
        "g_mag": 16.4,
        "bp_rp": 1.25,
        "pmra": -12.4,
        "pmdec": 4.1
      }
    ],
    "wise_sources": [
      {
        "source_id": "J085510.83-071442.5",
        "ra": 133.7951,
        "dec": -7.2451,
        "x": 128.0,
        "y": 128.0,
        "w1_mag": 17.8,
        "w2_mag": 14.0,
        "w1_w2_color": 3.8
      }
    ],
    "most_solar_system": [
      {
        "object_name": "3I/ATLAS",
        "epoch_id": "pass_1",
        "ra": 133.7980,
        "dec": -7.2480,
        "x": 119.1,
        "y": 136.8,
        "v_mag": 18.2
      }
    ]
  }
}
```
*(Note: For static presets in `/public/presets/{slug}/`, `detectors_data_url` and `flags_mask_url` point to `/presets/{slug}/pass_1.bin`, etc., so the exact same loader and IndexedDB cache work for both presets and live queries.)*

---

### 3.3 Binary Pixel Buffer Format (`pass_{N}.bin` & `pass_{N}_flags.bin`)
To avoid JSON parsing overhead on 2D images, minimize 3G bandwidth, and enable $<2\text{ ms}$ client-side pixel math:
- **`pass_{N}.bin` (`Float32Array` or `Float16` wire format decoded to `Float32Array`):**
  - Canonical in-memory format is little-endian `float32` of shape `(6, 256, 256)` ($1,572,864\text{ bytes}$ uncompressed, $\sim 350\text{ KB}$ gzipped).
  - For 3G optimization, `/api/v1/frames/{grid_key}/pass_{N}.bin?precision=float16` optionally serves `float16` ($786,432\text{ bytes}$ uncompressed, $\sim 180\text{ KB}$ gzipped) with header `X-Binary-Dtype: float16`, which the client decodes into `Float32Array` on receipt and stores in IndexedDB.
  - Plane index `0..5` corresponds to Detectors `1..6` aligned on the shared $256 \times 256$ WCS grid (units: surface brightness in $\text{MJy/sr}$):
    - Index `0` (Detector 1): $0.75\text{–}1.10\ \mu\text{m}$
    - Index `1` (Detector 2): $1.10\text{–}1.60\ \mu\text{m}$
    - Index `2` (Detector 3): $1.60\text{–}2.42\ \mu\text{m}$
    - Index `3` (Detector 4): $2.42\text{–}3.80\ \mu\text{m}$ *(WISE $W1\ 3.4\ \mu\text{m}$ fallback maps here)*
    - Index `4` (Detector 5): $3.80\text{–}4.40\ \mu\text{m}$ *(WISE $W2\ 4.6\ \mu\text{m}$ fallback maps here)*
    - Index `5` (Detector 6): $4.40\text{–}5.00\ \mu\text{m}$ *(WISE $W2\ 4.6\ \mu\text{m}$ fallback maps here)*
  - When an epoch originates from archival **WISE/NEOWISE** fallback (`mission: "WISE"`), Planes `3` ($W1$) and `4–5` ($W2$) hold the calibrated surface brightness and `available_detectors` is `[4, 5, 6]`, allowing the client's subtraction and infrared wavelength math to work identically without special casing.
- **`pass_{N}_flags.bin` (`Uint8Array`):** Raw `uint8` buffer of shape `(256, 256)` ($65,536\text{ bytes}$) encoding data hygiene bitmasks:
  - Bit `0` (`1`): Transient / Cosmic Ray
  - Bit `1` (`2`): Saturated Pixel
  - Bit `2` (`4`): Dead / Bad Reference Pixel
  - Bit `3` (`8`): Stray Light / Optical Ghost / Uncovered Border

---

### 3.4 Fast Asynchronous Catalogs Contract (`GET /api/v1/catalogs?ra={deg}&dec={deg}&fov={arcmin}`)
Returns `{ "query": ..., "wcs": ..., "catalog_overlays": ... }` (including the unified `known_objects` array with `default_checked` flags and multi-epoch `epoch_positions`, plus `gaia_dr3`, `wise_sources`, and `most_solar_system`) in $\sim 1\text{–}2\text{ seconds}$ so the frontend can immediately populate the **Known Celestial Objects Checkbox Menu** and plot checked objects on the sky patch while SPHEREx/WISE FITS cutouts are still processing.

---

### 3.5 Spectrum Contract (`GET /api/v1/spectrum?ra={deg}&dec={deg}`)
Also used for `/presets/{slug}/spectrum.json`:
```json
{
  "ra": 133.7951,
  "dec": -7.2451,
  "source_label": "WISE 0855",
  "spectrum_origin": "SPHEREx 102-Band Forced Photometry",
  "units": { "wavelength": "um", "flux": "MJy/sr" },
  "channels": [
    { "band_index": 1, "detector": 1, "wavelength_um": 0.75, "flux": 0.012, "variance": 0.002, "flagged": false },
    { "band_index": 102, "detector": 6, "wavelength_um": 5.00, "flux": 4.850, "variance": 0.041, "flagged": false }
  ],
  "molecular_features": [
    { "molecule": "H2O", "min_um": 2.95, "max_um": 3.30, "label": "Water Ice & Vapor" },
    { "molecule": "CH4", "min_um": 3.20, "max_um": 3.55, "label": "Methane Absorption" },
    { "molecule": "CO2", "min_um": 4.20, "max_um": 4.35, "label": "Carbon Dioxide" },
    { "molecule": "CO", "min_um": 4.55, "max_um": 4.80, "label": "Carbon Monoxide" }
  ]
}
```

---

### 3.6 Earth-to-Sky Zenith Contract (`GET /api/v1/earth-to-sky?lat={deg}&lon={deg}&iso_time={iso}`)
If `lat` or `lon` is omitted (user location data is unavailable or denied), the backend automatically picks a random capital city from `WORLD_CAPITAL_CITIES`, sets `is_fallback_capital: true`, and caches both the Zenith lookup and the overhead sky patch in SQLite:
```json
{
  "earth": {
    "lat": -1.2921,
    "lon": 36.8219,
    "iso_time": "2026-11-14T16:21:00Z",
    "city_name": "Nairobi",
    "country": "Kenya",
    "is_fallback_capital": true,
    "cached": true
  },
  "zenith_icrs": { "ra": 286.5663, "dec": -1.2921, "constellation": "Aquila" }
}
```

---

### 3.7 Frontend Shared State Interface (`SkyExplorerContext`)
To allow **Dev 4** (Interactive Viewport, IndexedDB Cache, Pixel & Bright-Body Tracking Engine) and **Dev 5** (App Shell, Known-Object Checkbox UI, Controls & Spectral Inspector) to work in parallel without blocking each other, both code against this shared React context interface in `frontend/src/types/contracts.ts`:

```typescript
export type ComparisonMode = 'blink' | 'subtract' | 'coadd';
export type ContrastStretch = 'asinh' | 'linear' | 'zscale';
export type CatalogSourceType = 'gaia_dr3' | 'wise' | 'most';
export type CelestialObjectCategory =
  | 'star'
  | 'high_pm_star'
  | 'brown_dwarf_candidate'
  | 'solar_system'
  | 'variable_star'
  | 'infrared_source';

export interface KnownObjectEpochPosition {
  epoch_id: string;
  mjd: number;
  ra: number;
  dec: number;
  x: number;
  y: number;
}

export interface KnownCelestialObject {
  object_id: string;
  label: string;
  catalog: CatalogSourceType;
  object_type: CelestialObjectCategory;
  ra: number;
  dec: number;
  x: number;
  y: number;
  magnitude: number | null;
  proper_motion_arcsec_yr: number | null;
  w1_w2_color: number | null;
  default_checked: boolean;
  epoch_positions: KnownObjectEpochPosition[];
}

export interface ViewportRenderSettings {
  mode: ComparisonMode;
  activeEpochIndex: number;
  passAIndex: number;
  passBIndex: number;
  coaddIndices: number[];
  wavelengthRangeUm: [number, number]; // [0.75, 5.0]
  contrastStretch: ContrastStretch;
  showGaiaOverlay: boolean;
  showWiseOverlay: boolean;
  showMostOverlay: boolean;
  showFlagsOverlay: boolean;
  checkedObjectIds: string[]; // IDs of known_objects checked by the user to highlight & label across epochs
  zoom: number; // Interactive viewport zoom factor (1.0 .. 8.0)
  panX: number; // Horizontal pan offset in 256x256 image pixels
  panY: number; // Vertical pan offset in 256x256 image pixels
}

export interface TracedWaypoint {
  epoch_id: string;
  epoch_index: number;
  mjd: number;
  iso_date: string;
  x: number;
  y: number;
  ra: number;
  dec: number;
  peak_flux: number;
  snr: number;
  status: 'tracked' | 'lost' | 'out_of_bounds' | 'low_snr';
  visible: boolean;
}

export interface TracedObjectSummary {
  trackId: string;
  groupId: string;
  branchIndex: number;
  totalBranchesInClick: number;
  isOverlappedAtOrigin: boolean;
  color: string; // Distinct color for this target's tracking square
  status: 'tracked' | 'partially_lost' | 'no_body_found';
  statusMessage: string;
  originEpochIndex: number; // The frame index where the user clicked to detect the bright body
  clickX: number;
  clickY: number;
  originCentroidX: number;
  originCentroidY: number;
  ra: number;
  dec: number;
  x1: number;
  y1: number;
  xN: number;
  yN: number;
  waypoints: TracedWaypoint[]; // Detected positions across previous (backward) and future (forward) epochs
  lostEpochIds: string[];
  properMotionArcsecPerYr: number;
  positionAngleDeg: number;
  matchedObjectId: string | null;
  matchedCatalog: CatalogSourceType | null;
  matchedLabel: string | null;
  isUncatalogedMover: boolean;
}

export interface SkyExplorerContextValue {
  // Active sky patch & progressive loading state
  activePresetSlug: string | null;
  coordinates: { ra: number; dec: number; fovArcmin: number };
  manifest: SkyPatchManifest | null;
  epochBuffers: Float32Array[][] | null; // [epochIndex][detector 0..5]
  flagsBuffers: Uint8Array[] | null;     // [epochIndex]
  loadingState: {
    stage: 'idle' | 'loading_catalogs' | 'loading_cutouts' | 'ready' | 'error';
    message?: string;
    fromClientCache?: boolean;
  };
  // Playback & render settings (including pan & zoom)
  renderSettings: ViewportRenderSettings;
  updateRenderSettings: (partial: Partial<ViewportRenderSettings>) => void;
  setViewportZoomPan: (zoom: number, panX: number, panY: number) => void;
  resetViewportZoomPan: () => void;
  // Known celestial objects checkbox selection controls
  knownObjects: KnownCelestialObject[];
  toggleKnownObject: (objectId: string) => void;
  checkAllKnownObjects: () => void;
  uncheckAllKnownObjects: () => void;
  resetDefaultKnownObjects: () => void;
  // Playback transport
  playback: {
    isPlaying: boolean;
    isLooping: boolean; // MUST default to false
    fps: number;
    play: () => void;
    pause: () => void;
    stepForward: () => void;
    stepBackward: () => void;
    toggleLoop: () => void;
    setFps: (fps: number) => void;
  };
  // Selection, multi-spot & overlapped bright-body tracking & spectral inspection
  selectedObject: TracedObjectSummary | null;
  trackedTargets: TracedObjectSummary[];
  lastClickDiagnostic: {
    clickX: number;
    clickY: number;
    epochIndex: number;
    status: 'tracked' | 'partially_lost' | 'no_body_found';
    message: string;
    tracksAdded: number;
  } | null;
  removeTrackedTarget: (trackId: string) => void;
  clearTrackedTargets: () => void;
  activeSpectrum: SpectrumPayload | null;
  isSpectrumLoading: boolean;
  // Navigation & interaction actions
  selectPreset: (slug: string) => void;
  navigateToCoordinates: (ra: number, dec: number, fovArcmin?: number) => void;
  inspectPixelOrCoord: (x: number, y: number, originEpochIndex?: number) => void;
}
```
