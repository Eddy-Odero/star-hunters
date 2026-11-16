# Star Hunters: Planet X & SPHEREx Blinker

An interactive multi-epoch near-infrared sky discovery web application ($0.75\text{-}5.0\ \mu\text{m}$ across 6 detector arrays and 102 spectral channels). Built for the [NASA Space Apps Challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/?tab=details), Star Hunters lets both space enthusiasts and researchers visually compare sky images taken at different times, filter by infrared wavelength, track moving celestial objects, inspect full near-infrared spectra, and explore what is currently above their location.

---

## Background Context

Modern wide-field infrared sky surveys capture the same patches of sky multiple times over months or years. By comparing ("blinking" or subtracting) images from different epochs, stationary background stars cancel out cleanly, making moving objects (such as high-proper-motion stars, ultra-cold brown dwarfs, comets, asteroids, or hypothetical outer Solar System bodies like Planet X) and variable stars stand out immediately.

Star Hunters turns this workflow into a fast, browser-based discovery tool with pre-computed showcase targets, live multi-survey sky-patch queries, and real-time Solar System ephemeris lookups.

---

## Data Sources & Technologies

### Astronomical Data Sources
- **[NASA SPHEREx](https://spherex.caltech.edu/)** (*Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer*): Multi-epoch near-infrared spectral images ($0.75\text{-}5.0\ \mu\text{m}$) queried via the [NASA/IPAC IRSA](https://irsa.ipac.caltech.edu/Missions/spherex.html) [TAP](https://irsa.ipac.caltech.edu/TAP) service.
- **[WISE / NEOWISE](https://irsa.ipac.caltech.edu/Missions/wise.html)** (*Wide-field Infrared Survey Explorer / Near-Earth Object WISE*): Archival $W1$ ($3.4\ \mu\text{m}$) and $W2$ ($4.6\ \mu\text{m}$) infrared cutouts used to extend multi-epoch coverage across a 10 to 15 year baseline.
- **[NASA SkyView](https://skyview.gsfc.nasa.gov/)** (*2MASS J/H/K & DSS2 IR / Red*): Secondary archival FITS cutout fallback when both SPHEREx and WISE have zero spatial coverage at the requested sky coordinate (commonly needed near active Solar System planetary longitudes).
- **[SIMBAD TAP (IDIA & Harvard CfA Mirrors)](https://simbad.idia.ac.za/simbad/sim-tap/sync)**: Canonical astronomical object identifiers (`main_id`) and object classifications (`otype`), routed through IDIA (`simbad.idia.ac.za`) and Harvard CfA (`simbad.cfa.harvard.edu`) mirrors.
- **[ESA Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3)**: High-precision optical astrometry and proper motions (`J2016.0` propagated to pass epochs), queried via ESA TAP (`gea.esac.esa.int`) with ARI Heidelberg TAP and VizieR Harvard CfA fallbacks.
- **[NASA/JPL Horizons](https://ssd.jpl.nasa.gov/api/horizons.api)**: Live current-epoch geocentric ephemerides and daily SQLite-indexed tracks for major planets (e.g., Saturn, Jupiter), moons, comets (`3I/ATLAS`), and asteroids.
- **[NASA/IPAC MOST](https://irsa.ipac.caltech.edu/applications/MOST/)**: Solar System object intersections against specific SPHEREx exposures.

### Tech Stack
- **Backend:** [Python 3.11+](https://www.python.org/), [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn](https://www.uvicorn.org/), [Pydantic](https://docs.pydantic.dev/), [NumPy](https://numpy.org/), [Astropy](https://www.astropy.org/), [Reproject](https://reproject.readthedocs.io/), [Astroquery](https://astroquery.readthedocs.io/), and [SQLite](https://www.sqlite.org/) (`WAL` mode for quantized $0.05^\circ$ spatial caching).
- **Frontend:** [React 18](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/), [pnpm](https://pnpm.io/), HTML5 Canvas + SVG, [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) two-tier client caching, and [CDS Aladin Lite v3](https://aladin.cds.unistra.fr/AladinLite/doc/) WebGL all-sky globe.
- **Deployment:** Multi-stage [Docker](https://www.docker.com/) image configured for [Fly.io](https://fly.io/docs/reference/configuration/) scale-to-zero hosting with a persistent SQLite volume.

---

## Configuration & Environment Variables

### Backend Runtime Configuration (`fly.toml` & Local Env)
| Variable | Default | Description |
| :--- | :--- | :--- |
| `ENABLE_ARCHIVAL_DATA` | `"false"` locally (`"true"` in `fly.toml`) | Enables live remote archival cutout fetching in `/api/v1/sky-patch` using the ordered fallback chain: **SPHEREx IRSA** -> **WISE / NEOWISE** -> **NASA SkyView (2MASS / DSS2 IR / Red)** -> **Labeled Simulated Multi-Band Baseline**, with optional **JPL Horizons** ephemeris rendering when an active Solar System body crosses the patch. When `"false"`, live uncached patches return the labeled simulated baseline cleanly for offline/test determinism. |
| `SQLITE_DB_PATH` | `backend/data/spherex_cache.db` (`/data/spherex_cache.db` on Fly.io) | Path to the WAL-mode SQLite spatial and ephemeris cache database. |
| `LOG_LEVEL` | `INFO` | Backend startup logging threshold (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`). |
| `LOG_FORMAT` | `text` | Backend log output format (`text` for human-readable structured lines, `json` for single-line JSON log records) unified across `star_hunters`, `uvicorn`, and `astropy`. |
| `IRSA_CONNECT_TIMEOUT_S` | `3.5` | TCP connect timeout (seconds) for upstream IRSA requests. |
| `IRSA_DISCOVERY_TIMEOUT_S` | `10.0` | Read timeout (seconds) for IRSA SIA/TAP observation discovery. |
| `IRSA_CUTOUT_TIMEOUT_S` | `8.0` | Read timeout (seconds) per SPHEREx FITS cutout download. |
| `SPHEREX_INGEST_BUDGET_S` | `16.0` | Total wall-clock budget (seconds) for SPHEREx cutout downloads per patch/spectrum before failing fast or falling back. |
| `ARCHIVAL_RESOLVE_BUDGET_S` | `18.0` | Shared deadline (seconds) across the `SPHEREx -> WISE -> SkyView` archival fallback chain. |
| `IRSA_CIRCUIT_COOLDOWN_S` | `45.0` | Cooldown duration (seconds) for the shared IRSA outage circuit breaker. |
| `PORT` | `8000` | HTTP listen port for FastAPI / Uvicorn. |

### Frontend Build & Runtime Logging Configuration
| Variable / Override | Default | Description |
| :--- | :--- | :--- |
| `VITE_LOG_LEVEL` | `info` | Build-time frontend logger level (`debug`, `info`, `warn`, `error`, `silent`). |
| `VITE_LOG_BUFFER_SIZE` | `250` | Maximum number of discrete event entries retained in the in-memory ring buffer (`window.__STAR_HUNTERS_LOGS__`, clamped between `20` and `2000`). |
| `localStorage` / Global Console Helpers | Unset | Override at runtime via `localStorage.setItem('star_hunters_log_level', 'debug')` or `window.__STAR_HUNTERS_SET_LOG_LEVEL__('debug')` to inspect real-time globe, search, loader, and blinker events. |

---

## Interactive Observatory Features

- **Curated NASA Curtain Landing:** Random high-definition landscape NASA imagery with attribution badge while background warmup fetches `/health` and the 12 showcase presets.
- **Night-Sky Globe & Progressive Click Zoom:** Starry black WebGL sphere powered by Aladin Lite v3 with IRSA `allWISE`, `2MASS`, and `SPHEREx` HiPS Level-of-Detail switching, toggleable IAU constellation lines and labels, North-up arrow (`↑ / ← / ↓ / →`) pan and `+ / - / Reset` zoom controls plus focus-scoped keyboard shortcuts (`Arrow` keys / `WASD`, `Shift` fine step, `+`/`-`, `0` reset), progressive 2-click zoom into visible $0.05^\circ$ sky panels, and direct click-to-inspect inside any panel.
- **Multi-Pass Blinker & Provenance Display:** Synchronized `(6, 256, 256)` scientific cutouts supporting Blink, Subtract (`IMAGE - ZODI`), and Co-Add stacking modes, dual-thumb `0.75-5.0 um` wavelength slider, explicit image survey provenance pill (`SPHEREx Archival (Primary)`, `WISE / NEOWISE (Extension)`, `NASA SkyView (DSS2 IR / Red)`, `JPL Horizons Ephemeris`, or `Simulated Multi-Band Baseline`), and an inline **Known Objects** tab inside Blinker controls for quick checking/unchecking without leaving the inspector.
- **Hover-Delay & Click-Locked Callout Details:** Hovering a labeled source shows a frosted glass callout card after a short delay without occluding the object (flipping away from edges and controls automatically), while clicking locks the card until clicking elsewhere or closing it.
- **102-Band Forced Photometry Spectra:** Interactive spectral plot with a reserved bottom readout strip below the plot canvas so hovering across channels causes zero layout jitter, plus CSV export.

---

## Repository Layout

```text
star-hunters/
├── backend/                  # Python 3.11+ FastAPI backend & scientific data pipeline
│   ├── app/
│   │   ├── main.py           # FastAPI routes, single-flight coalescing, archival cascade & SPA serving
│   │   ├── models/           # Shared Pydantic contracts & seeded catalog/ephemeris metadata
│   │   └── services/         # Quantized SQLite cache, structured logging, SkyView/WISE/SPHEREx & catalogs
│   └── tests/                # Backend contract, ingestion, fallback, logging & pipeline test suite
├── frontend/                 # React + TypeScript + Vite single-page application
│   ├── public/presets/       # Pre-computed static bundles for the 12 showcase targets + global search index
│   ├── src/
│   │   ├── components/       # NightSkyGlobe, BlinkerModal, SpectraModal, Search/Zenith, Curtain, Tutorial
│   │   ├── context/          # SkyExplorerContext & NotificationContext
│   │   ├── services/         # Two-tier ClientPatchCache (memory + IndexedDB) & progressive loader
│   │   └── utils/            # Contracts math, smart callout placement, observatoryLogger & globe helpers
│   └── tests/                # Frontend unit test suite (node --test)
├── ARCHITECTURE.md           # System design, binary protocols, archival pipeline & state-flow reference
├── plans/                    # Historical phase execution plans & API reference links
├── scripts/                  # Preset generators & GitHub issue management scripts
├── Dockerfile                # Multi-stage container build (pnpm frontend + FastAPI backend)
└── fly.toml                  # Fly.io deployment, env vars & persistent volume configuration
```

---

## Running Locally

### Prerequisites
- **Python 3.11+**
- **Node.js 20+** and **[pnpm](https://pnpm.io/installation)** (never `npm`)

### 1. Start the Backend API
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
ENABLE_ARCHIVAL_DATA=true LOG_LEVEL=INFO uvicorn app.main:app --reload --port 8000
```
The API runs at `http://127.0.0.1:8000` (health check at `/health`).

### 2. Start the Frontend Dev Server
In a separate terminal:
```bash
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```
Open `http://localhost:5173`. Vite proxies `/api` and `/health` requests to `http://127.0.0.1:8000`.

### 3. Optional: Seed Cache, Regenerate Presets & Verify Suites
```bash
# Pre-seed SQLite with JPL Horizons ephemerides, SIMBAD/Gaia regions & IRSA MOST matches
backend/.venv/bin/python scripts/seed_celestial_cache.py --db-path /tmp/star_hunters_cache.db

# Regenerate static preset bundles for showcase targets
python3 scripts/generate_synthetic_presets.py

# Backend checks
python -m compileall -q backend/
ruff check backend/ && ruff format --check backend/
(cd backend && .venv/bin/pytest -v)

# Frontend checks
pnpm --dir frontend exec tsc --noEmit
pnpm --dir frontend lint
pnpm --dir frontend format:check
pnpm --dir frontend test
pnpm --dir frontend build
```

### 4. Production Deployment (Fly.io)
Manual deploy:
```bash
flyctl deploy
```
Automatic CI-gated deployment from `main` is configured in [.github/workflows/fly-deploy.yml](.github/workflows/fly-deploy.yml) (runs `flyctl deploy --remote-only` only after `Star Hunters CI (Lint, Typecheck & Tests)` succeeds on `main`). To enable it once:
```bash
flyctl tokens create deploy -a star-hunters-spherex -x 999999h \
  | gh secret set FLY_API_TOKEN --repo Eddy-Odero/star-hunters
```
See [ARCHITECTURE.md](ARCHITECTURE.md) for container lifecycle, binary streaming format, archival fallback flow, and client-side rendering details.

---

## Disclaimer

This project was built with AI assistance, and the code was verified by human authors.
