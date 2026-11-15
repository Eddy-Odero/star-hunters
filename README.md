# Star Hunters — Planet X & SPHEREx Blinker

An interactive multi-epoch near-infrared sky discovery web application ($0.75\text{–}5.0\ \mu\text{m}$ across 6 detector arrays and 102 spectral channels). Built for the [NASA Space Apps Challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/?tab=details), Star Hunters lets both space enthusiasts and researchers visually compare sky images taken at different times, filter by infrared wavelength, track moving celestial objects, inspect full near-infrared spectra, and explore what is currently above their location.

---

## Background Context

Modern wide-field infrared sky surveys capture the same patches of sky multiple times over months or years. By comparing ("blinking" or subtracting) images from different epochs, stationary background stars cancel out—making moving objects (such as high-proper-motion stars, ultra-cold brown dwarfs, comets, asteroids, or hypothetical outer Solar System bodies like Planet X) and variable stars stand out immediately.

Star Hunters turns this workflow into a fast, browser-based discovery tool with pre-computed showcase targets as well as live sky-patch queries.

---

## Data Sources & Technologies

### Astronomical Data Sources
- **[NASA SPHEREx](https://spherex.caltech.edu/)** (*Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer*) — Multi-epoch near-infrared spectral images ($0.75\text{–}5.0\ \mu\text{m}$) queried via the [NASA/IPAC IRSA](https://irsa.ipac.caltech.edu/Missions/spherex.html) (*Infrared Processing and Analysis Center / Infrared Science Archive*) [TAP](https://irsa.ipac.caltech.edu/TAP) (*Table Access Protocol*) service.
- **[WISE / NEOWISE](https://irsa.ipac.caltech.edu/Missions/wise.html)** (*Wide-field Infrared Survey Explorer / Near-Earth Object WISE*) — Archival $W1$ ($3.4\ \mu\text{m}$) and $W2$ ($4.6\ \mu\text{m}$) infrared cutouts used to supplement sparse SPHEREx coverage with a 10–15 year time baseline.
- **[SIMBAD TAP (IDIA & Harvard CfA Mirrors)](https://simbad.idia.ac.za/simbad/sim-tap/sync)** — Canonical astronomical object identifiers (`main_id`) and object classifications (`otype`), routed through official IDIA (`simbad.idia.ac.za`) and Harvard CfA (`simbad.cfa.harvard.edu`) mirrors (avoiding `cds.unistra.fr`).
- **[ESA Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3)** (*European Space Agency Gaia Data Release 3*) — High-precision optical astrometry and proper motions (`J2016.0` propagated to SPHEREx pass epochs), queried via ESA TAP (`gea.esac.esa.int`) with automatic ARI Heidelberg TAP and VizieR Harvard CfA TSV fallbacks.
- **[NASA/JPL Horizons](https://ssd.jpl.nasa.gov/api/horizons.api)** — Daily geocentric ephemerides for major planets, Galilean/Saturnian moons, comets (`3I/ATLAS`), and main-belt asteroids (`(1) Ceres`, `(4) Vesta`) indexed in SQLite for sub-millisecond FOV intersection lookups.
- **[NASA/IPAC MOST](https://irsa.ipac.caltech.edu/applications/MOST/)** (*Moving Object Search Tool*) — Solar System object intersections against specific SPHEREx exposures (`output_mode=Brief`).

### Tech Stack
- **Backend:** [Python 3.11+](https://www.python.org/), [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn](https://www.uvicorn.org/), [Pydantic](https://docs.pydantic.dev/), [NumPy](https://numpy.org/), [Astropy](https://www.astropy.org/), [Reproject](https://reproject.readthedocs.io/), [Astroquery](https://astroquery.readthedocs.io/), and [SQLite](https://www.sqlite.org/) (using Write-Ahead Logging / `WAL` mode for spatial caching).
- **Frontend:** [React 18](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/), [pnpm](https://pnpm.io/), HTML5 Canvas + SVG, [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) for offline/3G-friendly client-side frame caching, and [CDS Aladin Lite v3](https://aladin.cds.unistra.fr/AladinLite/doc/) (*Centre de Données astronomiques de Strasbourg* WebGL all-sky map).
- **Deployment:** Multi-stage [Docker](https://www.docker.com/) image configured for [Fly.io](https://fly.io/docs/reference/configuration/) scale-to-zero hosting with a persistent SQLite volume.

---

## Repository Layout

```text
star-hunters/
├── backend/                  # Python 3.11+ FastAPI backend & scientific data pipeline
│   ├── app/
│   │   ├── main.py           # FastAPI routes (/api/v1/* & /api/* aliases), binary streaming & SPA serving
│   │   ├── models/           # Shared contracts, JSON schemas & seeded catalog/ephemeris metadata
│   │   └── services/         # Quantized SQLite spatial/ephemeris cache & SIMBAD/Gaia/Horizons/MOST pipeline
│   └── tests/                # Backend contract, ingestion, coadd & catalog pipeline test suite
├── frontend/                 # React + TypeScript + Vite single-page application
│   ├── public/presets/       # Pre-computed static bundles for the 12 showcase targets + global search index
│   ├── src/
│   │   ├── context/          # SkyExplorerContext shared application state
│   │   ├── services/         # Two-tier client cache (in-memory + IndexedDB)
│   │   └── types/            # TypeScript contracts, Float16 decoder & multi-frame tracker
│   └── tests/                # Frontend contract, cache & tracking test suite
├── plans/                    # Architecture, phase execution plans & API reference links
├── scripts/                  # Preset generators & GitHub issue management scripts
├── Dockerfile                # Multi-stage container build (pnpm frontend + FastAPI backend)
└── fly.toml                  # Fly.io deployment & persistent volume configuration
```

---

## Running Locally

### Prerequisites
- **Python 3.11+**
- **Node.js 20+** and **[pnpm](https://pnpm.io/installation)** (or `corepack enable`)

### 1. Start the Backend API
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
The API will be available at `http://127.0.0.1:8000` (health check at `/health`).

### 2. Start the Frontend Dev Server
In a separate terminal:
```bash
cd frontend
pnpm install
pnpm dev
```
Open `http://localhost:5173` in your browser. Vite automatically proxies `/api` and `/health` requests to `http://127.0.0.1:8000`.

### 3. Optional: Seed Cache, Regenerate Presets & Run Tests
```bash
# Pre-seed SQLite with JPL Horizons ephemerides (planets/moons/comets/asteroids),
# SIMBAD/Gaia DR3 regions, and IRSA MOST SPHEREx matches
backend/.venv/bin/python scripts/seed_celestial_cache.py --db-path /tmp/star_hunters_cache.db

# Regenerate static preset bundles for the 12 showcase targets
python3 scripts/generate_synthetic_presets.py

# Run backend tests
(cd backend && .venv/bin/pytest -v)

# Run frontend tests & build
cd frontend && pnpm test
```

### 4. Production Deployment (Fly.io)
The root `Dockerfile` builds `frontend/dist` with `pnpm` and serves both the static SPA and `/api/v1/*` endpoints from a single FastAPI container. `fly.toml` configures `primary_region = "iad"`, scale-to-zero (`auto_stop_machines = "suspend"`, `min_machines_running = 0`), and a persistent `/data` volume for `/data/spherex_cache.db`:

```bash
flyctl apps create star-hunters-spherex --org personal
flyctl volumes create spherex_cache_vol --region iad --size 1 -a star-hunters-spherex -y
flyctl deploy --remote-only
```

---

## Further Documentation

Detailed architecture, data contracts, and phase-by-phase implementation notes live in [`plans/`](plans/):
- [Phase 0: Master Architecture, Team Parallelization & Shared Contracts](plans/phase_0_master_architecture_shared_contracts.md)
- [Phase 1: Foundation, Monorepo Scaffolding & Golden Target Presets](plans/phase_1_foundation_scaffolding_and_presets.md)
- [Phase 2: Core Parallel Workstreams](plans/phase_2_core_parallel_workstreams.md)
- [Phase 3: End-to-End Integration, Scale-to-Zero Deployment & Verification](plans/phase_3_integration_deployment_and_verification.md)
- [Links, APIs & Technical References](plans/links.md)

---

## Disclaimer

This project was built with AI assistance, and the code was verified by human authors.
