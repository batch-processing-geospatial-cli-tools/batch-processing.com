---
title: "Memory Management for Large GIS Datasets"
description: "Keep Python GIS batch pipelines within memory bounds using windowed raster I/O, chunked vector reads, process-level ceilings, and tracemalloc-based drift detection."
slug: "memory-management-for-large-datasets"
type: "cluster"
breadcrumb: "Spatial Batch Processing & Async Workflows > Memory Management for Large Datasets"
datePublished: "2024-11-12"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Memory Management for Large GIS Datasets",
      "description": "Keep Python GIS batch pipelines within memory bounds using windowed raster I/O, chunked vector reads, process-level ceilings, and tracemalloc-based drift detection.",
      "datePublished": "2024-11-12",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "batch-processing.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/" },
        { "@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/" },
        { "@type": "ListItem", "position": 3, "name": "Memory Management for Large Datasets", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Memory-Efficient Python GIS Batch Processing",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Profile baseline allocation with tracemalloc and psutil" },
        { "@type": "HowToStep", "position": 2, "name": "Implement block-aligned windowed raster I/O with rasterio" },
        { "@type": "HowToStep", "position": 3, "name": "Stream vector features in chunks using pyogrio" },
        { "@type": "HowToStep", "position": 4, "name": "Enforce process-level memory ceilings with resource.setrlimit" },
        { "@type": "HowToStep", "position": 5, "name": "Instrument per-iteration allocation drift and fail fast on threshold breach" }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does RSS keep growing even after I call del and gc.collect()?",
          "acceptedAnswer": { "@type": "Answer", "text": "Python frees heap pages back to the OS lazily. More often the culprit is a C-backed library — GDAL, GEOS, or a NumPy buffer — that holds a memory-mapped file descriptor. Ensure rasterio datasets are closed inside their context managers and call pyogrio's returned DataFrames explicit del before gc.collect(). If RSS still grows, run tracemalloc snapshots before and after the suspect loop: the diff will point to the allocation site." }
        },
        {
          "@type": "Question",
          "name": "What is a safe GDAL_CACHEMAX value for a container with 4 GB RAM?",
          "acceptedAnswer": { "@type": "Answer", "text": "Set GDAL_CACHEMAX to 512 (MiB) — roughly 12 % of total RAM. GDAL's default of 256 MiB is reasonable for single-file reads but too high when several workers share the same host. Leave headroom for NumPy working arrays: each 10 000 × 10 000 float32 band costs 400 MB, so size the cache against your actual window dimensions, not the full scene." }
        },
        {
          "@type": "Question",
          "name": "Should I use RLIMIT_AS or RLIMIT_DATA to cap worker memory?",
          "acceptedAnswer": { "@type": "Answer", "text": "Prefer RLIMIT_AS (virtual address space) — it catches GDAL's mmap allocations that RLIMIT_DATA misses. Set it 20 % above your measured peak RSS to avoid spurious ENOMEM on startup, then tighten after profiling. In containers, pair it with the cgroup memory.limit_in_bytes so the OOM killer targets your process specifically rather than a random neighbor." }
        },
        {
          "@type": "Question",
          "name": "How does pyogrio Arrow mode reduce memory compared to a normal read?",
          "acceptedAnswer": { "@type": "Answer", "text": "When use_arrow=True, pyogrio returns a zero-copy Arrow RecordBatch backed by shared memory rather than copying data into pandas object arrays. For string-heavy attribute tables (e.g., parcel IDs, land-use codes) this typically halves peak allocation. Downside: GeoDataFrame operations that mutate the geometry column will trigger a copy-on-write; keep the chunk immutable until you have filtered it." }
        },
        {
          "@type": "Question",
          "name": "At what chunk size does windowed rasterio I/O stop being faster than a full read?",
          "acceptedAnswer": { "@type": "Answer", "text": "When the window is smaller than the raster's native tile or block size GDAL decompresses the full block anyway, so very small windows thrash I/O without saving memory. Read src.profile['blockxsize'] and src.profile['blockysize'] and make your window a multiple of those values. For untiled GeoTIFFs (blockysize=1, strip layout), row-band reads in batches of 256–1024 rows outperform pixel-level windows." }
        }
      ]
    }
  ]
}
</script>

**TL;DR:** Replace naive full-file loads with block-aligned windowed reads for rasters and offset/limit streaming for vectors, cap each worker's virtual address space with `resource.setrlimit`, and detect slow leaks with per-iteration `tracemalloc` snapshots — that combination keeps Python GIS batch pipelines within predictable memory bounds regardless of input size.

## Prerequisites

- Python 3.9+ (type annotations, `contextlib.contextmanager`, `tracemalloc` in stdlib)
- `pip install rasterio>=1.3 geopandas>=1.0 shapely>=2.0 pyogrio>=0.7 psutil`
- GDAL/OGR installed system-wide or via `conda-forge`; `gdal-config --version` should succeed
- Familiarity with the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) patterns covered in the parent guide

Set these two environment variables before any GIS import to cap GDAL's internal cache and prevent it from competing with your Python working arrays:

```python
import os
os.environ.setdefault("GDAL_CACHEMAX", "512")       # MiB; tune to ~12 % of total RAM
os.environ.setdefault("GDAL_NUM_THREADS", "ALL_CPUS")
```

## Problem Framing

A single multispectral Sentinel-2 scene at full resolution is roughly 11 GB on disk; a continental LiDAR point cloud or a national parcel vector database routinely exceeds 20 GB. Loading either naively with `rasterio.open(path).read()` or `gpd.read_file(path)` works on a laptop with nothing else running. In a batch job — where six workers share a 32 GB host, GDAL keeps its own block cache, and NumPy allocates contiguous arrays for every window — the same code triggers the OOM killer within minutes.

The failure mode is subtle: jobs succeed on small test inputs, pass CI, then die in production at 3 AM when the input is 40× larger. This page documents the specific patterns that prevent that failure class without sacrificing throughput.

## Step-by-Step Implementation

### Step 1 — Profile Baseline Allocation

Before writing any chunking code, measure what "normal" looks like on a representative input. This function captures both the Python heap (via `tracemalloc`) and the OS-reported RSS (via `psutil`):

```python
import tracemalloc
import psutil
import os
from pathlib import Path

def start_memory_baseline() -> dict:
    """Capture baseline RSS and Python heap before the processing loop."""
    tracemalloc.start()
    proc = psutil.Process(os.getpid())
    return {
        "rss_mb": proc.memory_info().rss / 1_048_576,
        "heap_mb": tracemalloc.get_traced_memory()[0] / 1_048_576,
    }

def check_drift(baseline: dict, threshold_mb: float = 100.0) -> None:
    """Raise MemoryError if RSS has grown more than threshold_mb since baseline."""
    current_rss = psutil.Process(os.getpid()).memory_info().rss / 1_048_576
    drift = current_rss - baseline["rss_mb"]
    if drift > threshold_mb:
        snapshot = tracemalloc.take_snapshot()
        top = snapshot.statistics("lineno")[:5]
        detail = "\n".join(str(s) for s in top)
        raise MemoryError(
            f"RSS drifted +{drift:.1f} MB above baseline.\nTop allocators:\n{detail}"
        )
```

Run `start_memory_baseline()` once before your outer loop, then call `check_drift()` at the end of each iteration. When drift exceeds the threshold the exception surfaces the exact Python lines responsible — no guessing.

### Step 2 — Block-Aligned Windowed Raster I/O

The most reliable way to read a large raster is to follow its native tile structure. GDAL decompresses at block boundaries; reading smaller-than-block windows forces it to decompress the same block multiple times.

```python
import rasterio
from rasterio.windows import Window
import numpy as np
from pathlib import Path

def iter_raster_windows(
    src_path: Path,
    max_chunk_mb: float = 256.0,
    band: int = 1,
):
    """Yield (window, data) pairs aligned to the raster's native block size."""
    with rasterio.open(src_path) as src:
        bx = src.profile.get("blockxsize", 256)
        by = src.profile.get("blockysize", 256)

        # Target rows per chunk so the read fits within max_chunk_mb.
        # float32 = 4 bytes/pixel; scale by band count for multi-band reads.
        bytes_per_row = src.width * 4
        rows_per_chunk = max(by, int((max_chunk_mb * 1_048_576) / bytes_per_row))
        # Align to native block height to avoid partial-block re-reads.
        rows_per_chunk = (rows_per_chunk // by) * by or by

        for row_off in range(0, src.height, rows_per_chunk):
            actual_rows = min(rows_per_chunk, src.height - row_off)
            win = Window(0, row_off, src.width, actual_rows)
            data = src.read(band, window=win, masked=True).astype(np.float32)
            yield win, data
            del data   # dereference immediately; do not accumulate


def process_raster(src_path: Path, dst_path: Path) -> None:
    """Normalise a raster to [0, 1] using block-aligned windowed reads."""
    with rasterio.open(src_path) as src:
        profile = src.profile.copy()
        profile.update(dtype="float32", compress="lzw", predictor=2)

    with rasterio.open(dst_path, "w", **profile) as dst:
        for win, data in iter_raster_windows(src_path):
            normalised = (data / 10_000.0).clip(0.0, 1.0)
            dst.write(normalised, 1, window=win)
            del normalised
```

When you need overlapping reads for edge-aware filters or convolution kernels, pair this pattern with [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) to overlap disk I/O with CPU-bound computation without blocking the main thread.

### Step 3 — Chunked Vector Streaming with `pyogrio`

`pyogrio` exposes OGR's offset/limit interface and, with `use_arrow=True`, returns zero-copy Arrow buffers instead of copying attribute data into pandas object arrays. For parcel or address tables with many string columns this typically halves peak allocation.

```python
import geopandas as gpd
import pandas as pd
import pyogrio
from pathlib import Path

def iter_vector_chunks(
    src_path: Path,
    chunk_size: int = 10_000,
    where: str | None = None,
):
    """Yield GeoDataFrame chunks using pyogrio offset/limit reads."""
    info = pyogrio.read_info(str(src_path))
    total = info["features"]

    for offset in range(0, total, chunk_size):
        chunk: gpd.GeoDataFrame = pyogrio.read_dataframe(
            str(src_path),
            rows=slice(offset, offset + chunk_size),
            where=where,
            use_arrow=True,
        )
        yield chunk
        del chunk   # release Arrow buffers before next fetch


def filter_large_parcels(
    src_path: Path,
    dst_path: Path,
    min_area_sqm: float = 5_000.0,
) -> int:
    """Write parcels larger than min_area_sqm to dst_path; return row count."""
    kept: list[gpd.GeoDataFrame] = []

    for chunk in iter_vector_chunks(src_path):
        # geometry.area is in the CRS units; ensure EPSG:3857 / metric CRS
        mask = chunk.geometry.area >= min_area_sqm
        if mask.any():
            kept.append(chunk.loc[mask].copy())

    if not kept:
        return 0

    result = pd.concat(kept, ignore_index=True)
    result.to_file(str(dst_path), driver="GPKG")
    return len(result)
```

For a deeper treatment of chunk-size tuning and Arrow schema negotiation, see [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/).

### Step 4 — Explicit Resource Teardown

Python's reference counter handles most cleanup but C-backed GIS libraries retain file descriptors and memory-mapped buffers until explicitly released. The pattern below enforces cleanup at each boundary:

```python
import gc

def release_chunk(obj) -> None:
    """Dereference obj and hint Python to reclaim C-backed memory."""
    del obj
    gc.collect()
    # On Linux inside a privileged container only — drops page-cache pages
    # that GDAL has already flushed. Do NOT use on shared hosts.
    # if os.path.exists("/proc/sys/vm/drop_caches") and os.geteuid() == 0:
    #     Path("/proc/sys/vm/drop_caches").write_text("3")
```

Do not call `gc.collect()` inside a tight inner loop — its overhead is measurable. One call per chunk boundary (every 10 000 features or after each raster window batch) is sufficient.

### Step 5 — Process-Level Memory Ceilings

Relying on the OS OOM killer to terminate an over-allocating worker is unsafe in batch jobs: OOM kills are non-deterministic, leave stale lock files, and corrupt incomplete outputs. Use `resource.setrlimit` to install a hard ceiling that raises `MemoryError` predictably before thrashing begins.

```python
import resource
import sys

def set_memory_ceiling_mb(limit_mb: int) -> None:
    """
    Cap this process's virtual address space to limit_mb MiB.

    Set limit_mb to peak_observed_rss * 1.20 to leave 20 % headroom
    for GDAL's internal cache and Python's interpreter overhead.
    """
    limit_bytes = limit_mb * 1_048_576
    _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    new_soft = (
        min(limit_bytes, hard)
        if hard != resource.RLIM_INFINITY
        else limit_bytes
    )
    resource.setrlimit(resource.RLIMIT_AS, (new_soft, hard))


def entry_point(args) -> int:
    """CLI entry point; returns POSIX exit code."""
    set_memory_ceiling_mb(args.memory_limit_mb)
    baseline = start_memory_baseline()
    try:
        process_raster(args.src, args.dst)
        return 0
    except MemoryError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 137   # mirrors SIGKILL / OOM exit convention
    finally:
        check_drift(baseline, threshold_mb=200.0)
```

Exit code 137 (`128 + SIGKILL`) is the conventional code for container OOM kills. Using it for controlled memory failures makes log aggregation and alerting rules consistent across self-triggered and kernel-triggered exits.

## Configuration Integration

Batch runners expose memory limits through the standard layered config pattern: default in code, overridable by config file, then environment variable, then CLI flag. This precedence prevents accidental production runs with a developer's laptop defaults.

```python
# defaults.yaml (lowest priority)
# memory_limit_mb: 2048
# chunk_rows: 10000
# gdal_cachemax: 512

import os
from pathlib import Path
import yaml

def load_config(config_path: Path | None = None) -> dict:
    defaults = {
        "memory_limit_mb": 2048,
        "chunk_rows": 10_000,
        "gdal_cachemax": 512,
    }
    if config_path and config_path.exists():
        with config_path.open() as f:
            file_cfg = yaml.safe_load(f) or {}
        defaults.update(file_cfg)

    # Environment variables override file config
    if val := os.environ.get("BATCH_MEMORY_LIMIT_MB"):
        defaults["memory_limit_mb"] = int(val)
    if val := os.environ.get("GDAL_CACHEMAX"):
        defaults["gdal_cachemax"] = int(val)

    return defaults
```

Apply `GDAL_CACHEMAX` before the first `rasterio` import; Python caches the environment at module load time and setting it after `import rasterio` has no effect.

## Architecture Diagram

The diagram below shows how memory flows through a single batch worker: from disk through GDAL's block cache into a NumPy window array, then through the transformation step, and finally back to disk — with explicit teardown at each boundary.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Memory flow diagram for a windowed raster batch worker" style="width:100%;max-width:720px;display:block;margin:1.5rem auto">
  <title>Windowed raster batch worker — memory flow</title>
  <desc>Data flows from a GeoTIFF on disk into GDAL block cache, then into a NumPy window array. After transformation the result is written back to disk. At each boundary explicit del and gc.collect() release memory. A process ceiling set by resource.setrlimit guards the whole pipeline.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.7"/>
    </marker>
  </defs>
  <!-- Process boundary box -->
  <rect x="10" y="10" width="700" height="320" rx="10" ry="10"
        fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.3"/>
  <text x="360" y="30" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.5"
        font-family="system-ui,sans-serif">Python worker process — resource.setrlimit(RLIMIT_AS)</text>
  <!-- Disk -->
  <rect x="30" y="120" width="120" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="90" y="147" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">GeoTIFF</text>
  <text x="90" y="163" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">on disk</text>
  <!-- Arrow disk → GDAL -->
  <line x1="150" y1="150" x2="210" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.7"/>
  <text x="180" y="142" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="system-ui,sans-serif">block I/O</text>
  <!-- GDAL block cache -->
  <rect x="210" y="105" width="140" height="90" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="280" y="143" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">GDAL block</text>
  <text x="280" y="159" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">cache</text>
  <text x="280" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="system-ui,sans-serif">GDAL_CACHEMAX</text>
  <!-- Arrow GDAL → NumPy -->
  <line x1="350" y1="150" x2="410" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.7"/>
  <text x="380" y="142" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="system-ui,sans-serif">window read</text>
  <!-- NumPy window -->
  <rect x="410" y="105" width="140" height="90" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="480" y="143" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">NumPy</text>
  <text x="480" y="159" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">window array</text>
  <text x="480" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="system-ui,sans-serif">float32 working set</text>
  <!-- Arrow NumPy → transform -->
  <line x1="550" y1="150" x2="610" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.7"/>
  <text x="580" y="142" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55" font-family="system-ui,sans-serif">transform</text>
  <!-- Output -->
  <rect x="610" y="120" width="90" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="655" y="147" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">Output</text>
  <text x="655" y="163" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">GeoTIFF</text>
  <!-- del / gc.collect labels below arrows -->
  <text x="350" y="230" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="system-ui,sans-serif">del data; gc.collect()</text>
  <line x1="350" y1="218" x2="350" y2="196" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>
  <text x="550" y="260" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="system-ui,sans-serif">del normalised</text>
  <line x1="550" y1="248" x2="550" y2="196" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>
  <!-- tracemalloc / psutil monitor bar -->
  <rect x="30" y="285" width="660" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.25"/>
  <text x="360" y="304" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">tracemalloc + psutil — drift monitored per iteration; MemoryError on threshold breach</text>
</svg>

## Error Handling and Gotchas

### CRS Mismatch Causes Silent Geometry Expansion

A GeoDataFrame in EPSG:4326 (degrees) passed to `.geometry.area` returns values in square degrees, not square metres. One square degree near the equator is roughly 1.2 × 10¹⁰ m², making area filters meaningless. Always reproject to a metric CRS before area comparisons:

```python
chunk_metric = chunk.to_crs(epsg=3857)  # Web Mercator; use local UTM for accuracy
mask = chunk_metric.geometry.area >= min_area_sqm
```

### Block Misalignment Penalty

Reading windows that straddle GDAL block boundaries forces the driver to decompress two or more blocks and discard the parts outside your window. For a 256×256-tiled GeoTIFF, a window starting at row 100 decompresses rows 0–255 even though you only need rows 100–255. Always align your window offset to `blockxsize` / `blockysize` — the `iter_raster_windows` function above does this via integer alignment math.

### GDAL Driver Availability at Runtime

A missing GDAL driver raises `rasterio.errors.DriverRegistrationError` at the `open()` call, not at install time. Validate driver availability early, before starting the chunk loop:

```python
import rasterio.drivers

def assert_driver(driver_name: str) -> None:
    available = rasterio.drivers.raster_driver_extensions()
    if driver_name.lower() not in available.values():
        raise RuntimeError(
            f"GDAL driver '{driver_name}' not available. "
            f"Rebuild GDAL with {driver_name} support or use a conda-forge wheel."
        )
```

### Memory-Mapped Files and Fork Safety

`rasterio` datasets opened before `multiprocessing.Pool` is spawned are memory-mapped at the C level. The forked worker inherits the file descriptor but not the Python-level reference count — closing the dataset in the parent after forking leaves the worker with a dangling pointer. Always open rasterio datasets inside the worker function, never in the parent.

## Verification

After a processing run, confirm the output is byte-complete and that memory usage returned to near-baseline:

```python
import subprocess
import rasterio
from pathlib import Path

def verify_output(src_path: Path, dst_path: Path) -> None:
    """Assert dst exists, is readable, and has the same spatial extent as src."""
    assert dst_path.exists(), f"Output missing: {dst_path}"

    with rasterio.open(src_path) as src, rasterio.open(dst_path) as dst:
        assert src.crs == dst.crs, "CRS mismatch between input and output"
        assert src.width == dst.width and src.height == dst.height, (
            f"Dimension mismatch: src {src.width}×{src.height}, "
            f"dst {dst.width}×{dst.height}"
        )
    print(f"[OK] Output verified: {dst_path} ({dst_path.stat().st_size // 1_048_576} MiB)")


def check_rss_returned_to_baseline(baseline: dict, tolerance_mb: float = 20.0) -> None:
    """Warn if RSS is more than tolerance_mb above baseline after the run."""
    current = psutil.Process(os.getpid()).memory_info().rss / 1_048_576
    residual = current - baseline["rss_mb"]
    if residual > tolerance_mb:
        print(
            f"[WARN] RSS residual +{residual:.1f} MB after run — possible leak. "
            "Run tracemalloc snapshot comparison to identify source.",
            file=sys.stderr,
        )
```

For structured JSON logging of these verification events, the [Logging Spatial Transformation Results to Structured JSON](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) page covers the full log schema.

## Performance Notes

- **Window size vs I/O calls:** Doubling the window height halves the number of read calls. For network filesystems (S3, NFS) this matters more than on local NVMe. Profile with `GDAL_DEBUG=ON` to count block cache hits.
- **Arrow vs non-Arrow pyogrio:** On geometry-heavy layers (complex polygons) the Arrow path is roughly 30 % faster because GEOS object construction is deferred until you actually call `.geometry`; attribute filtering before geometry access avoids GEOS allocation entirely.
- **Parallelism and memory ceilings:** When running N workers in a `multiprocessing.Pool`, total RSS budget is `N × per_worker_peak`. On a 32 GB host with workers peaking at 3 GB each, cap N at 8 and reserve 8 GB for the OS and GDAL shared libraries. The [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) page covers worker pool sizing in detail.
- **LZW + predictor=2:** Enabling `predictor=2` with LZW compression on float32 rasters typically reduces file size 40–60 % versus plain LZW, at negligible CPU cost. Smaller output files reduce the write-back bottleneck in chunk loops.

## FAQ

<details class="faq-item">
<summary><span>Why does RSS keep growing even after I call <code>del</code> and <code>gc.collect()</code>?</span></summary>

Python frees heap pages back to the OS lazily. More often the culprit is a C-backed library — GDAL, GEOS, or a NumPy buffer — that holds a memory-mapped file descriptor. Ensure rasterio datasets are closed inside their context managers and call `del` on pyogrio DataFrames before `gc.collect()`. If RSS still grows, run `tracemalloc` snapshots before and after the suspect loop: the diff will point to the allocation site.

</details>

<details class="faq-item">
<summary><span>What is a safe <code>GDAL_CACHEMAX</code> value for a container with 4 GB RAM?</span></summary>

Set `GDAL_CACHEMAX` to `512` (MiB) — roughly 12 % of total RAM. GDAL's default of 256 MiB is reasonable for single-file reads but too high when several workers share the same host. Leave headroom for NumPy working arrays: each 10 000 × 10 000 float32 band costs 400 MB, so size the cache against your actual window dimensions.

</details>

<details class="faq-item">
<summary><span>Should I use <code>RLIMIT_AS</code> or <code>RLIMIT_DATA</code> to cap worker memory?</span></summary>

Prefer `RLIMIT_AS` (virtual address space) — it catches GDAL's mmap allocations that `RLIMIT_DATA` misses. Set it 20 % above your measured peak RSS to avoid spurious `ENOMEM` on startup, then tighten after profiling. In containers, pair it with the cgroup `memory.limit_in_bytes` so the OOM killer targets your process specifically rather than a random neighbour.

</details>

<details class="faq-item">
<summary>How does pyogrio Arrow mode reduce memory compared to a normal read?</summary>

When `use_arrow=True`, pyogrio returns a zero-copy Arrow RecordBatch backed by shared memory rather than copying data into pandas object arrays. For string-heavy attribute tables (e.g., parcel IDs, land-use codes) this typically halves peak allocation. Operations that mutate the geometry column will trigger a copy-on-write; keep the chunk immutable until you have filtered it.

</details>

<details class="faq-item">
<summary>At what chunk size does windowed rasterio I/O stop being faster than a full read?</summary>

When the window is smaller than the raster's native tile or block size, GDAL decompresses the full block anyway. Read `src.profile['blockxsize']` and `src.profile['blockysize']` and make your window a multiple of those values. For untiled GeoTIFFs (strip layout, `blockysize=1`), row-band reads in batches of 256–1024 rows outperform pixel-level windows significantly.

</details>

## Related

- [Handling Out-of-Memory Errors in Large Raster Mosaics](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/handling-out-of-memory-errors-in-large-raster-mosaics/) — graceful degradation patterns when a worker exceeds its allocation: retry with smaller windows, structured exit codes, and fallback queues
- [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — pyogrio chunk-size tuning, Arrow schema negotiation, and strategies for spatially partitioned reads
- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — overlap disk reads with CPU-bound transformations using `asyncio` and thread executors to keep workers saturated
- [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) — parent guide covering the full pipeline: async I/O, multiprocessing, error handling, and progress tracking
