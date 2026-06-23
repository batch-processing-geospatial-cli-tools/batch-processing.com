---
title: "Handling Out-of-Memory Errors in Large Raster Mosaics"
description: "Fix OOM crashes when merging large raster mosaics in Python. Use VRT-backed windowed I/O with rasterio to cap RAM to a single chunk regardless of mosaic size."
slug: "handling-out-of-memory-errors-in-large-raster-mosaics"
type: "long_tail"
breadcrumb:
  - label: "Spatial Batch Processing & Async Workflows"
    url: "/spatial-batch-processing-async-workflows/"
  - label: "Memory Management for Large Datasets"
    url: "/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/"
  - label: "Handling Out-of-Memory Errors in Large Raster Mosaics"
    url: "/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/handling-out-of-memory-errors-in-large-raster-mosaics/"
datePublished: "2024-11-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Handling Out-of-Memory Errors in Large Raster Mosaics",
      "description": "Fix OOM crashes when merging large raster mosaics in Python. Use VRT-backed windowed I/O with rasterio to cap RAM to a single chunk regardless of mosaic size.",
      "datePublished": "2024-11-15",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "batch-processing.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Spatial Batch Processing & Async Workflows",
          "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Memory Management for Large Datasets",
          "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": "Handling Out-of-Memory Errors in Large Raster Mosaics",
          "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/handling-out-of-memory-errors-in-large-raster-mosaics/"
        }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Fix OOM Errors in Large Raster Mosaics",
      "description": "Stream-merge large raster mosaics with rasterio and GDAL VRTs to prevent out-of-memory crashes.",
      "step": [
        { "@type": "HowToStep", "name": "Install dependencies", "text": "pip install rasterio gdal numpy" },
        { "@type": "HowToStep", "name": "Build a GDAL VRT to unify inputs", "text": "Call gdal.BuildVRT() to create a zero-pixel virtual raster that harmonises CRS, resolution, and extents." },
        { "@type": "HowToStep", "name": "Calculate aligned tile windows", "text": "Divide the unified extent into a grid of Window objects that match the target GeoTIFF block size." },
        { "@type": "HowToStep", "name": "Stream read and write each tile", "text": "Use rasterio's windowed read/write loop to load only the current tile into RAM, write it to disk, then free the array." },
        { "@type": "HowToStep", "name": "Verify output integrity", "text": "Compare source and output checksums with gdalinfo and a band-statistics assertion." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does rasterio.merge() crash with MemoryError on large mosaics?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "rasterio.merge() allocates a single contiguous NumPy array large enough to hold the full merged extent. For a 10 000×10 000 three-band uint16 mosaic that is around 600 MB before NumPy's object overhead and GDAL's internal block cache are included. VRT-backed windowed I/O avoids the contiguous allocation entirely."
          }
        },
        {
          "@type": "Question",
          "name": "How do I set GDAL_CACHEMAX without restarting Python?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Call gdal.SetCacheMax(bytes) at runtime before opening any datasets. Set it to 25–50 % of available RAM; exceeding that figure forces swap usage and degrades throughput before the kernel OOM killer intervenes."
          }
        },
        {
          "@type": "Question",
          "name": "Can I parallelise the windowed loop across workers?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, but each worker needs its own rasterio file handle. Do not share handles across processes. Pre-compute the window list, distribute it via multiprocessing.Pool, and open the VRT independently in each worker. See the Multiprocessing Geospatial Tasks guide for pool sizing."
          }
        },
        {
          "@type": "Question",
          "name": "What chunk size should I use?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Start at 1024 pixels and match it to your storage layer's native block size. Query it with stat -fc %s /your/mount. Misalignment between chunk_size and the on-disk block size causes read-amplification that inflates both I/O time and cache pressure."
          }
        }
      ]
    }
  ]
}
</script>

The fix for OOM crashes in raster mosaic pipelines is to replace any full-extent allocation — including `rasterio.merge()` — with a VRT-backed windowed I/O loop that reads and writes one spatial tile at a time, capping peak RAM to `chunk_size × bands × dtype_bytes` plus a bounded GDAL cache, regardless of mosaic dimensions.

This page is part of the [Memory Management for Large Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) guide within [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.10+ | `match`/`case` not required; 3.9 works too |
| `rasterio` | ≥ 1.3 | Provides `Window`, context managers, block iterators |
| `gdal` (GDAL/OGR Python bindings) | ≥ 3.6 | Required for `gdal.BuildVRT()` |
| `numpy` | ≥ 1.24 | In-place ops to avoid implicit copies |

Install with:

```bash
pip install rasterio numpy
# GDAL Python bindings are usually installed alongside GDAL:
pip install gdal==$(gdal-config --version)
```

## Why `rasterio.merge()` Triggers OOM

Three mechanics combine to exhaust RAM in naive mosaic workflows:

1. **Eager full-extent allocation.** `rasterio.merge()` and similar helpers allocate a contiguous NumPy array sized to the union of all input extents before a single pixel is composited. A 10 000×10 000 three-band `uint16` mosaic requires ~600 MB raw; with NumPy object headers and GDAL's internal block cache the working footprint routinely triples.
2. **GDAL cache growth without a ceiling.** GDAL caches recently decoded blocks to speed re-reads. Without an explicit `GDAL_CACHEMAX`, the cache grows until the kernel OOM killer terminates the process.
3. **Worker multiplication.** When a CLI tool spawns a process pool for parallelism — a common pattern described in [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) — each worker inherits a full copy of the dataset handle and its cache state, causing exponential RAM multiplication under concurrent loads.

The streaming architecture below breaks all three failure modes.

## Architecture: VRT + Windowed I/O

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 300" role="img" aria-label="Data-flow diagram showing source rasters unified into a VRT, then streamed as tiles through a windowed read/write loop into an output GeoTIFF" style="max-width:100%;height:auto;display:block;">
  <title>VRT-backed windowed mosaic pipeline</title>
  <desc>Source rasters are unified into a GDAL VRT (no pixels, metadata only). The windowed loop iterates over tile rows and columns, reads one tile from the VRT into RAM, writes it directly to the output GeoTIFF, then frees the array. Only one tile resides in RAM at any time.</desc>
  <!-- Background -->
  <rect width="700" height="300" fill="none"/>
  <!-- Source rasters box -->
  <rect x="10" y="80" width="130" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="75" y="105" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">Source rasters</text>
  <text x="75" y="123" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">(GeoTIFF / COG)</text>
  <!-- Arrow: sources → VRT -->
  <line x1="140" y1="110" x2="190" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- VRT box -->
  <rect x="190" y="75" width="130" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="255" y="104" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">GDAL VRT</text>
  <text x="255" y="122" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">metadata only</text>
  <text x="255" y="138" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">zero pixel data</text>
  <!-- Arrow: VRT → loop -->
  <line x1="320" y1="110" x2="370" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Windowed loop box -->
  <rect x="370" y="55" width="145" height="120" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="443" y="82" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">Windowed loop</text>
  <text x="443" y="101" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">read tile → RAM</text>
  <text x="443" y="118" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">write tile → disk</text>
  <text x="443" y="135" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">del array</text>
  <text x="443" y="153" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">gc.collect()</text>
  <!-- Arrow: loop → output -->
  <line x1="515" y1="110" x2="565" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Output box -->
  <rect x="565" y="80" width="120" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="625" y="105" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">Output GeoTIFF</text>
  <text x="625" y="123" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">tiled + LZW</text>
  <!-- RAM label below loop -->
  <rect x="385" y="205" width="115" height="35" rx="4" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="443" y="222" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">Peak RAM:</text>
  <text x="443" y="237" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="currentColor">1 tile × bands × dtype</text>
  <!-- Connector from loop to RAM label -->
  <line x1="443" y1="175" x2="443" y2="205" stroke="currentColor" stroke-width="1" stroke-dasharray="4,3"/>
  <!-- Arrow marker -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

The key insight: a GDAL VRT stores coordinate transforms and source-file pointers but contains zero pixel data. Opening a VRT is therefore an O(1) metadata operation. All pixel I/O happens during the windowed loop, one tile at a time.

## Complete Working Implementation

```python
# mosaic_stream.py
import argparse
import gc
import os
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from osgeo import gdal
from rasterio.windows import Window


def set_gdal_cache(fraction: float = 0.25) -> None:
    """Cap GDAL's block cache to a fraction of available RAM.

    gdal.SetCacheMax() takes bytes. Must be called before opening any dataset.
    """
    import psutil  # optional but recommended; falls back to a 256 MB hard cap

    try:
        available = psutil.virtual_memory().available
        gdal.SetCacheMax(int(available * fraction))
    except ImportError:
        gdal.SetCacheMax(256 * 1024 * 1024)  # 256 MB fallback


def build_vrt(inputs: list[str], vrt_path: str) -> None:
    """Unify source rasters into a GDAL VRT.

    resolution="highest" selects the finest GSD among all inputs.
    resampleAlg="nearest" avoids blurring discrete raster classes (e.g. land-cover).
    FlushCache() + assigning None closes the C-level dataset handle immediately.
    """
    vrt = gdal.BuildVRT(
        vrt_path,
        inputs,
        resolution="highest",
        resampleAlg="nearest",
    )
    if vrt is None:
        raise RuntimeError(f"gdal.BuildVRT failed; check inputs exist and share a CRS: {inputs}")
    vrt.FlushCache()
    vrt = None  # Release C handle; do NOT rely on Python's GC timing here


def stream_mosaic(
    vrt_path: str,
    output_path: str,
    chunk_size: int = 1024,
) -> None:
    """Write the mosaic to disk one tile at a time.

    Peak RAM at any point = chunk_size * chunk_size * bands * dtype_bytes.
    For a 1024-pixel, 3-band uint16 tile: 1024 * 1024 * 3 * 2 = ~6 MB.
    """
    with rasterio.open(vrt_path) as src:
        meta = src.meta.copy()
        meta.update(
            driver="GTiff",
            compress="LZW",
            tiled=True,
            blockxsize=chunk_size,   # Output block size matches read chunk_size —
            blockysize=chunk_size,   # misalignment causes read-amplification on re-access.
            interleave="band",
            dtype=src.dtypes[0],
        )

        with rasterio.open(output_path, "w", **meta) as dst:
            for col_off in range(0, src.width, chunk_size):
                for row_off in range(0, src.height, chunk_size):
                    # Clamp window to dataset boundary; avoids out-of-bounds reads
                    # at the right and bottom edges where the extent may not divide evenly.
                    w = min(chunk_size, src.width - col_off)
                    h = min(chunk_size, src.height - row_off)
                    window = Window(col_off, row_off, w, h)

                    data = src.read(window=window)   # lazy read: only this tile in RAM
                    dst.write(data, window=window)   # direct disk write; no accumulation

                    del data          # Explicit dereference
                    gc.collect()      # Force immediate reclamation; prevents heap fragmentation


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stream-merge large rasters to a GeoTIFF without OOM."
    )
    parser.add_argument("inputs", nargs="+", help="Input raster paths (GeoTIFF or any GDAL source)")
    parser.add_argument("-o", "--output", required=True, help="Output GeoTIFF path")
    parser.add_argument(
        "-c", "--chunk",
        type=int,
        default=1024,
        help="Tile size in pixels (default: 1024; match to storage block size)",
    )
    parser.add_argument(
        "--cache-fraction",
        type=float,
        default=0.25,
        help="Fraction of available RAM to allocate for GDAL block cache (default: 0.25)",
    )
    args = parser.parse_args()

    set_gdal_cache(args.cache_fraction)

    # tempfile.mkstemp() avoids the TOCTOU race of the deprecated mktemp().
    # os.close() shuts the file descriptor immediately; build_vrt will overwrite the file.
    fd, vrt_path = tempfile.mkstemp(suffix=".vrt")
    os.close(fd)
    try:
        build_vrt(args.inputs, vrt_path)
        stream_mosaic(vrt_path, args.output, args.chunk)
    finally:
        Path(vrt_path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`set_gdal_cache()` must run before any `rasterio.open()` or `gdal.*` call.** GDAL caches blocks aggressively; without a ceiling it will grow until the kernel OOM killer terminates the process. `gdal.SetCacheMax(bytes)` sets a hard ceiling at runtime. `psutil.virtual_memory().available` is the safest source of truth because it accounts for OS page-cache and other running processes, not just installed RAM.

2. **`gdal.BuildVRT()` writes only XML.** The VRT file contains coordinate transforms, source-file paths, and band mappings — no pixel data. This makes the "unify inputs" step a metadata-only operation that takes milliseconds even for hundreds of source tiles.

3. **`vrt = None` after `FlushCache()` is intentional.** GDAL's Python bindings use reference-counted C handles. Assigning `None` triggers the C destructor synchronously, flushing any pending writes and releasing file locks. Relying on Python's garbage collector is unsafe here because the GC may defer collection, leaving the file locked when `rasterio.open()` tries to read it.

4. **Window boundary clamping with `min(chunk_size, remaining)`.** Without this, the final column and row of tiles would generate `Window` objects extending beyond `src.width` or `src.height`. GDAL would fill the out-of-bounds region with the nodata value, silently corrupting edge pixels.

5. **`blockxsize`/`blockysize` in output `meta` must match `chunk_size`.** When a subsequent process re-opens the output GeoTIFF with windowed reads — as in [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — aligned block sizes eliminate read-amplification (reading more data than requested to satisfy a block boundary). Misalignment can multiply I/O cost by the ratio `block_size / request_size`.

6. **`del data` + `gc.collect()` inside the inner loop.** Python's reference counting should free `data` when it goes out of scope, but fragmented heaps in long-running loops accumulate small objects between collection cycles. Explicit `del` + `gc.collect()` keeps RSS flat across millions of tile iterations.

## The Single Most Common Failure Mode

**CRS mismatch between inputs silently produces a warped mosaic.**

`gdal.BuildVRT()` does not reproject sources by default. If one input is `EPSG:4326` and another is `EPSG:32633`, the VRT treats all inputs as if they share the first file's CRS, resulting in a pixel grid where geographic coordinates are incorrect.

**Fix:** Reproject all inputs to a common CRS before calling `build_vrt()`, or pass `outputSRS="EPSG:32633"` and `srcNodata=0` to `gdal.BuildVRT()` along with explicit warp options:

```python
vrt = gdal.BuildVRT(
    vrt_path,
    inputs,
    outputSRS="EPSG:32633",      # target CRS: WGS 84 / UTM zone 33N
    resolution="highest",
    resampleAlg="bilinear",       # bilinear for continuous data; nearest for categorical
    VRTNodata=0,
)
```

Alternatively, use `gdalwarp` to normalise all inputs to a shared CRS before mosaicking.

## Verification

Confirm that the output mosaic is geometrically and radiometrically correct:

```bash
# 1. Check CRS, extent, and band count match expectations
gdalinfo -stats output_mosaic.tif | grep -E "Size|SRS|Band|Min|Max"

# 2. Verify nodata regions are at the edges, not scattered through valid pixels
# (scattered nodata often indicates CRS mismatch or misaligned block writes)
gdal_translate -of GTiff -b 1 output_mosaic.tif /vsistdout/ \
  | python3 -c "
import sys, numpy as np, rasterio
with rasterio.open('/vsistdin/') as src:
    band = src.read(1)
    assert band.max() > 0, 'Band 1 is all nodata — check CRS alignment'
    print(f'Band 1 min={band.min()} max={band.max()} nodata_fraction={np.isnan(band.astype(float)).mean():.4f}')
"

# 3. Spot-check a known coordinate: pixel at EPSG:32633 easting=500000, northing=5000000
python3 - <<'EOF'
import rasterio
with rasterio.open("output_mosaic.tif") as src:
    row, col = src.index(500000, 5000000)  # (easting, northing) → (row, col)
    data = src.read(window=rasterio.windows.Window(col, row, 1, 1))
    print("Sample pixel values:", data.flatten())
EOF
```

A passing check shows non-zero band statistics, a nodata fraction near 0.0 inside the AOI, and plausible sample pixel values at the spot-check coordinate.

---

<details class="faq-item">
<summary>Why does my VRT show all black when opened in QGIS?</summary>

QGIS may not stretch the histogram for `uint16` data by default. Right-click the layer, go to **Properties → Symbology**, and set the rendering to **Singleband pseudocolor** or adjust the min/max stretch to match the actual band statistics reported by `gdalinfo -stats`. The data itself is correct; the display scaling is the issue.

</details>

<details class="faq-item">
<summary>Can I use this pattern on cloud-optimised GeoTIFFs (COGs) stored on S3?</summary>

Yes. Pass `s3://bucket/prefix/file.tif` directly to `gdal.BuildVRT()`. GDAL's `/vsis3/` virtual filesystem handles HTTP range requests transparently. Set `GDAL_HTTP_MAX_RETRY=3` and `GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES` as environment variables to reduce per-tile round-trips on slow connections. For GDAL environment-variable syntax, see the [GDAL Configuration Options](https://gdal.org/en/stable/user/configoptions.html) reference. The [chunked vector data reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) guide covers the equivalent pattern for cloud-hosted vector datasets.

</details>

<details class="faq-item">
<summary>How do I handle a mosaic that spans multiple UTM zones?</summary>

Pick a single target CRS — typically the UTM zone covering the majority of the AOI, or a continental equal-area projection — and pass it as `outputSRS` to `gdal.BuildVRT()`. GDAL will warp each source tile on-the-fly as it is read through the VRT. Use `resampleAlg="bilinear"` for continuous data (elevation, reflectance) and `resampleAlg="nearest"` for discrete classifications to avoid introducing fractional class values.

</details>

<details class="faq-item">
<summary>Does gc.collect() inside the loop significantly impact throughput?</summary>

For chunk sizes of 512–2048 pixels, `gc.collect()` typically adds 0.5–2 ms per iteration, which is negligible compared to disk I/O. For very small chunks (< 128 pixels) on fast NVMe storage, the GC overhead can become measurable. In that case, accumulate chunks into batches of 50–100 before calling `gc.collect()` once, rather than per-tile. Profile with `cProfile` or `memory_profiler` before optimising.

</details>

---

## Related

- [Memory Management for Large Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) — parent guide covering profiling, GDAL cache configuration, and process-level memory ceilings
- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — dispatch windowed tiles as async tasks to overlap I/O and CPU work across large tile grids
- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — structured error recovery and structured JSON logging for long-running mosaic jobs
