# Star Hunters Architecture Overview

This document describes the runtime architecture, binary contracts, multi-survey ingestion cascade, logging subsystem, and frontend interaction model of Star Hunters.

---

## 1. System Topology & Scale-to-Zero Hosting

Star Hunters runs as a single FastAPI service built from a multi-stage `Dockerfile`:

1. **Stage 1 (Frontend Build):** Installs workspace packages via `pnpm --frozen-lockfile` and compiles `frontend/src` into static bundle assets (`frontend/dist`) and pre-computed showcase presets (`frontend/public/presets`).
2. **Stage 2 (Backend & SPA Host):** Runs `uvicorn app.main:app` on port `8000`, serving:
   - API endpoints under `/api/v1/*` and `/api/*` aliases (`/health`, `/api/v1/earth-to-sky`, `/api/v1/catalogs`, `/api/v1/catalogs/search`, `/api/v1/catalogs/object-epochs`, `/api/v1/sky-patch`, `/api/v1/frames/{grid_key}/{filename}`, `/api/v1/spectrum`, `/api/v1/admin/clear-cache`)
   - Static frontend SPA bundles and `/presets/*` assets directly from `frontend/dist` at `/`.
3. **Persistence (`fly.toml`):** Mounts a 1 GB Fly.io volume at `/data` (`SQLITE_DB_PATH="/data/spherex_cache.db"`). SQLite uses Write-Ahead Logging (`WAL`) with quantized `0.05 deg` grid keys and LRU cache pruning so scale-to-zero (`min_machines_running = 0`, `auto_stop_machines = "suspend"`, `memory = "2048mb"`) preserves cached sky patches across VM suspends.

---

## 2. Backend Scientific Pipeline & Archival Fallback Cascade

### Single-Flight Request Coalescing
Concurrent UI requests targeting the same quantized `grid_key` (`{raQ.toFixed(2)}_{decQ.toFixed(2)}`) share an in-process single-flight coordinator (`_run_singleflight` in `backend/app/main.py`) with per-key async locks (`asyncio.Lock`), preventing duplicate SIMBAD, Gaia, Horizons, or FITS download bursts when `/catalogs` and `/sky-patch` arrive simultaneously.

### Multi-Survey Cutout Cascade (`ENABLE_ARCHIVAL_DATA`)
When a quantized sky cell is not yet cached in SQLite:
- When `ENABLE_ARCHIVAL_DATA` is `"true"` (configured in `fly.toml`):
  1. **Primary (`SPHEREx Archival (Primary)`):** Queries NASA/IPAC IRSA TAP for overlapping SPHEREx exposures, ingests spectral FITS cutouts, applies `IMAGE - ZODI` background subtraction, reprojects onto the shared `256 x 256` WCS tangent plane, and packs Detectors 1 to 6 (`0.75-5.0 um`).
  2. **Secondary (`WISE / NEOWISE (Supplemental)`):** If SPHEREx returns zero epochs or a single epoch (`< 2` passes), queries WISE/NEOWISE and downloads only the **latest** quality-screened `W1` (`3.4 um`) and `W2` (`4.6 um`) archival exposure, mapping them across Detectors 4 to 6 as a supplemental comparison frame (does not download full historical NEOWISE time-series).
  3. **Tertiary (`NASA SkyView (2MASS J/H/K / DSS2 IR / Red)`):** If both SPHEREx and WISE have zero coverage at that coordinate, `skyview_fallback.py` fetches real archival FITS plates from NASA SkyView (`2MASS-J/H/K` and `DSS2 IR / Red`) mapped cleanly into `(6, 256, 256)` planes.
  4. **Solar System Ephemeris & MOST Pass-Date Lookup:** All-sky background HiPS mosaics are outlier-rejected archival composites that exclude moving planets, whereas individual SPHEREx Level-2 exposures capture moving Solar System bodies at their archival capture timestamps (discovered via IRSA MOST in `/api/v1/catalogs/object-epochs`). When a queried `WISE` or `SkyView` patch intersects an active moving Solar System body in `Horizons`, `inject_solar_system_ephemeris_overlay` composites predicted JPL Horizons planetary/coma markers onto the archival sky plate.
  5. **Simulated Baseline Fallback (`Simulated Multi-Band Baseline`):** Only if external archives report zero data or network outage does the backend generate deterministic labeled baseline frames.
- When `ENABLE_ARCHIVAL_DATA` is `"false"`, uncached patches immediately generate the labeled simulated baseline so offline unit suites and isolated environments never depend on remote TAP endpoints.

### Binary Payload Contracts
- **Detector Cube:** Binary Little-Endian `(6, 256, 256)` float16 (`786,432` bytes) or float32 (`1,572,864` bytes) served at `/api/v1/frames/{grid_key}/epoch_{k}_detectors.f16`. Client decodes both float16 (via IEEE-754 half-precision lookup/conversion in `contracts.ts`) and float32 to `Float32Array[]` planes.
- **Hygiene Mask:** `(256, 256)` `uint8` array (`65,536` bytes) compactly representing 32-bit SPHEREx `FLAGS` contamination categories (`COSMIC_RAY`, `SATURATED`, `DEAD_HOT_PIXEL`, `PERSISTENCE`, `NEARBY_BRIGHT_STAR`, etc.), decoded on cursor hover in Blinker without polluting starfields with static overlays.

---

## 3. Frontend Architecture

### Context & State Management
- **`SkyExplorerContext.tsx`:** Coordinates active preset/target state, debounced URL state synchronization (`replaceUrlState` deduplicating identical URLs to satisfy browser `history.replaceState` quotas), two-tier client caching (`ClientPatchCache`: memory LRU + IndexedDB `star_hunters_patch_cache_v1`), progressive `loadPresetPatchFlow` / `loadLiveCoordinatesFlow`, epoch playback (`isLooping = false` default), and live backend `/api/v1/catalogs/search` merges (carrying live JPL Horizons coordinates for planets and comets).
- **`NotificationContext.tsx`:** Manages warning/error banners plus bottom-right async progress/success toast cards (`startAsyncTask`, `finishAsyncTask` supporting `status: 'progress' | 'success'` and timed `autoDismissMs`).

### Viewport & Interaction Pipeline
1. **`LandingCurtainOverlay.tsx`:** Displays a random high-resolution NASA landscape photograph with corner attribution while app initialization runs behind it, fading smoothly out after click (`1050ms` vertical slide + accelerated `640ms` opacity fade).
2. **`NightSkyGlobe.tsx`:** Renders Aladin Lite v3 (`SIN` projection, pure black background) with IRSA HiPS Level-of-Detail switching (`allWISE` wide -> `2MASS` deep -> optional `SPHEREx`), projected IAU constellation lines and labels (`constellations.ts`), North-up arrow (`↑/←/↓/→`) pan and (`+`, `-`, `Reset`) zoom dock with focus-scoped keyboard shortcuts (`globeNavigation.ts`), and 2-stage progressive click zoom (`>15 deg -> 8 deg`, `<=15 deg -> 1.6 deg`), revealing interactive quantized `0.05 deg` sky panel cells only when zoomed in (`<= 2.5 deg`). Clicking any panel opens Blinker directly at that cell. Canvas fallback animation pauses whenever Blinker is open so zero background RAF churn steals frames.
3. **`BlinkerModal.tsx` & `calloutPlacement.ts`:**
   - Supports **Blink**, **Subtract**, and **Add** comparison modes plus the dual-thumb `0.75-5.0 um` "Dim & Pop" spectral weight curve.
   - Displays explicit survey provenance via `formatImageProvenanceBadge(manifest.data_source_summary)`.
   - Provides an inline **Known Objects** tab right inside `.blinker-controls-card` with `Select All`, `Clear All`, and `Untrack` controls.
   - Implements hover-delay (`850ms`) preview over labeled catalog objects or tracked targets and immediate click-locking (`lockedCallout` dismissed by clicking elsewhere on sky/stage or the card close button).
   - Uses `computeSmartCalloutLayout` to keep frosted-glass callout cards from overlapping the inspected star, controls card, or viewport edges, connected with a thin `1px` leader polyline.
4. **`SpectraModal.tsx`:** Plots the 102-band continuum spectrum, molecular absorption bands (`H2O`, `CH4`, `CO2`, `CO`), detector boundaries, and a fixed-height (`22px`) bottom hover telemetry bar that updates wavelength and flux without reflowing upper labels.
5. **`SpotlightTourOverlay.tsx`:** Uses 4 static composite dark scrim strips + highlight border ring (avoiding `box-shadow: 0 0 0 9999px` backdrop re-rasterization stalls) with an `AbortController`/clean resize listener and zero `localStorage` step persistence.

---

## 4. Observability & Structured Event Logging

Both halves emit startup-configurable events across discrete operational boundaries:
- **Backend (`backend/app/services/logging_config.py`):** Configured once at startup via `configure_backend_logging()` reading `LOG_LEVEL` and `LOG_FORMAT`, recording request lifecycle, single-flight hits/waits, SQLite cache read/write, IRSA TAP queries, SkyView/WISE fallbacks, Horizons resolution, and cutout build timings.
- **Frontend (`frontend/src/utils/observatoryLogger.ts`):** Singleton `observatoryLogger` initialized from `VITE_LOG_LEVEL`, `VITE_LOG_BUFFER_SIZE`, and runtime `localStorage` / window globals, logging curtain dismissal, globe zoom/pan/constellation toggles, live search hits, loader steps, callout hover/lock transitions, and API latencies into a bounded ring buffer.
