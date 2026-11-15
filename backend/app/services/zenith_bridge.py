"""Earth-to-Sky Zenith coordinate bridge using Astropy with GMST/LST sidereal fallback."""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime
from typing import Any

from ..models.contracts import WORLD_CAPITAL_CITIES, validate_earth_to_sky_response

try:
    import astropy.units as u
    from astropy.coordinates import ICRS, AltAz, EarthLocation, SkyCoord, get_constellation
    from astropy.time import Time

    HAS_ASTROPY = True
except ImportError:  # pragma: no cover
    HAS_ASTROPY = False


CONSTELLATION_BANDS: list[tuple[float, float, float, float, str]] = [
    (0.0, 90.0, 15.0, 90.0, "Cassiopeia"),
    (30.0, 55.0, 10.0, 28.0, "Aries"),
    (55.0, 75.0, 12.0, 28.0, "Taurus"),
    (60.0, 100.0, 15.0, 45.0, "Auriga"),
    (110.0, 160.0, -25.0, 5.0, "Hydra"),
    (140.0, 175.0, 0.0, 28.0, "Leo"),
    (150.0, 175.0, -60.0, -40.0, "Vela"),
    (180.0, 210.0, -15.0, 20.0, "Virgo"),
    (230.0, 265.0, 50.0, 80.0, "Draco"),
    (250.0, 280.0, -10.0, 15.0, "Ophiuchus"),
    (275.0, 305.0, -10.0, 15.0, "Aquila"),
    (280.0, 310.0, -35.0, -10.0, "Sagittarius"),
    (310.0, 350.0, -70.0, -40.0, "Indus"),
]


def lookup_constellation(ra: float, dec: float) -> str:
    """Resolve constellation name for (ra, dec) in ICRS degrees."""
    if HAS_ASTROPY:
        try:
            coord = SkyCoord(ra=float(ra) * u.deg, dec=float(dec) * u.deg, frame=ICRS())
            return str(get_constellation(coord))
        except Exception:  # pragma: no cover
            pass
    ra_norm = ra % 360.0
    for ra_min, ra_max, dec_min, dec_max, name in CONSTELLATION_BANDS:
        if ra_min <= ra_norm <= ra_max and dec_min <= dec <= dec_max:
            return name
    if dec > 45.0:
        return "Ursa Major"
    if dec < -45.0:
        return "Carina"
    quadrant = int((ra_norm // 90.0) % 4)
    return ["Pegasus", "Orion", "Virgo", "Aquila"][quadrant]


def pick_random_capital_city(seed: int | None = None) -> dict[str, Any]:
    """Select a random world capital city when user geolocation is unavailable."""
    rng = random.Random(seed) if seed is not None else random
    return dict(rng.choice(WORLD_CAPITAL_CITIES))


def find_matching_capital_city(
    lat: float,
    lon: float,
    tolerance_deg: float = 0.08,
) -> dict[str, Any] | None:
    """Return capital city metadata if (lat, lon) matches a curated world capital."""
    for city in WORLD_CAPITAL_CITIES:
        if math.hypot(lat - city["lat"], lon - city["lon"]) <= tolerance_deg:
            return dict(city)
    return None


def _parse_utc_timestamp(iso_time: str | None) -> tuple[datetime, str]:
    """Parse optional ISO-8601 timestamp into UTC datetime and normalized ISO string."""
    if iso_time:
        clean_iso = iso_time.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        else:
            dt = dt.astimezone(UTC)
    else:
        dt = datetime.now(UTC)
    return dt, dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _compute_zenith_gmst_fallback(lat: float, lon: float, dt: datetime) -> tuple[float, float, str]:
    """Compute approximate Zenith (ra, dec, constellation) using GMST/LST sidereal time."""
    unix_ts = dt.timestamp()
    jd = unix_ts / 86400.0 + 2440587.5
    d_j2000 = jd - 2451545.0
    gmst_deg = (280.46061837 + 360.98564736629 * d_j2000) % 360.0
    lst_deg = (gmst_deg + lon) % 360.0
    dec_deg = round(float(lat), 4)
    ra_deg = round(float(lst_deg), 4) % 360.0
    constellation = lookup_constellation(ra_deg, dec_deg)
    return ra_deg, dec_deg, constellation


def compute_zenith_icrs(
    lat: float | None = None,
    lon: float | None = None,
    iso_time: str | None = None,
    fallback_seed: int | None = None,
    *,
    use_astropy: bool = True,
) -> dict[str, Any]:
    """Compute overhead Zenith (RA, Dec) in ICRS for Earth (lat, lon, iso_time).

    If ``lat`` or ``lon`` is None (user location unavailable), picks a random capital city
    from ``WORLD_CAPITAL_CITIES`` and marks ``is_fallback_capital=True``.
    """
    is_fallback_capital = False
    city_name: str | None = None
    country: str | None = None

    if lat is None or lon is None:
        capital = pick_random_capital_city(seed=fallback_seed)
        lat = float(capital["lat"])
        lon = float(capital["lon"])
        city_name = str(capital["city_name"])
        country = str(capital["country"])
        is_fallback_capital = True
    else:
        lat = float(lat)
        lon = float(lon)
        if not (-90.0 <= lat <= 90.0):
            raise ValueError("Latitude must be in [-90.0, 90.0]")
        if not (-180.0 <= lon <= 180.0):
            raise ValueError("Longitude must be in [-180.0, 180.0]")
        matched = find_matching_capital_city(lat, lon)
        if matched is not None:
            city_name = str(matched["city_name"])
            country = str(matched["country"])

    dt, iso_out = _parse_utc_timestamp(iso_time)

    if use_astropy and HAS_ASTROPY:
        obs_time = Time(dt)
        location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=0 * u.m)
        altaz = AltAz(alt=90.0 * u.deg, az=0.0 * u.deg, obstime=obs_time, location=location)
        zenith_icrs = SkyCoord(altaz).transform_to(ICRS())
        ra_deg = round(float(zenith_icrs.ra.deg) % 360.0, 4) % 360.0
        dec_deg = round(max(-90.0, min(90.0, float(zenith_icrs.dec.deg))), 4)
        constellation = str(get_constellation(zenith_icrs))
    else:
        ra_deg, dec_deg, constellation = _compute_zenith_gmst_fallback(lat, lon, dt)

    payload = {
        "earth": {
            "lat": round(float(lat), 4),
            "lon": round(float(lon), 4),
            "iso_time": iso_out,
            "city_name": city_name,
            "country": country,
            "is_fallback_capital": is_fallback_capital,
            "cached": False,
        },
        "zenith_icrs": {
            "ra": ra_deg,
            "dec": dec_deg,
            "constellation": constellation,
        },
    }
    validate_earth_to_sky_response(payload)
    return payload
