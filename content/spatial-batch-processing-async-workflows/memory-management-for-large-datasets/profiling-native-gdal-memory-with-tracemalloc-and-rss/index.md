---
title: "Profiling Native GDAL Memory with tracemalloc and RSS"
description: "Track down native GDAL memory growth by pairing Python's tracemalloc with process RSS sampling to separate NumPy allocations from C-level GDAL buffers."
slug: "profiling-native-gdal-memory-with-tracemalloc-and-rss"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Memory Management for Large GIS Datasets"
    url: "/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/"
  - label: "Profiling Native GDAL Memory with tracemalloc and RSS"
    url: "/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/profiling-native-gdal-memory-with-tracemalloc-and-rss/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Profiling Native GDAL Memory with tracemalloc and RSS

`tracemalloc` reports low usage while your process keeps swelling because it only tracks allocations routed through Python's allocator. GDAL allocates its block cache and dataset buffers directly in C with `malloc`, so those bytes are invisible to `tracemalloc` and show up only as growth in the process resident set size (RSS). Profiling native GDAL memory means running both meters at once. For the broader context, see the [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) guide within the wider [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install rasterio psutil` (rasterio 1.3+ bundles GDAL 3.4+)
- A directory of GeoTIFFs to read; the harness below reads them in a loop
- `tracemalloc` is in the standard library, no install needed

If you have not yet decided whether to stream windows or load whole rasters, read the [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) overview first — it frames when native memory becomes the bottleneck rather than Python objects.

## Two Meters, Two Kinds of Memory

The core confusion is that a single number cannot describe a hybrid Python/C program. `tracemalloc` sees the NumPy arrays rasterio hands back, because their buffers are allocated through the Python C-API. It does not see the GDAL block cache, VSI buffers, or the internal scanline buffers a driver keeps open while a dataset is live. Those live in the C heap and surface only in RSS. When the two meters diverge, the gap *is* your native GDAL footprint.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram showing tracemalloc measures only Python-allocated NumPy arrays while process RSS measures both Python objects and native GDAL C buffers such as the block cache and dataset handles" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>What each memory meter can see</title>
  <desc>The process memory column is split into a Python allocator region and a native C heap region. A tracemalloc bracket covers only the Python region. An RSS bracket covers the whole column, so the difference between the two brackets equals the native GDAL memory.</desc>
  <!-- Process memory column -->
  <rect x="250" y="40" width="220" height="260" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="360" y="28" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Process memory</text>
  <!-- Python region -->
  <rect x="262" y="52" width="196" height="86" rx="5" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="360" y="86" text-anchor="middle" font-size="11" fill="currentColor">Python allocator</text>
  <text x="360" y="104" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">NumPy arrays from</text>
  <text x="360" y="118" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">rasterio read()</text>
  <!-- Native region -->
  <rect x="262" y="150" width="196" height="138" rx="5" fill="#a78bfa" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="360" y="182" text-anchor="middle" font-size="11" fill="currentColor">Native C heap (GDAL)</text>
  <text x="360" y="204" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">GDAL_CACHEMAX block cache</text>
  <text x="360" y="222" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">open dataset buffers</text>
  <text x="360" y="240" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">VSI / scanline buffers</text>
  <text x="360" y="270" text-anchor="middle" font-size="10" fill="#c0392b" opacity="0.85">invisible to tracemalloc</text>
  <!-- tracemalloc bracket (left) -->
  <line x1="222" y1="52" x2="222" y2="138" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.5"/>
  <line x1="222" y1="52" x2="234" y2="52" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.5"/>
  <line x1="222" y1="138" x2="234" y2="138" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.5"/>
  <text x="150" y="92" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">tracemalloc</text>
  <text x="150" y="108" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">sees this only</text>
  <!-- RSS bracket (right) -->
  <line x1="498" y1="52" x2="498" y2="288" stroke="#15803d" stroke-opacity="0.75" stroke-width="1.5"/>
  <line x1="486" y1="52" x2="498" y2="52" stroke="#15803d" stroke-opacity="0.75" stroke-width="1.5"/>
  <line x1="486" y1="288" x2="498" y2="288" stroke="#15803d" stroke-opacity="0.75" stroke-width="1.5"/>
  <text x="588" y="164" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">RSS</text>
  <text x="588" y="180" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">sees everything</text>
  <!-- Gap annotation -->
  <text x="360" y="322" text-anchor="middle" font-size="11" fill="#15803d" opacity="0.9">RSS minus tracemalloc = native GDAL footprint</text>
</svg>

## Complete Working Implementation

The harness below reads every GeoTIFF in a directory, and after each file it prints the `tracemalloc` current total alongside the process RSS. Both numbers start from a recorded baseline so you read *deltas*, not absolute figures. Run it once with the leaky loop (`--leak`) to see RSS climb, then without it to confirm the fix:

```python
#!/usr/bin/env python3
"""
Profile native GDAL memory by sampling tracemalloc and RSS around a
rasterio read loop.

Usage:
  python profile_gdal_memory.py ./rasters              # correct: with-block + capped cache
  python profile_gdal_memory.py ./rasters --leak       # leaky: datasets never closed
"""
import argparse
import tracemalloc
from pathlib import Path

import psutil
import rasterio

MB = 1024 * 1024

def rss_mb() -> float:
    """Resident set size of THIS process in megabytes."""
    return psutil.Process().memory_info().rss / MB

def traced_mb() -> float:
    """Current bytes tracked by tracemalloc (Python allocations only)."""
    current, _peak = tracemalloc.get_traced_memory()
    return current / MB

def read_correct(path: Path) -> int:
    """Open inside a with-block so GDAL closes the dataset on exit."""
    with rasterio.open(path) as ds:
        band = ds.read(1)          # NumPy array -> visible to tracemalloc
        return int(band.shape[0] * band.shape[1])

def read_leaky(path: Path, held: list) -> int:
    """Open without closing; the dataset (and its C buffers) stays alive."""
    ds = rasterio.open(path)       # no with-block, no ds.close()
    band = ds.read(1)
    held.append(ds)                # keep a reference so nothing is collected
    return int(band.shape[0] * band.shape[1])

def main() -> None:
    parser = argparse.ArgumentParser(description="Profile GDAL native memory")
    parser.add_argument("raster_dir", type=Path, help="Directory of GeoTIFFs")
    parser.add_argument("--leak", action="store_true",
                        help="Never close datasets (reproduce the leak)")
    parser.add_argument("--cachemax", type=int, default=64,
                        help="GDAL_CACHEMAX in MB (default: 64)")
    args = parser.parse_args()

    paths = sorted(args.raster_dir.glob("*.tif"))
    if not paths:
        raise SystemExit(f"No .tif files found in {args.raster_dir}")

    tracemalloc.start()
    base_rss = rss_mb()
    base_traced = traced_mb()
    print(f"baseline           rss={base_rss:8.1f}MB  traced={base_traced:6.2f}MB")

    held: list = []
    # rasterio.Env applies GDAL config for the whole block below.
    with rasterio.Env(GDAL_CACHEMAX=args.cachemax * MB):
        for i, path in enumerate(paths, 1):
            if args.leak:
                read_leaky(path, held)
            else:
                read_correct(path)

            d_rss = rss_mb() - base_rss
            d_traced = traced_mb() - base_traced
            print(f"[{i:>3}] {path.name:<24} "
                  f"drss={d_rss:+7.1f}MB  dtraced={d_traced:+6.2f}MB")

    tracemalloc.stop()
    print(f"final              rss={rss_mb():8.1f}MB  "
          f"(baseline {base_rss:.1f}MB)")

if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`rss_mb()` reads `psutil.Process().memory_info().rss`** — RSS is the amount of physical RAM the kernel currently attributes to the process. Unlike `tracemalloc`, it counts every byte GDAL mallocs in C. Dividing by `1024 * 1024` reports megabytes so the deltas are readable.

2. **`traced_mb()` uses `tracemalloc.get_traced_memory()`** — This returns `(current, peak)` in bytes for Python-allocated objects. The NumPy array from `ds.read(1)` is counted here; the GDAL block cache behind it is not. That asymmetry is the whole point of running both meters.

3. **Recording `base_rss` and `base_traced` before the loop** — Absolute memory figures are noisy because the interpreter and imported modules already occupy tens of megabytes. Subtracting the baseline turns every printed line into a clean per-iteration delta you can trend.

4. **`read_correct()` uses a `with rasterio.open(...)` block** — Exiting the block calls the dataset's `close()`, which hands the file handle and per-dataset buffers back to GDAL. Without this, those buffers accumulate in the C heap and show up only as RSS growth. This is the same explicit-close discipline that keeps [multiprocessing geospatial tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) from leaking descriptors across pool workers.

5. **`read_leaky()` appends the open dataset to `held`** — Keeping a live reference prevents both Python garbage collection and GDAL close. Each iteration adds another set of native buffers, so RSS rises linearly while `tracemalloc` barely moves, because the NumPy arrays returned by `read()` are small compared to the retained dataset state.

6. **`with rasterio.Env(GDAL_CACHEMAX=args.cachemax * MB)`** — `rasterio.Env` sets GDAL configuration for the enclosed block. `GDAL_CACHEMAX` caps the shared block cache; passing an explicit byte value avoids the default of five percent of system RAM, which on a 64 GB host is a 3.2 GB ceiling per process. When reading window-by-window instead, pair this with [streaming raster windows to cap memory in mosaics](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/streaming-raster-windows-to-cap-memory-in-mosaics/).

## Named Gotcha: Leaving Datasets Open in a Loop

The single most common way to make RSS grow while `tracemalloc` stays flat is to open datasets in a loop without closing them — exactly what `--leak` reproduces. Because rasterio returns a NumPy array immediately, it is easy to assume the dataset is done with once you have the array. It is not: the `DatasetReader` object stays alive, and with it GDAL's per-dataset buffers and any blocks pulled into the cache. `tracemalloc` shows almost nothing because the retained bytes are native, so a Python-only profiler tells you there is no leak while the OOM killer disagrees.

The fix is two-part. First, always scope reads with `with rasterio.open(path) as ds:` (or call `ds.close()` / assign the reference to `None`) so the dataset releases its buffers as soon as you have the array. Second, bound the shared block cache with `rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024)` so even legitimately cached blocks cannot grow without limit. Under multiprocessing the cache is per process, so multiply the cap by the worker count to get the true memory ceiling.

## Verification

Run the leaky variant, then the correct one, over the same directory and compare the final RSS lines. The leak grows RSS per file; the fix keeps it flat near baseline:

```bash
# Leaky run: RSS climbs with every file, tracemalloc stays near zero
python profile_gdal_memory.py ./rasters --leak | tail -n 5

# Correct run: RSS plateaus close to the baseline
python profile_gdal_memory.py ./rasters | tail -n 5
```

A healthy fix shows `drss` oscillating around a small constant (allocator noise) rather than rising monotonically, and the `final` RSS lands within a few megabytes of the printed baseline. If RSS still creeps upward after adding the `with` block, lower `--cachemax` and confirm no other code path holds dataset references outside the loop.

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| RSS grows, `tracemalloc` flat | Datasets left open; native buffers retained | `with rasterio.open(...)` or `ds.close()` |
| RSS high but stable across files | Block cache filled to its ceiling | Lower `GDAL_CACHEMAX` in `rasterio.Env` |
| RSS never returns to baseline | C allocator holding freed pages | Expected; check the trend, not the absolute |
| Memory ceiling scales with workers | `GDAL_CACHEMAX` is per process | Multiply cap by worker count for the real budget |

## FAQ

<details class="faq-item">
<summary>Why does tracemalloc show low memory but my process RSS keeps growing?</summary>

`tracemalloc` only instruments allocations made through Python's memory allocator. GDAL allocates its block cache and dataset buffers with `malloc` in C, so those bytes never appear in a `tracemalloc` snapshot. They are visible only in the operating system's resident set size, which is why RSS climbs while `tracemalloc` stays flat.
</details>

<details class="faq-item">
<summary>Does closing a rasterio dataset actually free native memory?</summary>

Closing a dataset releases the file handle and the per-dataset buffers back to GDAL, but blocks already loaded into the shared GDAL block cache stay resident until the cache evicts them or you lower `GDAL_CACHEMAX`. Closing datasets stops per-iteration growth; capping the cache bounds the steady-state ceiling.
</details>

<details class="faq-item">
<summary>What value should I set for GDAL_CACHEMAX?</summary>

Set `GDAL_CACHEMAX` to an explicit byte or megabyte budget rather than leaving the default of five percent of RAM. A value like 64 or 128 megabytes per process is a safe start for batch workers. Under multiprocessing, remember the cache is per process, so multiply the cap by the worker count to get the real ceiling.
</details>

<details class="faq-item">
<summary>Can I trust RSS as an exact leak measurement?</summary>

RSS is a coarse meter because the C allocator may hold freed pages instead of returning them to the kernel, so a small residual is normal. What matters is the trend: flat RSS across iterations means no leak, while linear growth per iteration signals unclosed datasets or an unbounded cache.
</details>

---

## Related

- [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) — parent guide covering cache tuning, streaming, and out-of-memory recovery for large raster and vector workloads
- [Streaming Raster Windows to Cap Memory in Mosaics](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/streaming-raster-windows-to-cap-memory-in-mosaics/) — bound per-read memory by processing windows instead of whole rasters
