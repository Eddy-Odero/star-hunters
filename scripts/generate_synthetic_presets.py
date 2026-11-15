#!/usr/bin/env python3
"""Generate contract-compliant synthetic preset bundles for all 6 showcase targets."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.main import (  # noqa: E402
    build_sky_patch_manifest_payload,
    build_spectrum_payload,
    generate_synthetic_epoch_frames,
    get_global_known_objects_index,
)
from app.models.contracts import (  # noqa: E402
    SHOWCASE_TARGETS,
    validate_detector_binary_buffer,
    validate_flags_binary_buffer,
    validate_sky_patch_manifest,
    validate_spectrum_payload,
)
from app.models.global_sky_reference_catalog import extend_global_known_objects_index  # noqa: E402


def generate_all_presets(output_root: Path | None = None) -> list[str]:
    """Generate and validate all showcase presets into frontend/public/presets/."""
    presets_dir = output_root or (REPO_ROOT / "frontend" / "public" / "presets")
    presets_dir.mkdir(parents=True, exist_ok=True)
    generated_slugs: list[str] = []

    for slug, meta in SHOWCASE_TARGETS.items():
        target_dir = presets_dir / slug
        target_dir.mkdir(parents=True, exist_ok=True)

        manifest = build_sky_patch_manifest_payload(
            ra=meta["ra"],
            dec=meta["dec"],
            fov_arcmin=5.0,
            slug=slug,
            static_preset_urls=True,
        )
        validate_sky_patch_manifest(manifest)

        spectrum = build_spectrum_payload(
            ra=meta["ra"],
            dec=meta["dec"],
            source_label=meta["name"],
            slug=slug,
        )
        validate_spectrum_payload(spectrum)

        frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)
        for fname, raw_bytes in frames.items():
            if fname.endswith("_flags.bin"):
                validate_flags_binary_buffer(raw_bytes)
            else:
                validate_detector_binary_buffer(raw_bytes, precision="float32")
            (target_dir / fname).write_bytes(raw_bytes)

        (target_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        (target_dir / "spectrum.json").write_text(
            json.dumps(spectrum, indent=2) + "\n", encoding="utf-8"
        )
        generated_slugs.append(slug)

    global_index = extend_global_known_objects_index(get_global_known_objects_index())
    (presets_dir / "global_known_objects.json").write_text(
        json.dumps(global_index, indent=2) + "\n", encoding="utf-8"
    )
    return generated_slugs


if __name__ == "__main__":
    slugs = generate_all_presets()
    print(f"Generated and validated {len(slugs)} preset bundles: {', '.join(slugs)}")
