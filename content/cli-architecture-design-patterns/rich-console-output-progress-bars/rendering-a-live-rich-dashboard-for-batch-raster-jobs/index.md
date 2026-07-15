---
title: "Rendering a Live Rich Dashboard for Batch Raster Jobs"
description: "Combine Rich Live, Progress, and Table to show per-worker throughput, ETA, and error counts for a multiprocessing raster batch without flooding the scrollback."
slug: "rendering-a-live-rich-dashboard-for-batch-raster-jobs"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Rich Console Output & Progress Bars for GIS CLIs"
    url: "/cli-architecture-design-patterns/rich-console-output-progress-bars/"
  - label: "Rendering a Live Rich Dashboard for Batch Raster Jobs"
    url: "/cli-architecture-design-patterns/rich-console-output-progress-bars/rendering-a-live-rich-dashboard-for-batch-raster-jobs/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Rendering a Live Rich Dashboard for Batch Raster Jobs

To show a live dashboard for a batch raster job, wrap a `rich.live.Live` around a `Group` that holds a `Progress` bar (tiles done, ETA) and a `Table` of per-worker status, then drive both from the parent process as `ProcessPoolExecutor` futures resolve through `as_completed`. Workers only reproject tiles and return counts; the parent owns the terminal and renders. This dashboard is one build-out within the [Rich Console Output & Progress Bars for GIS CLIs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/) guide, itself part of the broader [CLI Architecture & Design Patterns for Python GIS](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install "rich>=13.0" rasterio pyproj`
- GDAL 3.4+ available to rasterio (via a wheel or conda/mamba)
- `concurrent.futures` and `multiprocessing` are in the standard library

For the parallelism model underneath this dashboard, read [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/). For the counting and ETA concepts the dashboard visualises, see [Progress Tracking for Batch Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/).

## How the Dashboard Data Flows

The key architectural constraint is that rendering happens in exactly one process. Worker processes reproject tiles and return small result objects; the parent process consumes those results, mutates the `Progress` task and the per-worker `Table`, and asks `Live` to redraw. Nothing about Rich crosses the process boundary.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Data flow of a live Rich dashboard: worker processes reproject tiles and return counts, the parent process updates a Progress bar and per-worker table inside a single Live region" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Live Rich dashboard data flow</title>
  <desc>Three worker processes on the left reproject raster tiles and return result objects to a parent process on the right. The parent updates a Progress bar and a per-worker Table held inside one Live region, which redraws in place in the terminal.</desc>
  <!-- Workers panel -->
  <rect x="12" y="20" width="196" height="280" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="110" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" opacity="0.9">ProcessPoolExecutor</text>
  <rect x="34" y="58" width="152" height="42" rx="5" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="110" y="76" text-anchor="middle" font-size="10.5" fill="currentColor">Worker 1</text>
  <text x="110" y="91" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">reproject tile</text>
  <rect x="34" y="112" width="152" height="42" rx="5" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="110" y="130" text-anchor="middle" font-size="10.5" fill="currentColor">Worker 2</text>
  <text x="110" y="145" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">reproject tile</text>
  <rect x="34" y="166" width="152" height="42" rx="5" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="110" y="184" text-anchor="middle" font-size="10.5" fill="currentColor">Worker 3</text>
  <text x="110" y="199" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">reproject tile</text>
  <text x="110" y="238" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">return</text>
  <text x="110" y="252" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">TileResult(worker,</text>
  <text x="110" y="265" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">ok, seconds)</text>
  <!-- Arrow workers to parent -->
  <line x1="208" y1="150" x2="292" y2="150" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.6" marker-end="url(#arr)"/>
  <text x="250" y="142" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">as_completed</text>
  <!-- Parent panel -->
  <rect x="300" y="20" width="408" height="280" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="504" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" opacity="0.9">Parent process (renders)</text>
  <!-- Live region box -->
  <rect x="320" y="58" width="368" height="222" rx="6" fill="#a78bfa" fill-opacity="0.08" stroke="#818cf8" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="504" y="78" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Live region (redraws in place)</text>
  <!-- Progress bar -->
  <rect x="340" y="92" width="328" height="40" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="504" y="108" text-anchor="middle" font-size="10" fill="currentColor">Progress: tiles done, bar, ETA</text>
  <rect x="352" y="115" width="200" height="8" rx="4" fill="#15803d" fill-opacity="0.5"/>
  <rect x="352" y="115" width="304" height="8" rx="4" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <!-- Table -->
  <rect x="340" y="144" width="328" height="120" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="504" y="162" text-anchor="middle" font-size="10" fill="currentColor">Table: per-worker throughput and errors</text>
  <line x1="352" y1="172" x2="656" y2="172" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"/>
  <text x="380" y="188" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">worker</text>
  <text x="470" y="188" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">tiles/s</text>
  <text x="560" y="188" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">done</text>
  <text x="630" y="188" text-anchor="middle" font-size="9.5" fill="#c0392b" opacity="0.85">errors</text>
  <text x="380" y="206" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">1</text>
  <text x="470" y="206" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">2.4</text>
  <text x="560" y="206" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">18</text>
  <text x="630" y="206" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">0</text>
  <text x="380" y="224" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">2</text>
  <text x="470" y="224" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">2.1</text>
  <text x="560" y="224" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">16</text>
  <text x="630" y="224" text-anchor="middle" font-size="9.5" fill="#c0392b" opacity="0.8">1</text>
  <text x="504" y="252" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">live.update(dashboard) after each future</text>
  <!-- Arrow marker -->
  <defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below reprojects every GeoTIFF tile in a directory to a target CRS using a `ProcessPoolExecutor`, while the parent process renders a single live dashboard. Copy it, adjust the paths and `--crs`, and run directly. Worker functions return a small `TileResult` and never touch Rich:

```python
#!/usr/bin/env python3
"""
Live Rich dashboard over a multiprocessing raster reprojection batch.
Usage: python live_dashboard.py ./tiles ./out --crs EPSG:3857 --workers 4
"""
import os
import sys
import time
import argparse
from pathlib import Path
from dataclasses import dataclass
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed

import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling

from rich.console import Group
from rich.live import Live
from rich.table import Table
from rich.progress import (
    Progress, BarColumn, TextColumn,
    TimeRemainingColumn, MofNCompleteColumn,
)

@dataclass
class TileResult:
    """Plain, picklable payload returned from a worker to the parent."""
    tile: str
    worker: int
    ok: bool
    seconds: float
    error: str | None = None

def reproject_tile(src_path: Path, dst_path: Path, dst_crs: str) -> TileResult:
    """Reproject one raster tile. Runs in a worker process — no Rich here."""
    worker = os.getpid()
    start = time.perf_counter()
    try:
        with rasterio.open(src_path) as src:
            transform, width, height = calculate_default_transform(
                src.crs, dst_crs, src.width, src.height, *src.bounds
            )
            profile = src.profile.copy()
            profile.update(
                crs=dst_crs, transform=transform,
                width=width, height=height,
                compress="lzw", tiled=True,
            )
            with rasterio.open(dst_path, "w", **profile) as dst:
                for band in range(1, src.count + 1):
                    reproject(
                        source=rasterio.band(src, band),
                        destination=rasterio.band(dst, band),
                        src_transform=src.transform, src_crs=src.crs,
                        dst_transform=transform, dst_crs=dst_crs,
                        resampling=Resampling.bilinear,
                    )
        elapsed = time.perf_counter() - start
        return TileResult(src_path.name, worker, True, elapsed)
    except Exception as exc:
        elapsed = time.perf_counter() - start
        return TileResult(src_path.name, worker, False, elapsed, str(exc))

def build_dashboard(progress: Progress, table: Table) -> Group:
    """Compose the two renderables into one block Live can refresh."""
    return Group(progress, table)

def render_table(stats: dict[int, dict], errors: int) -> Table:
    """Rebuild the per-worker table from accumulated stats."""
    table = Table(title=f"Per-worker throughput  (errors: {errors})",
                  expand=True, title_justify="left")
    table.add_column("Worker (PID)", justify="right", no_wrap=True)
    table.add_column("Tiles done", justify="right")
    table.add_column("Tiles/sec", justify="right")
    table.add_column("Errors", justify="right", style="red")
    for pid, s in sorted(stats.items()):
        rate = s["done"] / s["busy"] if s["busy"] > 0 else 0.0
        table.add_row(str(pid), str(s["done"]), f"{rate:0.2f}", str(s["errors"]))
    return table

def main() -> None:
    parser = argparse.ArgumentParser(description="Live dashboard raster batch")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--crs", default="EPSG:3857", help="Target CRS")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    tiles = sorted(args.input_dir.glob("*.tif"))
    if not tiles:
        print(f"No .tif tiles in {args.input_dir}", file=sys.stderr)
        sys.exit(2)

    progress = Progress(
        TextColumn("[bold]Reprojecting tiles"),
        BarColumn(),
        MofNCompleteColumn(),
        TextColumn("ETA"),
        TimeRemainingColumn(),
        refresh_per_second=4,
    )
    task_id = progress.add_task("tiles", total=len(tiles))
    stats: dict[int, dict] = defaultdict(
        lambda: {"done": 0, "errors": 0, "busy": 0.0}
    )
    errors = 0

    # Live owns the terminal. Only this (parent) process renders.
    with Live(build_dashboard(progress, render_table(stats, errors)),
              refresh_per_second=4) as live:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(reproject_tile, t,
                            args.output_dir / f"{t.stem}_3857.tif", args.crs): t
                for t in tiles
            }
            for future in as_completed(futures):
                result: TileResult = future.result()
                s = stats[result.worker]
                s["busy"] += result.seconds
                if result.ok:
                    s["done"] += 1
                else:
                    s["errors"] += 1
                    errors += 1
                    live.console.print(
                        f"[red]FAIL[/red] {result.tile}: {result.error}"
                    )
                progress.advance(task_id, 1)
                live.update(build_dashboard(progress, render_table(stats, errors)))

    total_ok = sum(s["done"] for s in stats.values())
    print(f"Completed {total_ok}/{len(tiles)} tiles, {errors} errors.")
    sys.exit(0 if errors == 0 else 12)   # 12 = partial batch failure

if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`TileResult` is a plain dataclass** — Anything a worker returns must be picklable to cross the process boundary. A `Live`, `Progress`, or `Console` object cannot be pickled, so workers return only primitive fields (tile name, PID, success flag, elapsed seconds). The parent turns those numbers into rendered rows.

2. **`Group(progress, table)`** — `rich.console.Group` stacks the `Progress` bar above the `Table` as one renderable. `Live` then treats the pair as a single region and rewrites exactly those lines on each update, which is what keeps the dashboard pinned instead of scrolling.

3. **`MofNCompleteColumn` plus `TimeRemainingColumn`** — The `M/N` column shows tiles done out of total, and the time-remaining column derives the ETA from the recent completion rate. Because `progress.advance(task_id, 1)` fires once per completed tile, the rate is measured in whole tiles and the ETA settles quickly.

4. **`stats` keyed by worker PID** — `ProcessPoolExecutor` reuses a fixed set of worker processes, so `os.getpid()` inside `reproject_tile` yields a stable identifier per worker. Accumulating `done`, `errors`, and `busy` seconds per PID gives a genuine tiles-per-second figure for each worker row.

5. **`live.console.print(...)` for failures** — Routing per-tile log lines through the Live console prints them *above* the pinned dashboard rather than tearing it. See [Progress Tracking for Batch Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) for the same log-above-progress technique applied to plain counters.

6. **`live.update(build_dashboard(...))`** — The table is immutable once built, so a fresh `Table` is composed on every result and handed to `live.update`. At a few tiles per second this rebuild is negligible, and it guarantees the rendered state always reflects the latest completed tile.

7. **Exit code `12`** — Following the site's domain convention, a run with any failed tile exits `12` (partial batch failure) so a calling shell script or CI job can branch on it, while a clean run exits `0`.

## Named Gotcha: Updating Rich From Worker Processes

The single most common way this pattern breaks is trying to pass the `Live`, `Progress`, or a shared `Console` into the worker so each process can update its own row. It fails immediately: `ProcessPoolExecutor` pickles the arguments to every task, and these objects hold a reference to an open terminal file handle, raising `TypeError: cannot pickle '_io.TextIOWrapper' object` (or a lock-pickling error). Even if you force it through with a manager proxy, multiple processes writing ANSI escape sequences to the same terminal interleave into corrupted, unreadable output.

The fix is the architecture shown above: workers are pure functions that reproject a tile and **return** a `TileResult`. Only the parent process holds the `Live` instance, and it mutates the `Progress` task and rebuilds the `Table` inside the single-threaded `as_completed` loop. All rendering is serialised through one process, so the terminal never sees interleaved writes. This mirrors the render-in-the-parent rule from [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/).

## Verification

Run the script against a directory of tiles, then confirm the tally and CRS of the outputs:

```bash
# Run the batch; capture the exit code
python live_dashboard.py ./tiles ./out --crs EPSG:3857 --workers 4
echo "exit code: $?"          # 0 = all tiles OK, 12 = partial failure

# Count outputs against inputs
echo "inputs:  $(ls ./tiles/*.tif | wc -l)"
echo "outputs: $(ls ./out/*_3857.tif | wc -l)"

# Confirm the target CRS landed on the first output
python3 - <<'EOF'
import rasterio
with rasterio.open(sorted(__import__("pathlib").Path("./out").glob("*_3857.tif"))[0]) as ds:
    print("CRS:", ds.crs)       # should print EPSG:3857
EOF
```

A matching input/output count, an exit code of `0`, and `EPSG:3857` on the outputs confirm the dashboard tracked every tile and no failure was silently swallowed. If the counts differ, the printed `FAIL` lines above the dashboard name the exact tiles and errors.

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| `TypeError: cannot pickle ...` on submit | `Live`/`Console` passed into a worker | Return `TileResult`; render only in the parent |
| Dashboard scrolls instead of redrawing | Progress and Table printed separately | Wrap both in one `Group` inside a single `Live` |
| ETA erratic for the first few tiles | Rate estimate is noisy while the sample is small | Advance one unit per tile; it stabilises after ~12 |
| Log lines shred the table | Using bare `print()` during Live | Use `live.console.print(...)` so lines land above the region |
| Worker rows never appear | Table not rebuilt after results | Call `live.update` with a fresh table each iteration |

## FAQ

<details class="faq-item">
<summary>Can I update a Rich Live display from inside worker processes?</summary>

No. A Rich `Live` instance owns a single terminal and cannot be pickled or shared across processes. Only the parent process may render. Workers return plain data such as tile counts and error flags, and the parent updates the `Progress` bar and `Table` from the `as_completed` loop.
</details>

<details class="faq-item">
<summary>How do I stop the dashboard from flooding the scrollback?</summary>

Render the `Progress` bar and `Table` inside a single `Live` region so Rich rewrites the same block of lines instead of appending. Route any per-tile log lines through `live.console.print` or a logging `RichHandler` bound to the same console so they scroll above the pinned dashboard.
</details>

<details class="faq-item">
<summary>Why is my ETA jumping around during the raster batch?</summary>

`TimeRemainingColumn` estimates from the recent completion rate. When tiles vary widely in size the rate is noisy early on. Advance the `Progress` task once per completed tile rather than per byte, and the estimate stabilises after the first dozen tiles.
</details>

<details class="faq-item">
<summary>Should I use refresh_per_second or manual refresh with Live?</summary>

For a batch driven by `as_completed`, set a modest `refresh_per_second` such as `4` and call `live.update` after each result. A high refresh rate wastes CPU redrawing an unchanged table, and manual updates guarantee the view reflects the latest completed tile.
</details>

---

## Related

- [Rich Console Output & Progress Bars for GIS CLIs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/) — parent guide covering progress bars, spinners, and structured console output for geospatial command-line tools
- [Customizing Rich Tables for Coordinate System Outputs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/) — styling and column formatting for the Rich Table used in this dashboard
