"""SPHEREx 32-bit FLAGS bitmap to 8-bit application hygiene mask mapping."""

from __future__ import annotations

from typing import Any

import numpy as np

# Application-level hygiene mask bits.
FLAG_TRANSIENT = np.uint8(1)
FLAG_SATURATED = np.uint8(2)
FLAG_BAD_REFERENCE = np.uint8(4)
FLAG_STRAY_LIGHT = np.uint8(8)

HYGIENE_FLAG_BITS = {
    "TRANSIENT_OR_COSMIC_RAY": int(FLAG_TRANSIENT),
    "SATURATED_PIXEL": int(FLAG_SATURATED),
    "DEAD_OR_BAD_REFERENCE": int(FLAG_BAD_REFERENCE),
    "STRAY_LIGHT_OR_BORDER": int(FLAG_STRAY_LIGHT),
}

# Native SPHEREx Level 2 flag bit numbers (SPHEREx Explanatory Supplement,
# Table 16). The first four entries also make the low byte of the raw FLAGS
# bitmap directly usable by clients that provide simplified fixture masks.
SPHEREX_FLAG_BITS = {
    "TRANSIENT": 0,
    "OVERFLOW": 1,
    "SUR_ERROR": 2,
    "NONFUNC": 6,
    "DICHROIC": 7,
    "MISSING_DATA": 9,
    "HOT": 10,
    "COLD": 11,
    "FULLSAMPLE": 12,
    "PHANMISS": 14,
    "NONLINEAR": 15,
    "PERSIST": 17,
    "OUTLIER": 19,
    "CROSSTALK": 20,
    "SOURCE": 21,
    "GHOST": 22,
    "GHOST_FPA": 23,
    "GHOST_EXT": 24,
    "STREAK": 25,
    "BLOOM": 26,
    "SNOWBALL": 27,
    "HALO": 28,
    "SATELLITE_HALO": 29,
}

SPHEREX_FLAG_GROUPS = {
    "TRANSIENT_OR_COSMIC_RAY": (
        "TRANSIENT",
        "OUTLIER",
        "STREAK",
        "SNOWBALL",
    ),
    "SATURATED_PIXEL": (
        "OVERFLOW",
        "NONLINEAR",
        "BLOOM",
    ),
    "DEAD_OR_BAD_REFERENCE": (
        "SUR_ERROR",
        "NONFUNC",
        "DICHROIC",
        "MISSING_DATA",
        "HOT",
        "COLD",
        "FULLSAMPLE",
        "PHANMISS",
        "PERSIST",
        "CROSSTALK",
    ),
    "STRAY_LIGHT_OR_BORDER": (
        "GHOST",
        "GHOST_FPA",
        "GHOST_EXT",
        "HALO",
        "SATELLITE_HALO",
    ),
}


def _build_group_bitmask(flag_names: tuple[str, ...]) -> np.uint32:
    """Combine native SPHEREx flag bit positions into a single ``uint32`` bitmask.

    Args:
        flag_names: Tuple of keys in :data:`SPHEREX_FLAG_BITS`.

    Returns:
        Combined ``uint32`` bitmask covering all specified flag positions.
    """
    bitmask = 0
    for name in flag_names:
        bitmask |= 1 << SPHEREX_FLAG_BITS[name]
    return np.uint32(bitmask)


_HYGIENE_GROUP_BITMASKS: tuple[tuple[np.uint32, np.uint8], ...] = (
    (_build_group_bitmask(SPHEREX_FLAG_GROUPS["TRANSIENT_OR_COSMIC_RAY"]), FLAG_TRANSIENT),
    (_build_group_bitmask(SPHEREX_FLAG_GROUPS["SATURATED_PIXEL"]), FLAG_SATURATED),
    (_build_group_bitmask(SPHEREX_FLAG_GROUPS["DEAD_OR_BAD_REFERENCE"]), FLAG_BAD_REFERENCE),
    (_build_group_bitmask(SPHEREX_FLAG_GROUPS["STRAY_LIGHT_OR_BORDER"]), FLAG_STRAY_LIGHT),
)


def as_uint32_bitmap(flags: Any) -> tuple[np.ndarray, np.ndarray]:
    """Normalize arbitrary flag array values into a ``uint32`` bitmap and invalid mask.

    Args:
        flags: Array-like SPHEREx flag values (integer or floating-point).

    Returns:
        Tuple of ``(raw_uint32_bitmap, invalid_boolean_mask)``.
    """
    flag_array = np.asarray(flags)

    if np.issubdtype(flag_array.dtype, np.floating):
        invalid = ~np.isfinite(flag_array)
        safe = np.nan_to_num(
            flag_array,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )
        raw = (safe.astype(np.int64, copy=False) & np.int64(0xFFFFFFFF)).astype(np.uint32)
        return raw, invalid

    if flag_array.dtype == np.uint32:
        raw = flag_array
    elif flag_array.dtype == np.int32:
        raw = flag_array.view(np.uint32)
    else:
        raw = (flag_array.astype(np.int64, copy=False) & np.int64(0xFFFFFFFF)).astype(np.uint32)

    return raw, np.zeros(flag_array.shape, dtype=bool)


def map_flags_to_hygiene(flags: Any) -> np.ndarray:
    """Map the 32-bit SPHEREx ``FLAGS`` bitmap to the 8-bit web hygiene mask.

    Output bit meanings:
        - ``1``: Transient / cosmic ray
        - ``2``: Saturated pixel
        - ``4``: Dead / bad reference / corrupted
        - ``8``: Stray light / border / ghost

    Args:
        flags: Array-like SPHEREx 32-bit flag bitmap.

    Returns:
        ``uint8`` hygiene mask array matching ``flags`` shape.
    """
    raw, invalid = as_uint32_bitmap(flags)
    mask = np.array(raw & np.uint32(0x0F), dtype=np.uint8, copy=True)

    for group_mask, hygiene_bit in _HYGIENE_GROUP_BITMASKS:
        mask[(raw & group_mask) != 0] |= hygiene_bit

    if invalid.any():
        mask[invalid] |= FLAG_BAD_REFERENCE

    return mask
