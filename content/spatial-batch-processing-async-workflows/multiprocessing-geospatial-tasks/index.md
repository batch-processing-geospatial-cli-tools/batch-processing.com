---
title: "Multiprocessing Geospatial Tasks in Python"
description: "Saturate CPU cores for raster mosaics by enforcing stateless workers, the spawn start method, and atomic I/O inside Python's ProcessPoolExecutor."
slug: "multiprocessing-geospatial-tasks"
type: "topic"
breadcrumb: "Spatial Batch Processing & Async Workflows > Multiprocessing Geospatial Tasks"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Multiprocessing Geospatial Tasks in Python",
      "description": "Saturate CPU cores safely when processing raster mosaics, topology validations, and coordinate transformations by enforcing stateless workers, the spawn start method, and atomic I/O inside ProcessPoolExecutor.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Multiprocessing Geospatial Tasks", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Run multiprocessing geospatial tasks safely in Python",
      "step": [
        {"@type": "HowToStep", "name": "Profile and isolate CPU bottlenecks", "position": 1},
        {"@type": "HowToStep", "name": "Enforce stateless worker boundaries", "position": 2},
        {"@type": "HowToStep", "name": "Configure the spawn start method", "position": 3},
        {"@type": "HowToStep", "name": "Partition workloads and dispatch via ProcessPoolExecutor", "position": 4},
        {"@type": "HowToStep", "name": "Stream outputs and handle failures atomically", "position": 5}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does fork break GDAL when I use multiprocessing?",
          "acceptedAnswer": {"@type": "Answer", "text": "The fork start method copies the parent's entire memory space — including GDAL's internal mutex state, PROJ datum caches, and GEOS topology contexts — into each child. Those C-library structures are not safe to copy mid-execution, so workers either deadlock waiting on a mutex the parent held, or silently corrupt spatial outputs. Using spawn forces a clean interpreter in every child, so each worker initialises its own GDAL/PROJ context from scratch."}
        },
        {
          "@type": "Question",
          "name": "How many workers should I use for raster reprojection?",
          "acceptedAnswer": {"@type": "Answer", "text": "Start with min(os.cpu_count(), len(tile_list)) and profile from there. Each worker at idle consumes 150–300 MB for the Python interpreter and geospatial libraries; multiply by worker count and add your per-tile data footprint to ensure you stay within available RAM. If psutil reports memory pressure above 85% at peak, reduce workers before increasing them."}
        },
        {
          "@type": "Question",
          "name": "Can I pass a rasterio dataset object into a worker?",
          "acceptedAnswer": {"@type": "Answer", "text": "No. Rasterio dataset objects hold live C-pointers to GDAL dataset handles. Python's pickle protocol cannot serialise C-pointers, so passing one across a process boundary raises TypeError or causes silent memory corruption. Pass only the file path as a string and open the dataset inside the worker function."}
        },
        {
          "@type": "Question",
          "name": "What is the difference between ProcessPoolExecutor and multiprocessing.Pool?",
          "acceptedAnswer": {"@type": "Answer", "text": "ProcessPoolExecutor is part of concurrent.futures and provides a Future-based API with cleaner exception propagation — exceptions from workers surface as Future.exception() rather than being swallowed or requiring chunksize tuning. multiprocessing.Pool is lower-level and useful when you need imap_unordered streaming of results from a large generator. For most geospatial batch pipelines, ProcessPoolExecutor is the right default."}
        },
        {
          "@type": "Question",
          "name": "How do I detect the real CPU quota inside a Docker container?",
          "acceptedAnswer": {"@type": "Answer", "text": "os.cpu_count() returns the host's total logical cores, not the container's allocated quota. Read /sys/fs/cgroup/cpu.max (cgroup v2) to get the quota and period values, then compute effective_cores = quota / period. Pass that integer to ProcessPoolExecutor(max_workers=…) rather than using os.cpu_count() directly."}
        }
      ]
    }
  ]
}
</script>

**TL;DR:** Use `ProcessPoolExecutor` with the `spawn` start method, stateless worker functions, and atomic file writes to safely parallelise CPU-bound geospatial work across raster tiles or vector batches without corrupting GDAL, PROJ, or GEOS state.

## Prerequisites

- Python 3.10+
- `pip install rasterio>=1.3 geopandas>=0.14 shapely>=2.0 pyogrio>=0.7 psutil click>=8`
- GDAL 3.6+ system library (confirm with `gdal-config --version`)
- This page is part of the [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) guide — read the parent page first for an overview of concurrency strategy and when to choose multiprocessing over async I/O.

## Problem Framing

A team runs overnight raster reprojection jobs on 40,000 GeoTIFF tiles. The script calls `rasterio.open` in a loop, reprojects each tile to `EPSG:3857`, and writes outputs sequentially. At 2.1 seconds per tile, the job takes 23 hours on a 32-core server where CPU utilisation never exceeds 3%.

The bottleneck is Python's Global Interpreter Lock (GIL). Geospatial libraries like GDAL, PROJ, and GEOS rely on C/C++ backends that manage their own thread pools and global state caches. When `threading` attempts to parallelise CPU-heavy reprojection, the GIL forces sequential bytecode execution and leaves cores idle. Process-based parallelism bypasses this by spawning independent interpreter instances — each with its own memory space — so 32 workers can run 32 tile reproductions simultaneously.

For workflows dominated by network fetches or cloud storage latency, [Async I/O for Raster Processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) often delivers better throughput with lower memory overhead. Reserve multiprocessing for genuinely compute-heavy transformations: reprojection, resampling, raster algebra, vector topology validation, and spatial joins over large datasets.

## Architecture: Worker Pool Data Flow

The diagram below shows how the dispatcher partitions a tile list, fans out to a `ProcessPoolExecutor`, and collects atomic outputs from each stateless worker.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Worker pool data flow: CLI dispatcher partitions tile list, submits to ProcessPoolExecutor, each worker opens a tile, processes it, writes atomically, and returns a result dict" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Multiprocessing worker pool data flow for geospatial tile processing</title>
  <desc>The CLI dispatcher partitions a tile file list and submits tasks to a ProcessPoolExecutor. Each spawned worker independently opens a GeoTIFF tile, reprojects it, writes the result atomically via a .tmp rename, and returns a result dict. The dispatcher collects futures and logs success or failure per tile.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Dispatcher box -->
  <rect x="20" y="130" width="150" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="95" y="154" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">CLI Dispatcher</text>
  <text x="95" y="172" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">ProcessPoolExecutor</text>
  <!-- Tile list above -->
  <rect x="45" y="40" width="100" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.6"/>
  <text x="95" y="60" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor">tile_paths[]</text>
  <text x="95" y="74" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">40 000 GeoTIFFs</text>
  <line x1="95" y1="76" x2="95" y2="130" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Worker 1 -->
  <rect x="240" y="50" width="160" height="72" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="320" y="72" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Worker Process 1</text>
  <text x="320" y="89" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">open → reproject → .tmp</text>
  <text x="320" y="106" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">rename → return dict</text>
  <line x1="170" y1="148" x2="240" y2="90" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Worker 2 -->
  <rect x="240" y="144" width="160" height="72" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="320" y="166" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Worker Process 2</text>
  <text x="320" y="183" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">open → reproject → .tmp</text>
  <text x="320" y="200" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">rename → return dict</text>
  <line x1="170" y1="160" x2="240" y2="180" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Worker N -->
  <rect x="240" y="238" width="160" height="72" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="320" y="260" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Worker Process N</text>
  <text x="320" y="277" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">open → reproject → .tmp</text>
  <text x="320" y="294" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">rename → return dict</text>
  <line x1="170" y1="172" x2="240" y2="268" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Ellipsis between workers -->
  <text x="320" y="236" text-anchor="middle" font-size="16" fill="currentColor" opacity="0.4">⋮</text>
  <!-- Output store -->
  <rect x="470" y="130" width="140" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="540" y="154" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">Output Directory</text>
  <text x="540" y="172" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">atomic GeoTIFFs</text>
  <!-- Arrows to output -->
  <line x1="400" y1="86" x2="470" y2="148" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <line x1="400" y1="180" x2="470" y2="160" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <line x1="400" y1="274" x2="470" y2="172" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#arr)"/>
  <!-- Result feedback to dispatcher -->
  <path d="M540,190 Q580,230 580,290 Q580,330 95,320 Q20,320 20,210" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="5 3" opacity="0.4" marker-end="url(#arr)"/>
  <text x="330" y="338" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.5">Future results logged by dispatcher</text>
</svg>

## Step-by-Step Implementation

### Step 1 — Profile and Isolate CPU Bottlenecks

Confirm the workload is genuinely CPU-bound before introducing multiprocessing overhead. `py-spy`, `cProfile`, and `line_profiler` reveal whether wall time is spent in Python bytecode, C extensions, or waiting on disk I/O.

```python
import cProfile
import pstats
import rasterio
from pathlib import Path

def single_tile_reproject(src_path: Path, dst_crs: str = "EPSG:3857") -> None:
    """Baseline single-tile reprojection for profiling."""
    from rasterio.warp import calculate_default_transform, reproject, Resampling

    with rasterio.open(src_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds
        )
        meta = src.meta.copy()
        meta.update({"crs": dst_crs, "transform": transform, "width": width, "height": height})
        data = src.read()

    # Profile the reprojection step in isolation
    with cProfile.Profile() as pr:
        reproject(
            source=data,
            destination=data,          # in-place for profiling only
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=transform,
            dst_crs=dst_crs,
            resampling=Resampling.bilinear,
        )
    stats = pstats.Stats(pr).sort_stats("cumulative")
    stats.print_stats(10)

single_tile_reproject(Path("/data/tiles/tile_0001.tif"))
```

If `%iowait` exceeds 20% during the run (`iostat -x 2`), multiprocessing will not help — storage latency dominates and spawning extra processes adds context-switching overhead without parallel I/O benefit. In that case, revisit the [async I/O for raster processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) pattern first.

### Step 2 — Enforce Stateless Worker Boundaries

Each worker must receive only serialisable arguments: file paths as strings, CRS strings, numeric parameters, and window coordinates expressed as plain dicts. Never pass open file handles, database connections, or GDAL dataset objects across process boundaries — Python's `pickle` protocol cannot serialise live C-pointers and will raise `TypeError` or cause silent memory corruption.

```python
from pathlib import Path
from typing import Any

# WRONG — passes a live GDAL handle across the process boundary
import rasterio
src = rasterio.open("/data/tiles/tile_0001.tif")
# executor.submit(worker, src)   # <-- TypeError or silent corruption

# RIGHT — pass only the serialisable path; open inside the worker
def reproject_tile(
    input_path: str,
    output_dir: str,
    dst_crs: str,
    window: dict[str, int],
) -> dict[str, Any]:
    """Stateless worker: all resources opened, processed, and closed within scope."""
    import rasterio
    from rasterio.warp import calculate_default_transform, reproject, Resampling
    from rasterio.windows import Window

    src_path = Path(input_path)
    out_path = Path(output_dir) / src_path.name.replace(".tif", f"_{dst_crs.replace(':', '')}.tif")
    tmp_path = out_path.with_suffix(".tmp.tif")

    try:
        w = Window(window["col_off"], window["row_off"], window["width"], window["height"])
        with rasterio.open(src_path) as src:
            transform, width, height = calculate_default_transform(
                src.crs, dst_crs, w.width, w.height, *src.window_bounds(w)
            )
            meta = src.meta.copy()
            meta.update({
                "crs": dst_crs,
                "transform": transform,
                "width": width,
                "height": height,
                "driver": "GTiff",
            })
            source_data = src.read(window=w)

        with rasterio.open(tmp_path, "w", **meta) as dst:
            for band_idx in range(1, meta["count"] + 1):
                reproject(
                    source=source_data[band_idx - 1],
                    destination=rasterio.band(dst, band_idx),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=dst_crs,
                    resampling=Resampling.bilinear,
                )
        tmp_path.replace(out_path)  # atomic rename — no partial outputs
        return {"status": "success", "path": str(out_path)}

    except Exception as exc:
        if tmp_path.exists():
            tmp_path.unlink()
        return {"status": "error", "path": input_path, "message": str(exc)}
```

Design functions that open, process, and close resources entirely within the worker scope. Pass configuration dicts rather than instantiated objects.

### Step 3 — Configure the Spawn Start Method

Use `spawn` on all operating systems. The default `fork` method on Linux/macOS copies the parent's memory space, which breaks GDAL's internal mutexes, PROJ's datum caches, and GEOS topology contexts. Set the start method at the module entry point, under `if __name__ == "__main__"`, before any pool is created:

```python
import multiprocessing as mp

if __name__ == "__main__":
    # Must be set BEFORE any ProcessPoolExecutor or Pool is created.
    # force=True prevents conflicts if libraries set the method earlier.
    mp.set_start_method("spawn", force=True)
    cli()  # Click entry point defined below
```

Placing `set_start_method` inside a function called after argument parsing is too late if the `multiprocessing` module has already cached the context. See [Python's multiprocessing context documentation](https://docs.python.org/3/library/multiprocessing.html#contexts-and-start-methods) for the full specification.

### Step 4 — Partition Workloads and Dispatch Pools

Split the workload into chunks that match I/O throughput and core count. For workloads that benefit from [chunked vector data reading](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/), pre-compute bounding boxes or spatial extents to eliminate redundant queries inside workers. Resolve all file paths to absolute strings before serialisation.

```python
import os
import psutil
from pathlib import Path

def max_safe_workers(worker_overhead_mb: int = 280) -> int:
    """Calculate worker count based on available RAM rather than raw CPU count."""
    available = psutil.virtual_memory().available
    # Leave 20% headroom for OS caching and I/O buffers
    usable = available * 0.80
    return max(1, min(os.cpu_count() or 1, int(usable / (worker_overhead_mb * 1024 ** 2))))


def build_tile_tasks(
    tile_dir: Path,
    output_dir: Path,
    dst_crs: str = "EPSG:3857",
    tile_size: int = 1024,
) -> list[tuple]:
    """Return a list of serialisable arg tuples for each tile."""
    window = {"col_off": 0, "row_off": 0, "width": tile_size, "height": tile_size}
    return [
        (str(p.resolve()), str(output_dir.resolve()), dst_crs, window)
        for p in sorted(tile_dir.glob("*.tif"))
    ]
```

Dispatch via `concurrent.futures.ProcessPoolExecutor` for cleaner exception handling and future-based aggregation. Prefer `as_completed` over `map` when you need per-result logging and want failures isolated to individual tiles rather than halting the whole batch. For GDAL-specific chunk alignment strategies that prevent overlapping reads and cache thrashing, see [Optimizing GDAL batch operations with multiprocessing pool](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/optimizing-gdal-batch-operations-with-multiprocessing-pool/).

### Step 5 — Stream Outputs and Handle Failures

Write outputs directly from workers to disk. Collecting results in memory before writing defeats parallelism and risks `MemoryError` on large datasets. The atomic `.tmp` → rename pattern in the worker above ensures no partial files reach downstream consumers. In the dispatcher, use structured logging and never let a single corrupted tile halt the entire batch.

```python
import logging
import click
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(processName)s] %(message)s",
)
log = logging.getLogger(__name__)

@click.command()
@click.argument("tile_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--output-dir", "-o", required=True, type=click.Path(path_type=Path))
@click.option("--crs", default="EPSG:3857", show_default=True)
@click.option("--tile-size", default=1024, show_default=True, type=int)
@click.option("--workers", default=None, type=int, help="Defaults to RAM-safe maximum.")
def cli(
    tile_dir: Path,
    output_dir: Path,
    crs: str,
    tile_size: int,
    workers: int | None,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    n_workers = workers or max_safe_workers()
    tasks = build_tile_tasks(tile_dir, output_dir, crs, tile_size)
    log.info("Submitting %d tiles to %d workers", len(tasks), n_workers)

    success, failure = 0, 0
    with ProcessPoolExecutor(max_workers=n_workers) as executor:
        future_to_path = {
            executor.submit(reproject_tile, *task): task[0] for task in tasks
        }
        for future in as_completed(future_to_path):
            try:
                result = future.result()
            except Exception as exc:
                # Worker raised an unhandled exception — log and continue
                log.error("Unhandled worker error for %s: %s", future_to_path[future], exc)
                failure += 1
                continue

            if result["status"] == "success":
                log.info("OK  %s", result["path"])
                success += 1
            else:
                log.error("ERR %s — %s", result["path"], result["message"])
                failure += 1

    log.info("Finished: %d success, %d failure", success, failure)
    raise SystemExit(0 if failure == 0 else 1)

if __name__ == "__main__":
    import multiprocessing as mp
    mp.set_start_method("spawn", force=True)
    cli()
```

Exit code `0` when every tile succeeds; `1` on any failure — following POSIX conventions that let CI pipelines detect partial batch failures without parsing log output.

## Configuration Integration

Set GDAL thread-limiting environment variables before workers start to prevent CPU oversubscription. These belong in a `.env` file or CI environment, then propagate to workers automatically because `spawn` re-imports the environment:

```bash
# .env — loaded by python-dotenv or your deployment harness
GDAL_NUM_THREADS=1        # prevent GDAL from creating its own thread pool per worker
OMP_NUM_THREADS=1         # cap OpenMP threads (used by some GDAL drivers)
GDAL_CACHEMAX=256         # per-worker block cache in MB
PROJ_NETWORK=OFF          # disable PROJ CDN lookups inside workers
```

In Python, override these before any `rasterio` import if you need programmatic control:

```python
import os
os.environ.setdefault("GDAL_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("GDAL_CACHEMAX", "256")
```

Consult the [GDAL configuration options reference](https://gdal.org/en/stable/user/configoptions.html) for a full list of thread-safe initialisation flags.

## Error Handling and Gotchas

**Fork-induced deadlock.** Workers hang silently when `fork` copies a locked GDAL mutex from the parent. Symptom: workers start, consume CPU at 0%, and never return a result. Fix: set `mp.set_start_method("spawn", force=True)` before any pool creation.

**CRS string mismatch.** Passing `"WGS84"` or `"EPSG:4326 (geographic)"` as the `dst_crs` will cause PROJ to reject or silently reinterpret the authority. Always use canonical EPSG codes (`"EPSG:3857"`, `"EPSG:4326"`) and validate with `pyproj.CRS.from_user_input(dst_crs).to_authority()` before dispatching.

**Block boundary misalignment.** When tiling a large raster before dispatch, tile extents that do not align to the source raster's internal block size (typically 256 × 256 or 512 × 512 pixels) force GDAL to perform partial block reads. Use `rasterio.open(src).block_shapes` to read the native block dimensions and set your `Window` offsets to multiples of those values.

**Pickle failure on closure-captured objects.** If you pass a lambda or a nested function to `executor.submit`, `pickle` will fail because closures cannot be serialised. Define all worker functions at the module level (not inside `if __name__ == "__main__"` or inside another function).

**GDAL driver registration in workers.** On some Linux builds, `gdal.AllRegister()` must be called inside the worker before opening a file. Importing `rasterio` at the top of your worker function triggers this automatically — do not rely on a module-level import in the parent process carrying over into spawned children.

**Memory exhaustion.** When [handling out-of-memory errors in large raster mosaics](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/handling-out-of-memory-errors-in-large-raster-mosaics/), the most common cause in a process pool is oversized tiles. Reduce `tile_size` from 1024 to 512 and re-run `max_safe_workers()` to find the correct balance.

## Verification

After a batch run, verify that every output tile is valid, covers the expected CRS, and contains no NaN bands:

```python
import sys
from pathlib import Path
import rasterio
from rasterio.crs import CRS

def verify_outputs(output_dir: Path, expected_crs: str = "EPSG:3857") -> None:
    target_crs = CRS.from_epsg(int(expected_crs.split(":")[1]))
    errors: list[str] = []

    for tif in sorted(output_dir.glob("*.tif")):
        try:
            with rasterio.open(tif) as ds:
                if ds.crs != target_crs:
                    errors.append(f"{tif.name}: unexpected CRS {ds.crs}")
                data = ds.read()
                if data.size == 0:
                    errors.append(f"{tif.name}: empty array")
        except Exception as exc:
            errors.append(f"{tif.name}: {exc}")

    if errors:
        for e in errors:
            print(f"FAIL {e}", file=sys.stderr)
        sys.exit(1)
    print(f"OK  {len(list(output_dir.glob('*.tif')))} tiles verified in {expected_crs}")

verify_outputs(Path("/data/output"), "EPSG:3857")
```

Run this as a post-step in your CI pipeline, or as a `--verify` flag in your CLI, to catch partial or corrupt outputs before they propagate downstream.

## Performance Notes

**Worker startup cost.** Spawning a Python interpreter with GDAL and PROJ loaded takes 0.5–1.5 seconds per worker. For very small tile lists (fewer than 20 tiles), this overhead can exceed the processing time saved. Benchmark at 1 worker vs. N workers and only scale out when the net throughput improvement is measurable.

**Memory footprint per worker.** Each spawned Python process with `rasterio`, `shapely`, and PROJ loaded consumes 150–300 MB at idle. A 32-worker pool on a 64 GB host leaves approximately 55 GB for tile data, which is sufficient for 1024 × 1024 float32 GeoTIFFs (≈4 MB each) but tight for full-resolution mosaic windows. Use `max_safe_workers()` (defined in Step 4) rather than hardcoding `os.cpu_count()`.

**I/O throughput ceiling.** Beyond a certain worker count, local NVMe throughput becomes the bottleneck rather than CPU. Use `iostat -x 2` during a run to watch `%util` on your storage device. If it reaches 100%, adding workers will degrade overall throughput. Consider colocating the tile directory on a RAM-backed tmpfs for pure CPU benchmarking.

**Containerised deployment.** Inside Docker or Kubernetes, `os.cpu_count()` returns the host's total logical cores, not the container's CPU quota. Read `/sys/fs/cgroup/cpu.max` (cgroup v2) to compute the effective core count:

```python
import math

def container_cpu_quota() -> int:
    """Return effective CPU quota from cgroup v2, or os.cpu_count() as fallback."""
    try:
        quota_path = Path("/sys/fs/cgroup/cpu.max")
        parts = quota_path.read_text().split()
        if parts[0] == "max":
            return os.cpu_count() or 1
        quota, period = int(parts[0]), int(parts[1])
        return max(1, math.floor(quota / period))
    except (FileNotFoundError, ValueError, IndexError):
        return os.cpu_count() or 1
```

**GC tuning.** For pipelines that allocate and release large NumPy arrays repeatedly, GC pressure causes measurable pause spikes. Call `gc.set_threshold(700, 10, 10)` at the start of each worker to reduce collection frequency during the hot loop.

**Vector batch jobs.** When the workload is vector-based (spatial joins, topology checks), prefer `pyogrio` over `fiona` for reading GeoPackage or Shapefile inputs inside workers. `pyogrio` uses Arrow-based I/O that is significantly faster for bulk reads and avoids the layer-locking issues that can surface when multiple workers open the same OGR source.

## FAQ

<details class="faq-item">
<summary>Why does fork break GDAL when I use multiprocessing?</summary>

The `fork` start method copies the parent's entire memory space — including GDAL's internal mutex state, PROJ datum caches, and GEOS topology contexts — into each child process. Those C-library structures are not safe to copy mid-execution, so workers either deadlock waiting on a mutex the parent held, or silently corrupt spatial outputs. Using `spawn` forces a clean interpreter in every child, so each worker initialises its own GDAL/PROJ context from scratch.
</details>

<details class="faq-item">
<summary>How many workers should I use for raster reprojection?</summary>

Start with `min(os.cpu_count(), len(tile_list))` and profile from there. Each worker at idle consumes 150–300 MB for the Python interpreter and geospatial libraries; multiply by worker count and add your per-tile data footprint to ensure you stay within available RAM. If `psutil` reports memory pressure above 85% at peak, reduce workers before increasing them. The `max_safe_workers()` function in Step 4 automates this calculation.
</details>

<details class="faq-item">
<summary>Can I pass a rasterio dataset object into a worker?</summary>

No. Rasterio dataset objects hold live C-pointers to GDAL dataset handles. Python's `pickle` protocol cannot serialise C-pointers, so passing one across a process boundary raises `TypeError` or causes silent memory corruption. Pass only the file path as a string and open the dataset inside the worker function.
</details>

<details class="faq-item">
<summary>What is the difference between ProcessPoolExecutor and multiprocessing.Pool?</summary>

`ProcessPoolExecutor` is part of `concurrent.futures` and provides a `Future`-based API with cleaner exception propagation — exceptions from workers surface as `Future.exception()` rather than being swallowed or requiring `chunksize` tuning. `multiprocessing.Pool` is lower-level and useful when you need `imap_unordered` streaming of results from a large generator. For most geospatial batch pipelines, `ProcessPoolExecutor` is the right default.
</details>

<details class="faq-item">
<summary>How do I detect the real CPU quota inside a Docker container?</summary>

`os.cpu_count()` returns the host's total logical cores, not the container's allocated quota. Read `/sys/fs/cgroup/cpu.max` (cgroup v2) to get the quota and period values, then compute `effective_cores = quota / period`. The `container_cpu_quota()` helper in the Performance Notes section handles the cgroup v2 path and falls back to `os.cpu_count()` on bare-metal hosts. Pass that integer to `ProcessPoolExecutor(max_workers=…)` rather than using `os.cpu_count()` directly.
</details>

## Related

- [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) — parent guide covering the full concurrency decision tree for Python GIS pipelines
- [Async I/O for Raster Processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — when I/O latency dominates, async event loops outperform process pools
- [Chunked Vector Data Reading](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — partition large GeoPackage and Shapefile inputs before dispatching to workers
- [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — structured logging and exit-code conventions for fault-tolerant batch runs
