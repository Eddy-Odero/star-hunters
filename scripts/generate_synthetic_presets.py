#!/usr/bin/env python3
"""Generate contract-compliant synthetic preset bundles for all showcase targets."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.services.preset_builder import generate_all_synthetic_presets  # noqa: E402


def main() -> int:
    """Generate and validate synthetic preset bundles into ``frontend/public/presets/``."""
    presets_dir = REPO_ROOT / "frontend" / "public" / "presets"
    slugs = generate_all_synthetic_presets(output_root=presets_dir)
    print(f"Generated and validated {len(slugs)} preset bundles: {', '.join(slugs)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
