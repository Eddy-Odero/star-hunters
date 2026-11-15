#!/usr/bin/env python3
"""Batch pre-computation script for the 6 Golden Showcase Targets (with synthetic fallback)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from generate_synthetic_presets import generate_all_presets  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fallback-synthetic",
        action="store_true",
        default=True,
        help=(
            "Fallback to deterministic synthetic presets when live NASA IRSA archive "
            "is unreachable."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPO_ROOT / "frontend" / "public" / "presets",
        help="Target directory for static preset bundles.",
    )
    args = parser.parse_args()

    slugs = generate_all_presets(output_root=args.output_dir)
    print(
        f"[build_presets] Built and validated {len(slugs)} showcase target bundles: "
        f"{', '.join(slugs)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
