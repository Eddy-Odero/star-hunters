# Links, APIs & Technical References

## 1. Hackathon Challenge
- **Challenge Details:** https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/?tab=details
- **Challenge Resources:** https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/?tab=resources

---

## 2. NASA / IPAC IRSA — SPHEREx Data & Tutorials
- **SPHEREx Mission Archive at IRSA:** https://irsa.ipac.caltech.edu/Missions/spherex.html
- **IRSA SPHEREx Python Tutorials (Official Notebooks):** https://caltech-ipac.github.io/irsa-tutorials/spherex/
  - *Introduction to SPHEREx Spectral Images* (Level 2 MEF structure: `IMAGE`, `FLAGS`, `VARIANCE`, `ZODI`, `PSF`, `WCS-WAVE`, and Linear Variable Filter bandpasses `SPHEREx-D1` through `SPHEREx-D6`)
  - *Spectral Image Cutouts* (Querying CAOM-2 tables `spherex.artifact` & `spherex.plane` and downloading spatial cutouts)
  - *SPHEREx Source Discovery Tool* (Image subtraction to isolate red/moving sources, aperture photometry, and spectral extraction)
- **IRSA TAP Endpoint (ADQL Queries):** `https://irsa.ipac.caltech.edu/TAP`
  - **Key SPHEREx Tables:** `spherex.artifact` joined with `spherex.plane` on `planeid`
  - **Bandpass Identifiers:** `p.energy_bandpassname IN ('SPHEREx-D1', 'SPHEREx-D2', 'SPHEREx-D3', 'SPHEREx-D4', 'SPHEREx-D5', 'SPHEREx-D6')`
  - **On-the-Fly Cutout URL Pattern:** `https://irsa.ipac.caltech.edu/{artifact.uri}?center={ra},{dec}d&size={fov_deg}`

---

## 3. Multi-Mission Fallback & Cross-Match Archives (WISE, Gaia DR3, MOST)
- **WISE / NEOWISE Image & Catalog Services (IRSA):**
  - **IRSA AllWISE / NEOWISE Catalogs via TAP:** `https://irsa.ipac.caltech.edu/TAP` (Tables: `allwise_p3as_psd`, `neowiser_p1bs_psd`)
  - **WISE Image Atlas / SIA Cutouts (W1 $3.4\ \mu\text{m}$ & W2 $4.6\ \mu\text{m}$):** https://irsa.ipac.caltech.edu/Missions/wise.html (Accessible via `astroquery.ipac.irsa` / `pyvo` SIA)
- **Gaia DR3 Archive (Optical Astrometry & Proper Motions):**
  - **ESA Gaia TAP Endpoint:** `https://gea.esac.esa.int/tap-server/tap` (Table: `gaiadr3.gaia_source` — columns `source_id`, `ra`, `dec`, `phot_g_mean_mag`, `bp_rp`, `pmra`, `pmdec`, `parallax`)
- **NASA / IPAC MOST (Moving Object Search Tool — Asteroids & Comets):**
  - **Interactive & API Documentation:** https://irsa.ipac.caltech.edu/applications/MOST/
  - **Programmatic CGI Endpoint:** `https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most` (or via `astroquery.ipac.irsa.most`)

---

## 4. Frontend Visualization & Deployment References
- **CDS Aladin Lite v3 (WebGL All-Sky Map):** https://aladin.cds.unistra.fr/AladinLite/doc/
- **Astropy Coordinates (`AltAz` $\rightarrow$ `ICRS`) & WCS Reprojection:**
  - https://docs.astropy.org/en/stable/coordinates/
  - https://reproject.readthedocs.io/en/stable/
- **Fly.io Machine Suspend & Persistent Volumes:** https://fly.io/docs/reference/configuration/
