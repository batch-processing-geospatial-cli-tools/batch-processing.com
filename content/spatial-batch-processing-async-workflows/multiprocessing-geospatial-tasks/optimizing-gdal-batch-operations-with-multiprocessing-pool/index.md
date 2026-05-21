# Optimizing GDAL Batch Operations with Multiprocessing Pool

Optimizing GDAL batch operations with multiprocessing pool requires isolating GDAL’s C-level state per worker, enforcing the `spawn` or `forkserver` process start method, and explicitly resetting environment variables inside each worker. The optimal pattern uses `multiprocessing.Pool` with a worker initialization function that calls `gdal.UseExceptions()`, sets `GDAL_NUM_THREADS=1`, and disables driver caching conflicts. This avoids segmentation faults, GIL contention, and memory leaks while scaling linearly across physical cores until disk I/O becomes the bottleneck.

## Why Default Forking Breaks GDAL

GDAL maintains global C-level state for driver registration, configuration options, error handlers, and connection pools. When Python’s `multiprocessing` defaults to `fork` on Linux, child processes inherit a snapshot of the parent’s memory, including open file descriptors and initialized GDAL drivers. This creates race conditions, silent raster corruption, and unpredictable segmentation faults when multiple workers attempt to register drivers or access shared caches simultaneously.

Additionally, Python’s Global Interpreter Lock (GIL) does not protect GDAL’s underlying C/C++ code. Without explicit isolation, parallel raster operations trigger cross-process lock contention and CPU oversubscription. For teams designing [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/), the standard mitigation is to bypass `fork` entirely and force a clean process start.

## Architecture & Worker Isolation

Each worker must initialize its own independent GDAL context. The safest approach is to pass an `initializer` callback to the pool that resets the environment and configures GDAL before any raster I/O occurs:

1. **Force `spawn` or `forkserver`**: These methods start fresh Python interpreters, preventing inherited C-state corruption. See the official [Python multiprocessing start methods](https://docs.python.org/3/library/multiprocessing.html#contexts-and-start-methods) for platform-specific behavior.
2. **Cap internal threads**: GDAL’s `GDAL_NUM_THREADS` and `CPL_NUM_THREADS` default to `ALL_CPUS`. When combined with Python-level multiprocessing, this causes severe CPU oversubscription and memory fragmentation. Set both to `1` per worker.
3. **Disable aggressive caching**: `GDAL_DISABLE_READDIR_ON_OPEN=YES` prevents GDAL from scanning sibling directories on every `Open()` call, which drastically reduces latency on networked or cloud storage.
4. **Enable strict error handling**: `gdal.UseExceptions()` converts silent C-level failures into Python exceptions, enabling proper logging and retry logic.

This isolation strategy ensures predictable memory footprints and eliminates cross-process lock contention, forming the foundation for reliable [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) in production environments.

## Production-Ready Implementation

The following script demonstrates a robust CLI tool for batch raster reprojection. It uses explicit process isolation, chunked task generation, and structured error logging suitable for internal tooling pipelines.

```python
#!/usr/bin/env python3
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
    handlers=[logging.StreamHandler(sys.stdout)]
)

def init_gdal_worker():
    """Initialize a clean GDAL context inside each worker process."""
    gdal.UseExceptions()
    os.environ["GDAL_NUM_THREADS"] = "1"
    os.environ["CPL_NUM_THREADS"] = "1"
    os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "YES"
    os.environ["VSI_CACHE"] = "FALSE"
    if "GDAL_DATA" not in os.environ:
        os.environ["GDAL_DATA"] = "/usr/share/gdal"

def process_raster(args_tuple: tuple) -> bool:
    """Warp a single raster. Returns True on success, False on failure."""
    src_path, dst_path, target_crs = args_tuple
    try:
        src_ds = gdal.Open(str(src_path))
        if src_ds is None:
            raise RuntimeError(f"Failed to open source: {src_path}")

        dst_ds = gdal.Warp(
            str(dst_path),
            src_ds,
            dstSRS=target_crs,
            format="GTiff",
            creationOptions=["TILED=YES", "COMPRESS=LZW", "BIGTIFF=YES"],
            numThreads=1,
            resampleAlg="bilinear",
            errorThreshold=0.125
        )
        if dst_ds is None:
            raise RuntimeError(f"Warp failed for {src_path}")
        
        # Explicitly close datasets to free C-level handles
        dst_ds = None
        src_ds = None
        logging.info(f"Completed: {dst_path}")
        return True
    except Exception as e:
        logging.error(f"Failed {src_path}: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Batch raster reprojection with isolated workers")
    parser.add_argument("input_dir", type=Path, help="Directory containing source rasters")
    parser.add_argument("output_dir", type=Path, help="Directory for output rasters")
    parser.add_argument("--crs", default="EPSG:4326", help="Target CRS (default: EPSG:4326)")
    parser.add_argument("--workers", type=int, default=cpu_count(), help="Number of worker processes")
    args = parser.parse_args()

    # Force spawn to avoid fork-related GDAL state corruption
    set_start_method("spawn", force=True)

    args.input_dir.mkdir(parents=True, exist_ok=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    tasks = [
        (src, args.output_dir / f"{src.stem}_warped.tif", args.crs)
        for src in args.input_dir.glob("*.tif")
    ]

    if not tasks:
        logging.warning("No .tif files found in input directory.")
        sys.exit(0)

    logging.info(f"Processing {len(tasks)} rasters with {args.workers} workers...")
    
    with Pool(processes=args.workers, initializer=init_gdal_worker) as pool:
        results = pool.map(process_raster, tasks)
    
    success_count = sum(results)
    logging.info(f"Finished: {success_count}/{len(tasks)} successful.")
    sys.exit(0 if success_count == len(tasks) else 1)

if __name__ == "__main__":
    main()
```

### Key Implementation Notes
- **Explicit Dataset Closure**: Setting `dst_ds = None` triggers GDAL’s C-level `GDALClose()`, preventing file descriptor leaks in long-running pools.
- **Creation Options**: `TILED=YES` and `COMPRESS=LZW` optimize downstream read performance and storage footprint. `BIGTIFF=YES` prevents 4GB limits on large mosaics.
- **Error Threshold**: `errorThreshold=0.125` balances reprojection accuracy with execution speed for most geospatial workflows. Consult the [GDAL Warp API documentation](https://gdal.org/en/stable/api/python/osgeo.gdal.html#osgeo.gdal.Warp) for algorithm-specific tuning.

## Scaling & I/O Bottlenecks

Multiprocessing scales linearly only until storage throughput saturates. When optimizing GDAL batch operations with multiprocessing pool, monitor disk I/O using `iostat -x 1` or `iotop`. Once `%util` exceeds 80%, adding workers degrades performance due to seek contention and page cache thrashing.

**Mitigation strategies:**
- **Chunk by storage tier**: Group tasks by underlying disk or cloud bucket to maximize sequential I/O.
- **Adjust worker count**: Set `--workers` to `min(cpu_count(), disk_io_capacity)`. For NVMe arrays, `cpu_count()` usually works. For networked storage (NFS/S3), cap at `4–8` workers.
- **Use VSI caching selectively**: If processing remote data, set `VSI_CACHE=TRUE` and `GDAL_CACHEMAX=256` in the initializer to reduce HTTP round-trips.
- **Profile with `cProfile`**: Identify whether time is spent in `gdal.Open()` (metadata parsing), `gdal.Warp()` (compute), or file I/O.

## Troubleshooting Checklist

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| `Segmentation fault (core dumped)` | Forked process inherits initialized GDAL drivers | Use `set_start_method("spawn")` |
| `CPU at 100% but low throughput` | GDAL internal threads + Python workers = oversubscription | Set `GDAL_NUM_THREADS=1` per worker |
| `Memory grows until OOM kill` | Unclosed datasets or VSI cache accumulation | Explicitly set `ds = None`; disable `VSI_CACHE` |
| `Silent failures / empty outputs` | GDAL returns `NULL` without raising | Call `gdal.UseExceptions()` in initializer |
| `Slow on cloud storage` | Directory scanning on every `Open()` | Set `GDAL_DISABLE_READDIR_ON_OPEN=YES` |

By enforcing strict process isolation, capping internal threading, and aligning worker counts with I/O capacity, you can safely parallelize GDAL workloads without compromising stability or data integrity.