# Handling out-of-memory errors in large raster mosaics

Handling out-of-memory errors in large raster mosaics requires abandoning eager array loading in favor of disk-backed, windowed I/O with explicit spatial chunking. Instead of materializing the full pixel matrix in RAM, you must treat the dataset as a stream of aligned spatial windows, read them lazily, process them in isolation, and write intermediate blocks directly to disk. This pattern caps peak memory usage to the size of a single chunk plus minimal GDAL cache overhead, regardless of whether you are stitching Sentinel-2 composites, LiDAR DEMs, or multi-terabyte orthomosaics.

## Why OOM Errors Trigger in Mosaic Workflows

Raster processing pipelines fail under memory pressure for three predictable reasons:

1. **Eager Loading Defaults:** Most Python GIS libraries default to reading entire extents into contiguous NumPy arrays. A 10,000×10,000 3-band `uint16` mosaic consumes ~600 MB raw, but NumPy’s allocation overhead, GDAL’s internal block cache, and Python’s object headers can easily triple that footprint.
2. **GDAL Cache Bloat:** GDAL aggressively caches recently read blocks to speed up repeated access. Without explicit limits, the cache grows until the OS kernel invokes the OOM killer.
3. **Parallel Worker Multiplication:** When CLI tools spawn multiple workers or thread pools, each process inherits a copy of the dataset metadata and cache state. Concurrent windowed reads without strict memory boundaries cause exponential RAM multiplication.

The architectural fix is to decouple spatial extent from memory allocation. By streaming data through virtual raster formats (VRT), memory-mapped buffers, or lazy windowed reads, you align with established [Memory Management for Large Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) practices. Disk-backed buffers, lazy evaluation, and strict reference scoping replace in-memory accumulation, enabling pipelines to scale horizontally without vertical RAM upgrades.

## The Streaming Architecture

A production-ready mosaic pipeline follows this execution model:

- **Unify Metadata First:** Generate a lightweight VRT to harmonize CRS, resolution, and bounding extents. VRTs contain zero pixel data; they only store coordinate transforms and source file pointers.
- **Calculate Aligned Windows:** Divide the unified extent into a grid of spatially contiguous windows that match your target disk block size (typically 256–1024 pixels).
- **Stream Read/Write:** Open the VRT, iterate through the window grid, read only the current window into RAM, apply transformations, and write directly to the output GeoTIFF.
- **Explicit Memory Teardown:** Delete array references immediately after writing and invoke Python’s garbage collector to prevent heap fragmentation during long-running loops.

This approach integrates cleanly into [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) by allowing each window to be dispatched as an independent task. Workers can pull from a shared queue, process isolated tiles, and flush results to S3 or local storage without sharing mutable state.

## Production CLI Implementation

The following script demonstrates a robust, CLI-ready implementation. It builds a temporary VRT, calculates aligned windows, and streams reads/writes without loading the full extent.

```python
# mosaic_stream_cli.py
import argparse
import gc
import tempfile
from pathlib import Path
import rasterio
from rasterio.windows import Window
from osgeo import gdal
import numpy as np

def build_vrt(inputs: list[str], vrt_path: str) -> None:
    """Create a virtual raster to unify CRS, resolution, and extents."""
    vrt = gdal.BuildVRT(vrt_path, inputs, resolution="highest", resampleAlg="nearest")
    if vrt is None:
        raise RuntimeError(f"gdal.BuildVRT failed for inputs: {inputs}")
    vrt.FlushCache()
    vrt = None

def stream_mosaic(vrt_path: str, output_path: str, chunk_size: int = 1024) -> None:
    """Merge large rasters using windowed I/O to prevent OOM."""
    with rasterio.open(vrt_path) as src:
        meta = src.meta.copy()
        meta.update(
            driver="GTiff",
            compress="LZW",
            tiled=True,
            blockxsize=chunk_size,
            blockysize=chunk_size,
            interleave="band",
            dtype=src.dtypes[0]
        )

        with rasterio.open(output_path, "w", **meta) as dst:
            for col in range(0, src.width, chunk_size):
                for row in range(0, src.height, chunk_size):
                    width = min(chunk_size, src.width - col)
                    height = min(chunk_size, src.height - row)
                    window = Window(col, row, width, height)

                    # Lazy read: only loads the current window into RAM
                    data = src.read(window=window)

                    # Write directly to disk; no intermediate accumulation
                    dst.write(data, window=window)

                    # Explicitly release memory to prevent heap fragmentation
                    del data
                    gc.collect()

def main() -> None:
    parser = argparse.ArgumentParser(description="Stream-merge large rasters without OOM.")
    parser.add_argument("inputs", nargs="+", help="Input raster paths")
    parser.add_argument("-o", "--output", required=True, help="Output GeoTIFF path")
    parser.add_argument("-c", "--chunk", type=int, default=1024, help="Window size in pixels")
    args = parser.parse_args()

    vrt_path = Path(tempfile.mktemp(suffix=".vrt"))
    try:
        build_vrt(args.inputs, str(vrt_path))
        stream_mosaic(str(vrt_path), args.output, args.chunk)
    finally:
        if vrt_path.exists():
            vrt_path.unlink()

if __name__ == "__main__":
    main()
```

### Key Memory-Safety Features
- **Context Managers:** `with rasterio.open()` ensures file handles and GDAL datasets are closed deterministically.
- **Window Alignment:** `min(chunk_size, remaining)` prevents out-of-bounds reads at tile edges.
- **Explicit Teardown:** `del data` + `gc.collect()` forces immediate memory reclamation, critical for long-running loops where Python’s reference counting alone may delay cleanup.
- **Disk-Aligned Blocks:** `blockxsize`/`blockysize` match the chunk size, ensuring the output TIFF is optimized for subsequent windowed reads.

## Memory & I/O Tuning

Streaming alone won’t prevent OOM if underlying drivers are misconfigured. Apply these tuning steps before scaling to production:

- **Limit GDAL Cache:** Set `GDAL_CACHEMAX` to 25–50% of available system RAM. Exceeding this forces swap usage, which degrades throughput and triggers kernel OOM under concurrent loads. See the official [GDAL Configuration Options](https://gdal.org/user/configoptions.html) for environment variable syntax and cache tuning strategies.
- **Match Chunk to Disk Block Size:** Query your storage layer’s block size (e.g., `stat -fc %s /path/to/mount`). Align `chunk_size` to this value to minimize read-amplification and maximize sequential I/O throughput.
- **Control Python GC Thresholds:** For pipelines processing millions of windows, disable automatic garbage collection during the hot loop and trigger it manually after every N iterations. This reduces GC-induced latency spikes. Reference Python’s official [Garbage Collector Interface](https://docs.python.org/3/library/gc.html) for `gc.disable()`, `gc.collect()`, and threshold tuning.
- **Avoid Implicit Copies:** Never use `data.copy()` or `np.array(data)` unless mutation is required. NumPy views and in-place operations (`data *= scale`) preserve memory locality.
- **Profile Before Parallelizing:** Use `memory_profiler` or `tracemalloc` to verify that peak RAM stays within `chunk_size * bands * dtype_bytes + GDAL_CACHEMAX`. Only introduce multiprocessing after single-threaded streaming proves stable.

By treating raster extents as streams rather than monolithic arrays, you eliminate the primary failure mode in geospatial ETL. The pattern scales predictably across cloud storage, local NVMe arrays, and distributed batch schedulers without requiring vertical hardware upgrades.