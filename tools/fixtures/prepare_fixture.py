#!/usr/bin/env python3
"""Prepare urdfk fixture folders for Zoo/ModelBuilder ingestion.

This helper is intentionally standalone and keeps upstream URDF_kitchen untouched.
It stages one fixture format folder (dae/stl/unity/mjcf), rewrites mesh filename
references in URDF to point at mesh files that actually exist in that staged
folder, and applies known packaging quirks (e.g. remove nested unity urdf).
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

SUPPORTED_FORMATS = ("dae", "stl", "unity", "mjcf")
MESH_EXTS = (".dae", ".stl", ".obj")

PREFERRED_EXT = {
    "dae": ".dae",
    "stl": ".stl",
    "unity": ".dae",
    "mjcf": ".obj",
}

FALLBACK_EXT = {
    ".dae": [".stl", ".obj"],
    ".stl": [".dae", ".obj"],
    ".obj": [".dae", ".stl"],
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage and rewrite a urdfk fixture for Zoo")
    p.add_argument("--format", required=True, choices=SUPPORTED_FORMATS)
    p.add_argument(
        "--fixture-root",
        default="/home/stuart/KinematicTrees/test/urdfk_exports/miro",
        help="root containing format folders (dae/stl/unity/mjcf)",
    )
    p.add_argument(
        "--out-dir",
        default="/tmp/zoo-fixtures-prepared",
        help="output root; staged format folder will be created inside this path",
    )
    p.add_argument(
        "--clear-out",
        action="store_true",
        help="delete existing out-dir/<format> before staging",
    )
    return p.parse_args()


def index_meshes(root: Path) -> dict[tuple[str, str], str]:
    """Map (stem.lower(), ext.lower()) -> best relative path."""
    mesh_map: dict[tuple[str, str], str] = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext not in MESH_EXTS:
            continue
        rel = p.relative_to(root).as_posix()
        key = (p.stem.lower(), ext)

        prev = mesh_map.get(key)
        if prev is None or rel.count("/") < prev.count("/"):
            mesh_map[key] = rel
    return mesh_map


def rewrite_urdf_mesh_refs(urdf_path: Path, mesh_map: dict[tuple[str, str], str], fmt: str) -> tuple[int, int]:
    preferred = PREFERRED_EXT[fmt]
    order = [preferred] + FALLBACK_EXT[preferred]

    text = urdf_path.read_text(encoding="utf-8")
    updated = 0
    unresolved = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal updated, unresolved
        original = match.group(1)
        stem = Path(original.replace("\\", "/")).stem.lower()

        for ext in order:
            candidate = mesh_map.get((stem, ext))
            if candidate:
                updated += 1
                return f'filename="{candidate}"'

        unresolved += 1
        return match.group(0)

    out = re.sub(r'filename="([^"]+)"', repl, text)
    urdf_path.write_text(out, encoding="utf-8")
    return updated, unresolved


def remove_unity_nested_urdf(staged_root: Path) -> bool:
    nested = staged_root / "miro_robot_unity_description" / "miro_robot.urdf"
    if nested.exists():
        nested.unlink()
        return True
    return False


def main() -> int:
    args = parse_args()

    src = Path(args.fixture_root) / args.format
    if not src.is_dir():
        raise SystemExit(f"fixture source folder not found: {src}")

    out_root = Path(args.out_dir)
    staged = out_root / args.format

    if args.clear_out and staged.exists():
        shutil.rmtree(staged)

    staged.parent.mkdir(parents=True, exist_ok=True)
    if staged.exists():
        shutil.rmtree(staged)
    shutil.copytree(src, staged)

    removed_nested = False
    if args.format == "unity":
        removed_nested = remove_unity_nested_urdf(staged)

    urdfs = sorted(staged.rglob("*.urdf"))
    if not urdfs:
        raise SystemExit(f"no URDF found in staged fixture: {staged}")

    mesh_map = index_meshes(staged)

    total_updated = 0
    total_unresolved = 0
    for urdf in urdfs:
        updated, unresolved = rewrite_urdf_mesh_refs(urdf, mesh_map, args.format)
        total_updated += updated
        total_unresolved += unresolved

    print(f"format={args.format}")
    print(f"staged={staged}")
    print(f"urdfs={len(urdfs)}")
    print(f"mesh_index={len(mesh_map)}")
    print(f"mesh_refs_updated={total_updated}")
    print(f"mesh_refs_unresolved={total_unresolved}")
    print(f"unity_nested_urdf_removed={removed_nested}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
