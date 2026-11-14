# Star Hunters — Planet X & SPHEREx Blinker

An interactive multi-epoch near-infrared discovery platform ($0.75\text{–}5.0\ \mu\text{m}$ across $6$ detector arrays and $102$ spectral channels) built for the NASA Space Apps Challenge, uniting **NASA SPHEREx**, **WISE/NEOWISE**, **ESA Gaia DR3**, and **NASA MOST**.

---

## 1. Architecture & Master Plans
- **[Phase 0: Master Architecture, Team Parallelization & Shared Contracts](plans/phase_0_master_architecture_shared_contracts.md)**
- **[Phase 1: Foundation, Monorepo Scaffolding & Golden Target Presets](plans/phase_1_foundation_scaffolding_and_presets.md)**
- **[Phase 2: Core Parallel Workstreams (5-Developer Sprint)](plans/phase_2_core_parallel_workstreams.md)**
- **[Phase 3: End-to-End Integration, Scale-to-Zero Deployment & Verification](plans/phase_3_integration_deployment_and_verification.md)**
- **[Links, APIs & Technical References](plans/links.md)**
- **[Topologically Ordered Issue Backlog (`ISS-01` to `ISS-22`)](issues/README.md)** ([`issues/all_issues.json`](issues/all_issues.json))

---

## 2. Core Features & Architecture Highlights
1. **3G-Optimised Two-Tier Caching & 100% Client-Side Option Calculation:**
   - **Tier 1 (Backend SQLite Cache + Binary Compression):** The FastAPI backend preprocesses FITS cutouts (`IMAGE - ZODI` subtraction, `FLAGS` hygiene bitmask extraction, $256 \times 256$ `TAN` WCS alignment, and asynchronous catalog queries), stores them in a quantized ($0.05^\circ$) SQLite `WAL` cache with LRU pruning, and streams `Float32`/`Float16` binary buffers with `GZipMiddleware` and `Cache-Control: public, max-age=31536000, immutable`.
   - **Tier 2 (Browser Cache + IndexedDB):** The React + TypeScript frontend caches manifests, catalog overlays, and decoded binary frames in Memory + IndexedDB (`star_hunters_patch_cache_v1`) so all user-configurable options — **combining epochs** (blink, pass subtraction, co-addition), **wavelength "Dim & Pop" filtering** ($0.75\text{–}5.0\ \mu\text{m}$), **known-object checkbox filtering**, and **click-to-track** — run locally in $<5\text{ ms}$ with zero network round-trips.
2. **Asynchronous Known-Object Tracking + Checkbox List UI (`Check All` / `Uncheck All`):**
   - The backend asynchronously queries and cross-matches **Gaia DR3**, **WISE**, and **NASA MOST**, propagating each known object's pixel coordinates across every observation epoch (`epoch_positions`).
   - On the frontend, a **Known Celestial Objects Checkbox Menu** (with **Check All**, **Uncheck All**, and **Notable Movers Only** buttons) lets users select which cataloged objects are highlighted and labeled on each image to track their movement without visual clutter.
3. **Multi-Spot & Overlapped Bright-Body Detection, Colored Tracking Squares & Backward/Forward Multi-Frame Tracking:**
   - Clicking any spot on any currently viewed image (`originEpochIndex`) detects and highlights the local **"bright" body** in the general pixels in that area on that image, and automatically tracks its position across both **previous (backward) and future (forward) epochs** (`waypoints` across all frames).
   - **Overlapped Bodies at Click:** If the area of clicking has more than one body at that epoch that separate in earlier or later epochs, all separated bodies are tracked as distinct trajectory branches (`isOverlappedAtOrigin: true`).
   - **Multi-Spot Tracking & Colored Tracking Squares:** Supports clicking multiple spots to track different targets simultaneously (`trackedTargets`), rendering each target with a distinct tracking square color (`TRACKING_SQUARE_COLORS`) and handling edge cases (`no_body_found`, `lost`, `low_snr`, `out_of_bounds`).
   - **Interactive Panning & Zooming:** Synchronized `<canvas>` and `<svg>` pan and zoom (`zoom: 1..8`, `panX`, `panY`).
4. **"What's Above Me?" Zenith Bridge with Random Capital City Fallback & Backend Caching:**
   - Converts user `(lat, lon)` to overhead ICRS `(RA, Dec, constellation)`, automatically falling back to a **random world capital city** (`WORLD_CAPITAL_CITIES`) when user location data is unavailable and caching capital city Zenith lookups and overhead sky patches in SQLite.
5. **Click-to-Spectrum ($102$-Band Near-Infrared Spectrophotometry):**
   - Inspects the $0.75\text{–}5.0\ \mu\text{m}$ spectrum across all 102 SPHEREx channels with shaded diagnostic molecular bands ($\text{H}_2\text{O}, \text{CH}_4, \text{CO}_2, \text{CO}$) and one-click CSV export.

---

## 3. Repository Structure

```text
star-hunters/
├── backend/                  # Python 3.11+ FastAPI backend & scientific pipeline
│   ├── app/
│   │   ├── main.py           # FastAPI routes, progressive endpoints & binary streaming
│   │   ├── models/           # Immutable Phase 0 contracts & JSON/Pydantic schemas
│   │   └── services/         # Quantized SQLite spatial cache (WAL + LRU pruning)
│   └── tests/                # Backend contract, binary buffer & cache test suite
├── frontend/                 # React + TypeScript + Vite SPA
│   ├── public/presets/       # Pre-computed static bundles for the 6 Showcase Targets
│   ├── src/
│   │   ├── context/          # SkyExplorerContext provider
│   │   ├── services/         # Two-Tier Client Cache (Memory + IndexedDB)
│   │   └── types/            # Shared TypeScript contracts, Float16 decoder & multi-frame tracker
│   └── tests/                # Node test suite for contracts, 3G cache & backward/forward tracking
├── issues/                   # 22 topologically ordered issues (both .json and .md per issue)
├── plans/                    # Phase 0 - Phase 3 master architecture & execution plans
├── scripts/                  # Preset generators & GitHub CLI (`gh`) issue publisher
├── Dockerfile                # Multi-stage unified container build
└── fly.toml                  # Fly.io scale-to-zero (`suspend`) configuration
```

---

## 4. Quick Start & Verification

```bash
# 1. Run backend contract, binary buffer, SQLite cache & topological issue tests
PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v

# 2. Generate/refresh static preset bundles for the 6 showcase targets
python3 scripts/generate_synthetic_presets.py

# 3. Run frontend contract, Float16 3G decoder, cache & backward/forward tracking tests
cd frontend && npm test
```
