# Fixture Prep Helper (Zoo-local)

Standalone helper for staging and normalizing URDF-kitchen fixture folders without modifying upstream `URDF_kitchen`.

## Why

Some fixture formats (especially `unity` / `stl`) can carry URDF mesh paths that don't match the actual exported mesh file layout. This helper rewrites mesh filename refs to files that actually exist in the staged folder.

## Script

`tools/fixtures/prepare_fixture.py`

## Usage

```bash
cd /home/stuart/KinematicTrees/Zoo
python3 tools/fixtures/prepare_fixture.py \
  --format unity \
  --fixture-root /home/stuart/KinematicTrees/test/urdfk_exports/miro \
  --out-dir /tmp/zoo-fixtures-prepared \
  --clear-out
```

Output folder for the example above:

- `/tmp/zoo-fixtures-prepared/unity`

## What it does

- Copies `<fixture-root>/<format>` into `<out-dir>/<format>`.
- Rewrites `<mesh filename="...">` entries in all staged `*.urdf` files to best-matching mesh files in that staged folder.
- Format-aware extension preference:
  - `dae -> .dae`
  - `stl -> .stl`
  - `unity -> .dae`
  - `mjcf -> .obj`
- For `unity`, removes nested `miro_robot_unity_description/miro_robot.urdf` to avoid dual-URDF ingestion conflict.

## Notes

- This is a helper-only tool. It does **not** modify solver logic or runtime coordinate systems.
- It is intentionally local to Zoo so workflow can continue even if upstream `URDF_kitchen` push rights are unavailable.
