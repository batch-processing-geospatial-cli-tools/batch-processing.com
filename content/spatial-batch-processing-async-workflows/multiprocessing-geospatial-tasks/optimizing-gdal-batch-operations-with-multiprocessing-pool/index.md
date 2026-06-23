---
title: "GDAL Batch Operations with multiprocessing.Pool"
description: "High-throughput GDAL batch processing with multiprocessing.Pool: worker isolation, spawn start method, environment variable handling, and I/O bottleneck strategies."
slug: "optimizing-gdal-batch-operations-with-multiprocessing-pool"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Spatial Batch Processing & Async Workflows"
    url: "/spatial-batch-processing-async-workflows/"
  - label: "Multiprocessing Geospatial Tasks"
    url: "/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/"
  - label: "Optimizing GDAL Batch Operations with multiprocessing.Pool"
    url: "/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/optimizing-gdal-batch-operations-with-multiprocessing-pool/"
datePublished: "2025-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Optimizing GDAL Batch Operations with multiprocessing.Pool",
      "description": "Step-by-step guide to safe, high-throughput GDAL batch processing with Python's multiprocessing.Pool: worker isolation, spawn start method, environment variables, and I/O bottleneck strategies.",
      "datePublished": "2025-01-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Multiprocessing Geospatial Tasks", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/"},
        {"@type": "ListItem", "position": 4, "name": "Optimizing GDAL Batch Operations with multiprocessing.Pool", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/optimizing-gdal-batch-operations-with-multiprocessing-pool/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Optimize GDAL Batch Operations with multiprocessing.Pool",
      "step": [
        {"@type": "HowToStep", "name": "Force spawn start method", "text": "Call set_start_method('spawn', force=True) before Pool creation to prevent GDAL C-state inheritance."},
        {"@type": "HowToStep", "name": "Write a worker initializer", "text": "Pass an initializer to Pool that calls gdal.UseExceptions() and sets GDAL_NUM_THREADS=1 and CPL_NUM_THREADS=1."},
        {"@type": "HowToStep", "name": "Build and dispatch tasks", "text": "Generate (src, dst, crs) tuples and submit them via pool.map()."},
        {"@type": "HowToStep", "name": "Explicitly close GDAL datasets", "text": "Assign None to dataset references to trigger GDALClose() and free C-level file handles."},
        {"@type": "HowToStep", "name": "Profile and cap worker count", "text": "Monitor iostat -x 1 and cap workers when disk utilisation exceeds 80 percent."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does GDAL segfault under fork-based multiprocessing?",
          "acceptedAnswer": {"@type": "Answer", "text": "Fork copies the parent's initialized GDAL driver registry and open file descriptors into every child. Multiple workers then race to mutate shared C-level state, producing segmentation faults. Switching to the spawn start method prevents this by starting fresh Python interpreters with no inherited state."}
        },
        {
          "@type": "Question",
          "name": "What should GDAL_NUM_THREADS be set to inside each worker?",
          "acceptedAnswer": {"@type": "Answer", "text": "Set GDAL_NUM_THREADS=1 and CPL_NUM_THREADS=1 per worker. The default ALL_CPUS means each worker spawns as many internal threads as there are CPU cores, causing severe oversubscription when combined with Python-level multiprocessing."}
        },
        {
          "@type": "Question",
          "name": "How do I prevent GDAL from leaking file descriptors across tasks?",
          "acceptedAnswer": {"@type": "Answer", "text": "Assign None to every dataset reference when the task is done. This triggers GDAL's C-level GDALClose(), which flushes write buffers and releases the file handle. Relying on Python's garbage collector is not reliable enough in long-running pool workers."}
        },
        {
          "@type": "Question",
          "name": "When does adding more workers stop helping?",
          "acceptedAnswer": {"@type": "Answer", "text": "Once disk utilisation (iostat %util) stays above 80%, the storage layer is saturated and adding workers increases seek contention rather than throughput. For local NVMe drives this point is usually around cpu_count(); for NFS or object storage cap at 4–8 workers."}
        }
      ]
    }
  ]
}
</script>

Safely parallelising GDAL with `multiprocessing.Pool` requires three things: forcing the `spawn` process start method so workers receive no inherited C-level state, running a per-worker initializer that calls `gdal.UseExceptions()` and caps internal threads to `1`, and explicitly setting dataset references to `None` when a task finishes. Without these steps, fork-based pools produce silent raster corruption and segmentation faults. This page is part of the [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) guide inside the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `gdal` from `python3-gdal` or a conda/mamba GDAL package (GDAL 3.4+)
- No additional pip install — `multiprocessing` is in the standard library

For broader context on why geospatial workloads need explicit parallelism strategies, read the [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) overview first.

## Why Fork Breaks GDAL

GDAL maintains global C-level state for driver registration, configuration options, error handlers, and virtual filesystem (VSI) connection pools. When Python's `multiprocessing` defaults to `fork` on Linux, each child process inherits a snapshot of the parent's memory — including open file descriptors and fully initialized GDAL drivers. Multiple workers then race to mutate this shared state, which produces:

- Segmentation faults from concurrent driver registry writes
- Silent raster corruption when two workers share a write file descriptor
- Memory growth without bound when VSI caches are duplicated across N workers

The `spawn` and `forkserver` start methods solve this by launching a fresh Python interpreter that imports nothing from the parent. GDAL initializes cleanly inside each worker with no inherited state.

<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Fork vs spawn process start method: fork inherits GDAL state causing race conditions; spawn starts a clean interpreter" style="max-width:100%;display:block;margin:1.5rem auto;">
  <title>Fork vs Spawn: GDAL state inheritance</title>
  <desc>Two side-by-side diagrams. On the left, a parent process with initialized GDAL forks into two workers that share state, with a collision marker. On the right, a parent spawns two workers that each initialize GDAL independently.</desc>
  <!-- Background panels -->
  <rect x="10" y="10" width="330" height="280" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <rect x="380" y="10" width="330" height="280" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <!-- Panel labels -->
  <text x="175" y="38" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">fork (default on Linux)</text>
  <text x="545" y="38" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">spawn (required for GDAL)</text>
  <!-- Fork side: parent -->
  <rect x="105" y="52" width="140" height="44" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="175" y="72" text-anchor="middle" font-size="11" fill="currentColor">Parent process</text>
  <text x="175" y="87" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">GDAL initialized</text>
  <!-- Fork arrows down -->
  <line x1="145" y1="96" x2="105" y2="148" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arr)"/>
  <line x1="205" y1="96" x2="245" y2="148" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arr)"/>
  <!-- Fork workers -->
  <rect x="50" y="148" width="110" height="44" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="105" y="168" text-anchor="middle" font-size="10" fill="currentColor">Worker 1</text>
  <text x="105" y="182" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">inherited state</text>
  <rect x="190" y="148" width="110" height="44" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="245" y="168" text-anchor="middle" font-size="10" fill="currentColor">Worker 2</text>
  <text x="245" y="182" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">inherited state</text>
  <!-- Race condition marker -->
  <text x="175" y="225" text-anchor="middle" font-size="20" fill="#c0392b" opacity="0.85">⚡</text>
  <text x="175" y="245" text-anchor="middle" font-size="10" fill="#c0392b" opacity="0.85">race condition / segfault</text>
  <!-- Spawn side: parent -->
  <rect x="475" y="52" width="140" height="44" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="545" y="72" text-anchor="middle" font-size="11" fill="currentColor">Parent process</text>
  <text x="545" y="87" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">dispatches tasks</text>
  <!-- Spawn arrows -->
  <line x1="515" y1="96" x2="475" y2="148" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arr)"/>
  <line x1="575" y1="96" x2="615" y2="148" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arr)"/>
  <!-- Spawn workers -->
  <rect x="420" y="148" width="110" height="44" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#27ae60" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="475" y="168" text-anchor="middle" font-size="10" fill="currentColor">Worker 1</text>
  <text x="475" y="182" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">init_gdal_worker()</text>
  <rect x="560" y="148" width="110" height="44" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#27ae60" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="615" y="168" text-anchor="middle" font-size="10" fill="currentColor">Worker 2</text>
  <text x="615" y="182" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">init_gdal_worker()</text>
  <!-- Spawn success -->
  <text x="545" y="225" text-anchor="middle" font-size="20" fill="#15803d" opacity="0.85">✓</text>
  <text x="545" y="245" text-anchor="middle" font-size="10" fill="#15803d" opacity="0.85">isolated, deterministic</text>
  <!-- Arrow marker -->
  <defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below batches GeoTIFF reprojection across a directory. Copy it, adjust `--crs` and paths, and run directly. All GDAL configuration happens inside `init_gdal_worker` so the main process remains clean:

```python
#!/usr/bin/env python3
"""
Batch raster reprojection with isolated multiprocessing.Pool workers.
Usage: python reproject_batch.py ./input ./output --crs EPSG:32633 --workers 4
"""
import os
import sys
import argparse
import logging
from pathlib import Path
from multiprocessing import Pool, cpu_count, set_start_method
from osgeo import gdal

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(processName)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)


def init_gdal_worker() -> None:
    """Run once per worker process before any task is dispatched.

    Calling gdal.UseExceptions() turns silent C-level NULL returns into
    Python RuntimeError, making failures visible to the pool error handler.
    Setting GDAL_NUM_THREADS=1 prevents GDAL from spawning its own thread
    pool inside each worker, which would multiply CPU usage by O(workers * cores).
    """
    gdal.UseExceptions()
    os.environ["GDAL_NUM_THREADS"] = "1"       # cap internal GDAL threads
    os.environ["CPL_NUM_THREADS"] = "1"        # cap CPL/CURL threads
    os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "YES"  # skip sibling-dir scan
    os.environ["VSI_CACHE"] = "FALSE"          # avoid duplicated VSI cache per worker
    if "GDAL_DATA" not in os.environ:
        os.environ["GDAL_DATA"] = "/usr/share/gdal"


def reproject_raster(task: tuple) -> dict:
    """Warp a single raster to the target CRS.

    Returns a dict so the main process can aggregate structured results
    for logging or downstream error-handling pipelines.
    """
    src_path, dst_path, target_crs = task
    try:
        src_ds = gdal.Open(str(src_path))
        if src_ds is None:
            raise RuntimeError(f"gdal.Open returned None for {src_path}")

        dst_ds = gdal.Warp(
            str(dst_path),
            src_ds,
            dstSRS=target_crs,          # e.g. "EPSG:32633"
            format="GTiff",
            creationOptions=[
                "TILED=YES",            # tiled layout for partial reads
                "COMPRESS=LZW",         # lossless, good ratio for elevation data
                "BIGTIFF=YES",          # avoids 4 GB limit on large mosaics
            ],
            numThreads=1,               # must match GDAL_NUM_THREADS
            resampleAlg="bilinear",
            errorThreshold=0.125,       # max warp error in output pixels
        )
        if dst_ds is None:
            raise RuntimeError(f"gdal.Warp produced no output for {src_path}")

        # Assign None to trigger GDALClose() immediately — do not rely on GC.
        # Skipping this leaks file descriptors in pools that process 1000+ files.
        dst_ds = None
        src_ds = None

        logging.info("OK %s", dst_path.name)
        return {"src": str(src_path), "ok": True, "error": None}
    except Exception as exc:
        logging.error("FAIL %s: %s", src_path, exc)
        return {"src": str(src_path), "ok": False, "error": str(exc)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch raster reprojection with isolated pool workers"
    )
    parser.add_argument("input_dir", type=Path, help="Directory containing source GeoTIFFs")
    parser.add_argument("output_dir", type=Path, help="Directory for reprojected outputs")
    parser.add_argument("--crs", default="EPSG:4326", help="Target CRS (default: EPSG:4326)")
    parser.add_argument(
        "--workers", type=int, default=cpu_count(),
        help="Worker process count (default: cpu_count)"
    )
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    tasks = [
        (src, args.output_dir / f"{src.stem}_reprojected.tif", args.crs)
        for src in sorted(args.input_dir.glob("*.tif"))
    ]
    if not tasks:
        logging.warning("No .tif files found in %s", args.input_dir)
        sys.exit(0)

    logging.info("Submitting %d tasks to %d workers", len(tasks), args.workers)

    # initializer= runs init_gdal_worker() once per worker before any task.
    # This is the correct hook — do NOT call GDAL init inside reproject_raster.
    with Pool(processes=args.workers, initializer=init_gdal_worker) as pool:
        results = pool.map(reproject_raster, tasks)

    ok = sum(1 for r in results if r["ok"])
    logging.info("Completed %d/%d successfully.", ok, len(tasks))
    sys.exit(0 if ok == len(tasks) else 1)


if __name__ == "__main__":
    # set_start_method must be called before Pool is created.
    # Placing it under __main__ prevents accidental re-invocation when
    # a spawned worker imports this module during startup.
    set_start_method("spawn", force=True)
    main()
```

## Step Annotations

1. **`init_gdal_worker()` as a Pool initializer** — `Pool(initializer=init_gdal_worker)` guarantees GDAL is configured before any task runs in that process. Calling the same setup code inside `reproject_raster` would work but re-runs on every call, wasting cycles and making state management error-prone.

2. **`GDAL_NUM_THREADS=1` and `CPL_NUM_THREADS=1`** — GDAL defaults both to `ALL_CPUS`. With 8 Python workers on an 8-core machine, the actual thread count becomes 64. This oversubscription stalls all workers in the OS scheduler. Setting both to `1` keeps the CPU budget predictable and matches the one-task-per-process model.

3. **`GDAL_DISABLE_READDIR_ON_OPEN=YES`** — By default, `gdal.Open()` scans the source directory for auxiliary files (`.aux.xml`, `.ovr`, `.prj`). On an NFS mount or S3-backed FUSE filesystem this can take several seconds per file. Disabling it cuts `gdal.Open()` latency by 60–90% for cold-cache workloads.

4. **`dst_ds = None` / `src_ds = None`** — Python's garbage collector does not call `GDALClose()` on a predictable schedule inside a long-running worker. Explicit `None` assignment triggers `__del__` immediately, flushing write buffers and releasing the OS file handle. This matters especially with `COMPRESS=LZW` because GDAL must write the compressed block table on close.

5. **`errorThreshold=0.125`** — Controls the maximum allowed deviation in output pixels during the reprojection warp. Lower values increase accuracy at the cost of CPU; `0.125` is the GDAL default and appropriate for most geospatial workflows. Reduce to `0.05` for high-precision DEMs.

6. **Return dict instead of bool** — Returning a structured dict from each task allows the calling code to aggregate failures, log CRS mismatches, or feed results into the [error-handling pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) pattern without re-parsing log output.

## Named Gotcha: Calling `set_start_method` Too Late

The single most common breakage pattern is placing `set_start_method("spawn")` inside `main()` after argument parsing, or calling it at module level outside the `if __name__ == "__main__"` guard. On the first run this appears to work. On the second `Pool` creation within the same interpreter it raises `RuntimeError: context already set`. Worse, a spawned worker imports the module during startup and hits the bare `set_start_method` call, triggering an import-time error that surfaces as a cryptic `Process ... exited with exitcode 1` in the pool.

The fix is shown in the implementation above: call `set_start_method("spawn", force=True)` as the very first statement under `if __name__ == "__main__":`, before calling `main()`. The `force=True` flag allows it to override an already-set context when running under test harnesses.

## Verification

After the run completes, confirm the output files are valid and carry the correct CRS:

```bash
# Check all outputs exist and are non-zero bytes
find ./output -name "*_reprojected.tif" -size 0 -print

# Confirm CRS on the first output file
python3 - <<'EOF'
from osgeo import gdal, osr
ds = gdal.Open("./output/scene_001_reprojected.tif")
srs = osr.SpatialReference()
srs.ImportFromWkt(ds.GetProjection())
print(srs.GetAuthorityCode(None))   # should print "32633" (or your target EPSG)
EOF

# Spot-check pixel count matches source dimensions after reprojection
gdalinfo ./output/scene_001_reprojected.tif | grep "Size is"
```

Exit code `0` from the script and a matching EPSG authority code confirm the run completed without silent failures. For [structured JSON logging of per-file outcomes](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/), pipe the returned `results` list to `json.dumps` before the process exits.

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| `Segmentation fault (core dumped)` | Forked worker inherits initialized GDAL drivers | `set_start_method("spawn", force=True)` |
| CPU at 100% but low throughput | GDAL internal threads + Python workers = oversubscription | `GDAL_NUM_THREADS=1`, `CPL_NUM_THREADS=1` |
| Memory grows until OOM kill | Unclosed datasets or duplicated VSI cache | `ds = None` after each task; `VSI_CACHE=FALSE` |
| Silent failures / empty output files | `gdal.Warp` returns `None` without raising | `gdal.UseExceptions()` in initializer |
| Slow open on networked or cloud storage | Directory scanning on every `gdal.Open()` | `GDAL_DISABLE_READDIR_ON_OPEN=YES` |
| `RuntimeError: context already set` | `set_start_method` called after first Pool | Move it to `if __name__ == "__main__":` entry point |

## FAQ

<details class="faq-item">
<summary><span>Can I use <code>forkserver</code> instead of <code>spawn</code>?</span></summary>

Yes. `forkserver` also avoids inheriting GDAL state by launching a dedicated server process that forks clean children on demand. It is slightly faster than `spawn` on Linux because it avoids re-importing the full module tree per worker. Use `set_start_method("forkserver")` in the same `__main__` guard. Note that `forkserver` is not available on Windows.

</details>

<details class="faq-item">
<summary>How many workers should I use for cloud-storage inputs (S3, GCS)?</summary>

For object storage accessed via GDAL's VSI layer (`/vsis3/`, `/vsigs/`), network round-trips dominate latency rather than CPU. Start with `workers=8` regardless of CPU count, then benchmark with `iostat` and `htop`. Increase until either CPU or network throughput plateaus. Also set `VSI_CACHE=TRUE` and `GDAL_CACHEMAX=256` in `init_gdal_worker` to cache HTTP responses across tasks within the same worker process.

</details>

<details class="faq-item">
<summary>Why does my pool hang instead of producing errors?</summary>

Deadlocks in `multiprocessing.Pool` most often come from a worker process being killed by the OS (OOM, segfault) while holding a lock on the result queue. Run with `maxtasksperchild=50` to recycle workers periodically: `Pool(processes=N, initializer=init_gdal_worker, maxtasksperchild=50)`. This limits memory accumulation per worker and prevents a single leaked dataset from growing indefinitely.

</details>

<details class="faq-item">
<summary>Does this pattern apply to rasterio batch jobs too?</summary>

Yes. Rasterio wraps GDAL and inherits the same C-level state risks under `fork`. Use the same `spawn` start method and a `rasterio.Env` context manager inside the worker initializer instead of setting raw environment variables. See the [async I/O for raster processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) pattern for how `asyncio` and rasterio compare to multiprocessing for I/O-bound workloads.

</details>

---

## Related

- [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) — parent guide covering worker pool patterns, task chunking, and shared-memory strategies for geospatial data
- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — when to prefer `asyncio` over `multiprocessing` for I/O-bound raster pipelines
- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — structured failure capture and retry logic for batch raster and vector workflows
