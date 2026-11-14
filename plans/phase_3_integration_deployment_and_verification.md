# Phase 3: End-to-End Integration, Scale-to-Zero Deployment & Verification (Hours 9–12)

## 1. Phase Objective
Connect the parallel Backend (`Devs 1, 2, 3`) and Frontend (`Devs 4, 5`) tracks into a cohesive production application, verify 3G two-tier caching (SQLite + IndexedDB) and client-side re-computation, deploy the unified container to Fly.io with scale-to-zero (`suspend`) and persistent SQLite caching, and verify every scientific and user flow across the 6 showcase targets and live Zenith queries.

---

## 2. Phase 3 Issues (See `/issues/` for Full Topological Specs)

### Issue `ISS-21` (`[21]`): End-to-End Progressive API Wiring, 3G Client Cache & Multi-Mission Fallback Integration (`@carsonak`)
- **Assignee:** `@carsonak` (Fullstack / QA / Integration & Deployment)
- **Blocked By:** `ISS-10`, `ISS-13`, `ISS-14`, `ISS-15`, `ISS-16`, `ISS-17`, `ISS-19`, `ISS-20`
- **Blocking:** `ISS-22`
- **Goal:** Connect `SkyExplorerProvider` in the frontend to the Two-Tier Client Cache (Memory + IndexedDB), the $0\text{ ms}$ static preset path (`/presets/{slug}/...`), and the progressive live backend path (`/api/v1/earth-to-sky`, `/api/v1/catalogs`, `/api/v1/sky-patch`, `/api/v1/frames/...`, `/api/v1/spectrum`).
- **What the End Result Looks Like:**
  - **Preset Selection ($0\text{ ms}$):** Clicking any of the 6 showcase presets loads its static `manifest.json`, `.bin` frames, `known_objects`, and `spectrum.json` immediately and caches them in Memory/IndexedDB.
  - **Live Sky Exploration (2-Stage Progressive Flow + 3G Cache):**
    1. When a user clicks *"What's Above Me?"* (including automatic random capital city fallback when user location data is unavailable), enters custom `(RA, Dec)` coordinates, or clicks a new region in Aladin Lite, the frontend first checks its IndexedDB cache (`star_hunters_patch_cache_v1`).
    2. On cache miss, the Aladin sky map pans immediately and `GET /api/v1/catalogs` populates the **Known Celestial Objects Checkbox Menu** (`known_objects` with `default_checked` movers checked) and sky map overlays within $\sim 1\text{–}2\text{ s}$.
    3. In parallel, `GET /api/v1/sky-patch` resolves the WCS-aligned binary epochs (using multi-epoch SPHEREx where available, or automatic SPHEREx + WISE/NEOWISE fallback when SPHEREx has $<2$ passes at that coordinate) and streams the compressed `.bin` buffers into the $256 \times 256$ viewport and IndexedDB.
    4. Once loaded, all configurable user actions — combining epochs (blink, subtract, co-add), changing wavelength colorization, panning/zooming (`1x`–`8x`), checking/unchecking known objects (including Check All / Uncheck All), and clicking one or more image spots (including overlapped bodies) to detect and track their backward/forward positions across epochs with colored tracking squares — execute 100% client-side with zero network calls.

---

### Issue `ISS-22` (`[22]`): Unified Docker Packaging, Fly.io Scale-to-Zero Deployment & Scientific Verification (`@carsonak`)
- **Assignee:** `@carsonak` (Fullstack / QA / Integration & Deployment)
- **Blocked By:** `ISS-13`, `ISS-20`, `ISS-21`
- **Blocking:** None (`[]`)
- **Goal:** Package the Vite static frontend build and FastAPI backend into a single multi-stage Docker container and deploy to Fly.io (`iad` region for optimal bandwidth to Caltech/IPAC IRSA) configured with `auto_stop_machines = "suspend"` and a persistent $1\text{ GB}$ SQLite volume.
- **End-to-End Verification Matrix (Acceptance Criteria):**
  1. **WISE 0855 (`wise_0855`):**
     - Stepping from Pass 1 to Pass 2 (non-looping) shows clear positional movement; dragging the wavelength filter to $3.8\text{–}5.0\ \mu\text{m}$ dims background stars while WISE 0855 blazes in red (Detectors 5–6); clicking it on either Pass 1 or Pass 2 detects the bright body and tracks its waypoints backward/forward across epochs; deep $\text{H}_2\text{O}/\text{CH}_4$ features appear in the 102-band spectrum.
  2. **Barnard's Star (`barnards_star`):**
     - Switching to **Subtract ($\text{Pass } B - \text{Pass } A$)** cancels stationary field stars and reveals a sharp positive/negative proper-motion dipole; clicking it matches the Gaia DR3 source ($\mu \approx 10.3''/\text{yr}$).
  3. **Known Celestial Objects Checkbox Menu (Check All / Uncheck All):**
     - Opening the Known Objects menu shows all cataloged objects in the current patch with notable movers checked by default; clicking **Check All** highlights and labels all cataloged objects on the canvas; clicking **Uncheck All** clears all known-object labels cleanly; toggling individual checkboxes updates the SVG overlay in $<2\text{ ms}$ with zero network activity.
  4. **Click-to-Track Multi-Spot & Overlapped Bright Bodies Backward & Forward Across Frames + Pan/Zoom:**
     - Clicking near a bright source on Pass 2 highlights the centroid on Pass 2 and automatically finds its previous position on Pass 1 (and future positions on Pass 3+ when present); clicking overlapped bodies tracks all separated branches with distinct tracking square colors (`TRACKING_SQUARE_COLORS`); clicking multiple spots tracks multiple targets simultaneously; edge cases (`no_body_found`, `lost`, `low_snr`, `out_of_bounds`) and viewport panning/zooming (`1x`–`8x`) work cleanly.
  5. **3G Caching Verification:**
     - Switching modes, wavelengths, pan/zoom, epoch combinations, and object checkboxes triggers zero HTTP requests in the browser network tab; revisiting a previously loaded sky patch loads immediately from IndexedDB / SQLite cache.
  6. **"What's Above Me?" Live Zenith & Random Capital City Fallback Test:**
     - Clicking *"Use My Location"* converts Earth `(Lat, Lon)` to Zenith `(RA, Dec)` (or automatically picks a random capital city from `WORLD_CAPITAL_CITIES` when user location data is unavailable and caches its Zenith lookup and sky patch in SQLite), immediately pans Aladin Lite, loads asynchronous `known_objects`, and resolves the multi-epoch SPHEREx/WISE sky patch.
