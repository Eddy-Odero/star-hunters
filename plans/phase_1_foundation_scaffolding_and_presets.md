# Phase 1: Foundation, Monorepo Scaffolding & Golden Target Presets (Hours 0–2)

## 1. Phase Objective
Unblock all 5 developers within the first two hours so Frontend (Devs 4 & 5) and Backend (Devs 1, 2 & 3) can build in parallel without waiting on live NASA archive queries or one another's components.

By the end of Phase 1:
1. The repository has a working `/backend` (Python 3.11+ + FastAPI) and `/frontend` (React + TypeScript + Vite) setup with validated Pydantic and TypeScript schemas matching [Phase 0](phase_0_master_architecture_shared_contracts.md), including `KnownCelestialObject` (with multi-epoch `epoch_positions` and `default_checked`), `TracedObjectSummary` (with `originEpochIndex` and backward/forward `waypoints`), and Two-Tier 3G cache metadata.
2. Deterministic synthetic preset bundles exist in `frontend/public/presets/` within the first 45 minutes so Devs 4 & 5 can immediately build and test the canvas viewport, pass subtraction, wavelength filtering, known-object checkbox filtering, backward/forward bright-body tracking, and 102-band spectral plot.
3. The pre-computation batch pipeline generates static bundles for all **12 Showcase Targets** (the 6 core hackathon targets: *WISE 0855, Barnard's Star, Epsilon Indi B, RW Aurigae, R Draconis, Comet 3I/ATLAS*, plus 6 additional iconic SPHEREx science targets: *Luhman 16 AB, Wolf 359, Teegarden's Star, CW Leonis, T Tauri, (1) Ceres*) along with `/presets/global_known_objects.json` so demo presets and global fuzzy search load in $0\text{ ms}$.

---

## 2. Showcase Benchmark Targets Reference Table

| Preset Slug | Target Name | RA (Decimal $^{\circ}$) | Dec (Decimal $^{\circ}$) | Expected Visual, Known-Object & Spectral Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `wise_0855` | **WISE 0855** | $133.7951^\circ$ | $-7.2451^\circ$ | **Ultra-Cold Brown Dwarf ($\sim 250\text{ K}$):** Rapid proper motion ($\sim 8.1''/\text{yr}$); invisible in Detectors $1\text{–}3$ ($<2.4\ \mu\text{m}$), blazes brightly in Detectors $5\text{–}6$ ($3.8\text{–}5.0\ \mu\text{m}$) and WISE $W2$. Flagged `default_checked: true` in `known_objects`. |
| `barnards_star` | **Barnard's Star** | $269.4521^\circ$ | $+4.6934^\circ$ | **Fastest Proper Motion Star ($10.3''/\text{yr}$):** Bright across all 6 detectors; produces an unmistakable high-contrast positive/negative linear dipole in $\text{Pass } B - \text{Pass } A$ subtraction mode and traces cleanly backward/forward across epochs on click. |
| `epsilon_indi_b` | **Epsilon Indi B** | $331.0438^\circ$ | $-56.7827^\circ$ | **Binary Brown Dwarf ($T1 + T6$):** Co-moving infrared pair with deep $\text{H}_2\text{O}$ ($3.0\ \mu\text{m}$) and $\text{CH}_4$ ($3.3\ \mu\text{m}$) absorption troughs in the 102-band spectrum. |
| `rw_aurigae` | **RW Aurigae** | $76.9565^\circ$ | $+30.4014^\circ$ | **T Tauri Variable Star:** Stationary sky coordinates (zero spatial dipole), but leaves a strong positive/negative brightness ring in subtraction mode due to circumstellar disk dimming/flaring. |
| `r_draconis` | **R Draconis** | $248.1676^\circ$ | $+66.7548^\circ$ | **Mira-Type Pulsating Red Giant:** Stationary position with dramatic periodic infrared flux swings across epochs and strong molecular bands ($\text{H}_2\text{O}, \text{CO}$). |
| `comet_3i_atlas` | **Comet 3I/ATLAS** | $295.3200^\circ$ *(or MOST epoch lookup)* | $-18.4100^\circ$ *(or MOST epoch lookup)* | **Moving Solar System / Interstellar Comet:** Rapidly shifting position across exposures (`most_solar_system` + `known_objects` multi-epoch track) with prominent $\text{H}_2\text{O}$ ice/vapor ($3.0\ \mu\text{m}$) and $\text{CO}_2$ ($4.26\ \mu\text{m}$) coma emission peaks. |
| `luhman_16` | **Luhman 16 AB** | $162.3288^\circ$ | $-53.3195^\circ$ | **Closest Binary Brown Dwarf ($L7.5 + T0.5$ at $1.99\text{ pc}$):** Rapid proper motion ($2.79''/\text{yr}$) in Vela with resolved $A$ & $B$ components and strong $\text{CH}_4/\text{H}_2\text{O}$ bands. |
| `wolf_359` | **Wolf 359** | $164.1203^\circ$ | $+7.0147^\circ$ | **Nearby High-PM M6.5Ve Flare Star ($4.70''/\text{yr}$):** One of the nearest stars to the Sun ($2.41\text{ pc}$) in Leo with strong steam bands. |
| `teegardens_star` | **Teegarden's Star** | $43.2537^\circ$ | $+16.8813^\circ$ | **Ultracool M7.0V Dwarf ($5.12''/\text{yr}$):** Nearby exoplanet host in Aries with fast diagonal dipole motion across SPHEREx passes. |
| `cw_leonis` | **CW Leonis (IRC +10216)** | $146.9892^\circ$ | $+13.2788^\circ$ | **Carbon-Rich AGB Star:** Thick circumstellar dust shell with steep mid-IR continuum rising toward $4.8\ \mu\text{m}$ and $\text{C}_2\text{H}_2/\text{CO}$ features. |
| `t_tauri` | **T Tauri** | $65.4976^\circ$ | $+19.5351^\circ$ | **Prototype Young Stellar Object:** Variable YSO in Taurus with deep $3.08\ \mu\text{m}$ $\text{H}_2\text{O}$ ice and $4.27\ \mu\text{m}$ $\text{CO}_2$ ice absorption bands. |
| `ceres_asteroid` | **(1) Ceres** | $198.4120^\circ$ | $+8.2150^\circ$ | **Main-Belt Dwarf Planet:** Fast Solar System mover (`most_solar_system`) with $3.06\ \mu\text{m}$ ammoniated phyllosilicate and carbonate absorption features. |

---

## 3. Phase 1 Deliverables

### `ISS-01`: Monorepo Scaffolding & Shared Contract Definitions
- **Goal:** Establish the repository structure, build tooling, and shared data contract types for both Backend and Frontend so all 5 developers can branch and work without merge conflicts.
- **What the End Result Looks Like:**
  - `/backend` initialized with Python 3.11+, FastAPI, Uvicorn, Pydantic v2 / JSON Schema models mirroring Section 3 of [Phase 0](phase_0_master_architecture_shared_contracts.md) (including `KnownCelestialObject`, `KnownObjectEpochPosition`, `TracedWaypoint`, `TracedObjectSummary`, `SkyPatchManifest`, `CatalogsResponse`, `SpectrumPayload`, `EarthToSkyResponse` with `WORLD_CAPITAL_CITIES` fallback), and a `/health` endpoint.
  - `/frontend` initialized with React, TypeScript, and Vite, containing `src/types/contracts.ts` and `src/context/SkyExplorerContext.tsx` (with known-object checkbox state helpers, pan/zoom controls, multi-spot & overlapped bright-body tracking with colored tracking squares, and non-looping playback controls).
- **Acceptance Criteria:**
  - Backend starts cleanly and `GET /health` returns `200 OK` with `{"status": "ok"}`.
  - Frontend compiles and runs (`pnpm build` and `pnpm test`) with zero TypeScript errors.
  - Contract validation tests confirm that sample payloads from Phase 0 pass both Pydantic validation and TypeScript type-checking.

---

### `ISS-02`: Instant Synthetic Preset Generator (Unblock Frontend in <45 Minutes)
- **Goal:** Generate realistic, contract-compliant static preset files in `frontend/public/presets/` immediately so Frontend Devs 4 & 5 have multi-epoch binary buffers, `known_objects` checkbox tracks, and 102-band spectra to develop against before live IRSA downloads complete.
- **What the End Result Looks Like:**
  - A standalone script (`scripts/generate_synthetic_presets.py`) that outputs `manifest.json`, `pass_1.bin`, `pass_2.bin`, `pass_1_flags.bin`, `pass_2_flags.bin`, and `spectrum.json` into `frontend/public/presets/{slug}/` for all 6 benchmark targets in Section 2.
  - Stationary background stars remain at identical $(x, y)$ pixel locations across epochs so they cancel cleanly under subtraction, while each benchmark target exhibits its signature astrophysical behavior (e.g., `wise_0855` shifts by several pixels between Pass 1 and Pass 2 and emits primarily in Detectors 5–6; `rw_aurigae` remains stationary while changing flux; `barnards_star` shifts across all 6 detectors).
  - Includes populated `catalog_overlays.known_objects` with per-epoch `epoch_positions`, `default_checked: true` on notable movers and `false` on stationary field stars, plus `gaia_dr3`, `wise_sources`, `most_solar_system`, and 102-channel spectral curves with molecular absorption/emission features ($\text{H}_2\text{O}, \text{CH}_4, \text{CO}_2, \text{CO}$).
- **Acceptance Criteria:**
  - Running the generator populates all 6 target folders under `frontend/public/presets/{slug}/`.
  - Every `pass_{N}.bin` is exactly $1,572,864\text{ bytes}$ (`Float32Array` of shape `(6, 256, 256)`) and every `pass_{N}_flags.bin` is $65,536\text{ bytes}$ (`Uint8Array` of shape `(256, 256)`).
  - Every generated `manifest.json` and `spectrum.json` validates against the Phase 0 Pydantic schemas.

---

### `ISS-20`: Golden Target Pre-Computation Batch Script (Real Archive Data + Fallback)
- **Goal:** Upgrade the preset bundles in `frontend/public/presets/` with real pre-computed astronomical data from IRSA (SPHEREx + WISE/NEOWISE), Gaia DR3, and NASA MOST for the 6 showcase targets (while retaining `--fallback-synthetic` resilience) so judges experience instant $0\text{ ms}$ loading of real space telescope data.
- **Acceptance Criteria:**
  - All 6 preset directories in `frontend/public/presets/` contain complete, non-NaN binary buffers, real Gaia/WISE/MOST `known_objects` tracks, and 102-band spectra.
  - Loading `/presets/{slug}/manifest.json` from the frontend renders multi-epoch sky data with zero network calls to external NASA servers during the demo.
