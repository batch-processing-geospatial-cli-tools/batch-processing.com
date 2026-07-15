---
title: "Streaming Raster Windows to Cap Memory in Mosaics"
description: "Process a large raster mosaic block by block with rasterio windowed reads so peak memory stays constant no matter how many tiles the mosaic contains."
slug: "streaming-raster-windows-to-cap-memory-in-mosaics"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Memory Management for Large GIS Datasets"
    url: "/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/"
  - label: "Streaming Raster Windows to Cap Memory in Mosaics"
    url: "/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/streaming-raster-windows-to-cap-memory-in-mosaics/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Streaming Raster Windows to Cap Memory in Mosaics

Process a huge raster mosaic without loading it all by iterating its native blocks: open the source with rasterio, walk `src.block_windows(1)` so each `Window` lands on a block boundary, transform that block, and write it straight into the matching window of an output dataset opened in `"w"` mode. Only one block is ever resident, so peak memory is a fixed function of block size, not mosaic size. For the wider context, see the [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) guide within the broader [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install rasterio numpy` (rasterio 1.3+ ships GDAL 3.4+ wheels; no separate GDAL system install needed on Linux/macOS)
- A tiled GeoTIFF mosaic. If your source is stripped rather than tiled, retile it once with `gdal_translate -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512 in.tif tiled.tif` so block-aligned reads are cheap.

If your run is already crashing with a `MemoryError` or an OOM kill rather than just running slowly, start with [Handling Out-of-Memory Errors in Large Raster Mosaics](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/handling-out-of-memory-errors-in-large-raster-mosaics/); this page assumes you want to design the streaming write from the start.

## Why Block Alignment Decides Memory and I/O

A tiled GeoTIFF stores pixels in fixed internal tiles, typically 256x256 or 512x512. GDAL always decompresses a whole tile even if you ask for a single pixel inside it. Streaming works by making your read windows agree with those tile boundaries: read one tile, transform it, write it, discard it. The diagram below contrasts a block-aligned stream against a naive full read and against a misaligned window that forces redundant decompression.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three strategies for processing a tiled mosaic: full read holds the whole raster in memory, block-aligned streaming holds one tile, and a misaligned window forces GDAL to decode four tiles for one read" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Full read versus block-aligned streaming versus misaligned windows</title>
  <desc>Left panel shows a full read loading an entire tiled mosaic into memory. Middle panel shows block-aligned streaming holding a single tile in a constant-size buffer. Right panel shows a misaligned window overlapping four tiles, all of which GDAL must decode.</desc>
  <defs>
    <marker id="wf" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Panel 1: full read -->
  <text x="120" y="30" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Full read</text>
  <g stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.1" fill="#c0392b" fill-opacity="0.08">
    <rect x="40" y="46" width="40" height="40"/><rect x="80" y="46" width="40" height="40"/><rect x="120" y="46" width="40" height="40"/><rect x="160" y="46" width="40" height="40"/>
    <rect x="40" y="86" width="40" height="40"/><rect x="80" y="86" width="40" height="40"/><rect x="120" y="86" width="40" height="40"/><rect x="160" y="86" width="40" height="40"/>
    <rect x="40" y="126" width="40" height="40"/><rect x="80" y="126" width="40" height="40"/><rect x="120" y="126" width="40" height="40"/><rect x="160" y="126" width="40" height="40"/>
  </g>
  <text x="120" y="196" text-anchor="middle" font-size="10.5" fill="#c0392b">all tiles resident</text>
  <text x="120" y="212" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">peak RSS grows with mosaic</text>
  <!-- Panel 2: block-aligned streaming -->
  <text x="360" y="30" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Block-aligned stream</text>
  <g stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1" fill="none">
    <rect x="280" y="46" width="40" height="40"/><rect x="320" y="46" width="40" height="40"/><rect x="360" y="46" width="40" height="40"/><rect x="400" y="46" width="40" height="40"/>
    <rect x="280" y="86" width="40" height="40"/><rect x="360" y="86" width="40" height="40"/><rect x="400" y="86" width="40" height="40"/>
    <rect x="280" y="126" width="40" height="40"/><rect x="320" y="126" width="40" height="40"/><rect x="360" y="126" width="40" height="40"/><rect x="400" y="126" width="40" height="40"/>
  </g>
  <rect x="320" y="86" width="40" height="40" stroke="#15803d" stroke-opacity="0.85" stroke-width="1.8" fill="#15803d" fill-opacity="0.12"/>
  <text x="340" y="110" text-anchor="middle" font-size="10" fill="#15803d">1 tile</text>
  <text x="360" y="196" text-anchor="middle" font-size="10.5" fill="#15803d">one block resident</text>
  <text x="360" y="212" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">peak RSS is constant</text>
  <!-- Panel 3: misaligned window -->
  <text x="600" y="30" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Misaligned window</text>
  <g stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1" fill="none">
    <rect x="520" y="46" width="40" height="40"/><rect x="560" y="46" width="40" height="40"/><rect x="600" y="46" width="40" height="40"/><rect x="640" y="46" width="40" height="40"/>
    <rect x="520" y="86" width="40" height="40"/><rect x="560" y="86" width="40" height="40"/><rect x="600" y="86" width="40" height="40"/><rect x="640" y="86" width="40" height="40"/>
    <rect x="520" y="126" width="40" height="40"/><rect x="560" y="126" width="40" height="40"/><rect x="600" y="126" width="40" height="40"/><rect x="640" y="126" width="40" height="40"/>
  </g>
  <g fill="#a78bfa" fill-opacity="0.12" stroke="none">
    <rect x="540" y="66" width="40" height="40"/><rect x="580" y="66" width="40" height="40"/>
    <rect x="540" y="106" width="40" height="40"/><rect x="580" y="106" width="40" height="40"/>
  </g>
  <rect x="540" y="66" width="80" height="80" stroke="#c0392b" stroke-opacity="0.85" stroke-width="1.8" fill="none"/>
  <text x="580" y="196" text-anchor="middle" font-size="10.5" fill="#c0392b">4 tiles decoded</text>
  <text x="580" y="212" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">wasted decompression I/O</text>
  <!-- one block flows read -> transform -> write through a reused buffer -->
  <rect x="270" y="224" width="180" height="28" rx="4" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.2"/>
  <text x="300" y="242" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">read</text>
  <text x="360" y="242" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">transform</text>
  <text x="420" y="242" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">write</text>
  <line x1="300" y1="252" x2="300" y2="286" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#wf)"/>
  <line x1="360" y1="252" x2="360" y2="286" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#wf)"/>
  <line x1="420" y1="252" x2="420" y2="286" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#wf)"/>
  <rect x="240" y="286" width="240" height="26" rx="4" fill="#15803d" fill-opacity="0.1" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="360" y="303" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">reused buffer — memory stays flat</text>
</svg>

## Complete Working Implementation

The script below applies a per-pixel NDVI to a multi-band mosaic, streaming one super-block at a time. The super-block is chosen as an integer multiple of the native block shape so reads stay aligned while the Python loop runs fewer, larger iterations. Copy it, adjust the band indices, and run directly:

```python
#!/usr/bin/env python3
"""
Stream a large raster mosaic block by block to cap peak memory.
Usage: python stream_ndvi.py mosaic.tif ndvi.tif --red 3 --nir 4 --factor 4
"""
import sys
import argparse
import resource
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

def super_block_windows(src: rasterio.DatasetReader, factor: int):
    """Yield block-aligned windows that each cover `factor` x `factor`
    native blocks, clipped to the raster edge.

    Grouping native blocks into a super-block amortises Python-level loop
    overhead while keeping every read aligned to GDAL's internal tiling.
    """
    bh, bw = src.block_shapes[0]        # native block height, width (band 1)
    step_h, step_w = bh * factor, bw * factor
    for row_off in range(0, src.height, step_h):
        for col_off in range(0, src.width, step_w):
            height = min(step_h, src.height - row_off)   # clip bottom edge
            width = min(step_w, src.width - col_off)      # clip right edge
            yield Window(col_off, row_off, width, height)

def compute_ndvi(red: np.ndarray, nir: np.ndarray) -> np.ndarray:
    """(NIR - RED) / (NIR + RED) with a guarded denominator."""
    red = red.astype("float32")
    nir = nir.astype("float32")
    denom = nir + red
    ndvi = np.where(denom == 0, 0.0, (nir - red) / denom)
    return ndvi.astype("float32")

def peak_rss_mb() -> float:
    """Resident-set peak in MB (ru_maxrss is KB on Linux, bytes on macOS)."""
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw / 1024 if sys.platform.startswith("linux") else raw / (1024 * 1024)

def stream_ndvi(src_path: Path, dst_path: Path, red_idx: int,
                nir_idx: int, factor: int) -> int:
    with rasterio.open(src_path) as src:
        profile = src.profile.copy()          # inherit CRS, transform, nodata
        bh, bw = src.block_shapes[0]
        profile.update(
            count=1,                           # single NDVI output band
            dtype="float32",
            compress="deflate",
            tiled=True,
            blockxsize=bw,                     # match source block layout
            blockysize=bh,                     # so writes need no read-modify-write
            BIGTIFF="IF_SAFER",
        )
        bytes_per_block = bh * bw * 4 * 2      # two float32 buffers per block
        print(f"native block {bh}x{bw}, ~{bytes_per_block / 1e6:.2f} MB/block resident")

        with rasterio.open(dst_path, "w", **profile) as dst:
            for i, window in enumerate(super_block_windows(src, factor)):
                red = src.read(red_idx, window=window)     # only this block loaded
                nir = src.read(nir_idx, window=window)
                ndvi = compute_ndvi(red, nir)
                dst.write(ndvi, 1, window=window)          # write same window
                if i % 50 == 0:
                    print(f"block {i} peak RSS {peak_rss_mb():.1f} MB")

    print(f"done — final peak RSS {peak_rss_mb():.1f} MB")
    return 0

def main() -> None:
    parser = argparse.ArgumentParser(description="Stream NDVI over a mosaic")
    parser.add_argument("src", type=Path, help="Input multi-band GeoTIFF mosaic")
    parser.add_argument("dst", type=Path, help="Output single-band NDVI GeoTIFF")
    parser.add_argument("--red", type=int, default=3, help="1-based red band index")
    parser.add_argument("--nir", type=int, default=4, help="1-based NIR band index")
    parser.add_argument("--factor", type=int, default=4,
                        help="Super-block size as a multiple of the native block")
    args = parser.parse_args()
    if not args.src.exists():
        print(f"source not found: {args.src}", file=sys.stderr)
        sys.exit(2)
    sys.exit(stream_ndvi(args.src, args.dst, args.red, args.nir, args.factor))

if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`src.block_shapes[0]`** — Returns the `(height, width)` of band 1's internal tiles. This is the atomic read/write unit GDAL uses. Every streaming decision — how big a buffer you hold, how you align windows — flows from this number, so read it from the file rather than hard-coding 512.

2. **`super_block_windows(..., factor)`** — Native blocks are often only 256 or 512 pixels wide, so iterating them one at a time can mean tens of thousands of Python iterations. Stepping by `bh * factor` and `bw * factor` groups them into fewer, larger reads. Because the step is an exact multiple of the block shape, every window still begins and ends on a block boundary.

3. **`min(step_h, src.height - row_off)`** — Clips the final row and column of windows so they do not run past the raster edge. rasterio accepts an edge-clipped window and returns a correspondingly smaller array; the write uses the same clipped window, so shapes always match.

4. **`profile.update(blockxsize=bw, blockysize=bh, tiled=True)`** — Giving the output the same tile layout as the source means each block-aligned `dst.write` lands on exactly one set of output tiles. Without matching tiling, GDAL may perform a read-modify-write on partially covered output tiles, quietly inflating I/O.

5. **`src.read(red_idx, window=window)`** — The `window=` keyword is what keeps memory flat. Only the pixels inside `window` are decoded into the returned NumPy array; the rest of the mosaic never enters the process. The previous iteration's arrays are freed as soon as they go out of scope.

6. **`bytes_per_block` print** — Documents the memory contract up front: block height times block width times 4 bytes (float32) times two buffers (red and NIR). For a 512x512 block that is about 2 MB regardless of whether the mosaic is 2 GB or 200 GB.

## Named Gotcha: Reading Non-Block-Aligned Windows

The most common way to accidentally destroy streaming performance is to invent your own tile grid — for example, marching in fixed 500-pixel steps — instead of aligning to `src.block_shapes`. A 500-pixel window over a 512-pixel-tiled raster overlaps two block columns and two block rows for almost every read. GDAL cannot read a partial block: it decompresses all four overlapping tiles, hands you the 500x500 slice, and discards the rest. Your memory stays low, but decompression I/O roughly quadruples and throughput collapses.

The fix is to derive every window from the native block shape. Iterate `src.block_windows(1)` directly for the simplest correct loop, or, when you want larger reads, step by an integer multiple of `block_shapes` as `super_block_windows` does above. Never choose a step size that is not a whole-number multiple of the block dimensions:

```python
# WRONG — 500 is not a multiple of the 512-pixel block; every read decodes extra tiles
for row in range(0, src.height, 500):
    for col in range(0, src.width, 500):
        window = Window(col, row, 500, 500)

# RIGHT — block-aligned; each read maps cleanly onto whole tiles
for _, window in src.block_windows(1):
    data = src.read(1, window=window)
```

## Verification

Confirm two things: the output is correct, and peak memory really is flat. Run the script, then sample resident memory independently while re-processing, so a bug in the in-process meter cannot hide a leak:

```bash
# 1. Output carries the source CRS and has one band
python3 - <<'EOF'
import rasterio
with rasterio.open("ndvi.tif") as ds:
    print("crs:", ds.crs)                 # e.g. EPSG:32633, inherited from source
    print("count:", ds.count)             # 1
    print("block_shapes:", ds.block_shapes)  # matches source, e.g. [(512, 512)]
EOF

# 2. Peak RSS stays flat as mosaic size grows. Run over a small and a large
#    mosaic; the reported peak should barely change.
/usr/bin/time -v python stream_ndvi.py small_mosaic.tif s.tif 2>&1  | grep "Maximum resident"
/usr/bin/time -v python stream_ndvi.py huge_mosaic.tif  h.tif 2>&1  | grep "Maximum resident"
```

If the two `Maximum resident set size` values differ by more than the GDAL block-cache allowance (roughly `GDAL_CACHEMAX`, 5% of RAM by default), a full-raster read has crept in somewhere — check that no `src.read()` call is missing its `window=` argument. A correct stream shows near-identical peak RSS for both mosaics because memory is bounded by block size, not by the number of tiles.

## Performance Notes

Cap GDAL's own block cache so it does not shadow the memory you saved: export `GDAL_CACHEMAX=128` (MB) before the run, or the cache alone can dwarf your per-block buffers. Larger `--factor` values reduce Python loop overhead but raise the resident buffer linearly, so a `factor` of 4 over a 512-pixel block (a 2048-pixel super-block, ~16 MB for two float32 bands) is a good default. If NDVI throughput is I/O-bound rather than CPU-bound, the streaming loop parallelises cleanly across independent super-blocks — see the multiprocessing patterns in the parent [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## FAQ

<details class="faq-item">
<summary>Why iterate block_windows instead of reading fixed pixel tiles?</summary>

`block_windows(1)` yields windows aligned to the raster's internal tiling, so each read maps to whole GDAL blocks with no partial-block overhead. Reading arbitrary pixel rectangles forces GDAL to decode every block those rectangles touch, then discard the unused edges, wasting decompression I/O.
</details>

<details class="faq-item">
<summary>How much memory does one block actually use?</summary>

Peak resident memory is roughly `block_height` times `block_width` times the dtype byte width times band count, plus a matching output buffer and GDAL's block cache. A 512 by 512 float32 block is about 1 MB per band, so a handful of bands stays comfortably under 10 MB no matter how large the mosaic is.
</details>

<details class="faq-item">
<summary>Can I read a super-block covering several native blocks at once?</summary>

Yes. Group native blocks into a super-block whose height and width are integer multiples of `block_shapes`. This amortises Python loop overhead across more pixels while keeping reads block-aligned. Never pick a super-block that straddles a fractional block boundary, or you reintroduce partial-block reads.
</details>

<details class="faq-item">
<summary>Does the output need the same block layout as the input?</summary>

For the cleanest write path, set the output creation options to tiled with the same `blockxsize` and `blockysize` as the source. Writing a block-aligned window into a matching tiled output means GDAL flushes exactly the tiles you wrote with no read-modify-write cycle on neighbouring tiles.
</details>

---

## Related

- [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) — parent guide covering windowed reads, chunked pipelines, and resident-memory budgeting for oversized rasters and vectors
- [Handling Out-of-Memory Errors in Large Raster Mosaics](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/handling-out-of-memory-errors-in-large-raster-mosaics/) — diagnosing and recovering from OOM kills once a raster job has already exhausted memory
