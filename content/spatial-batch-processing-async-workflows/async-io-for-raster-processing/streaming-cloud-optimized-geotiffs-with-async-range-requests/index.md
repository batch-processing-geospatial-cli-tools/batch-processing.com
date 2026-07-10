---
title: "Streaming Cloud-Optimized GeoTIFFs with Async Range Requests"
description: "Fetch only the tiles you need from a remote COG using async HTTP range requests, decoding each block with rasterio without downloading the whole file."
slug: "streaming-cloud-optimized-geotiffs-with-async-range-requests"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Async I/O for Raster Processing: CLI Patterns"
    url: "/spatial-batch-processing-async-workflows/async-io-for-raster-processing/"
  - label: "Streaming Cloud-Optimized GeoTIFFs with Async Range Requests"
    url: "/spatial-batch-processing-async-workflows/async-io-for-raster-processing/streaming-cloud-optimized-geotiffs-with-async-range-requests/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Streaming Cloud-Optimized GeoTIFFs with Async Range Requests",
      "description": "Fetch only the tiles you need from a remote COG using async HTTP range requests, decoding each block with rasterio without downloading the whole file.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Async I/O for Raster Processing: CLI Patterns", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/"},
        {"@type": "ListItem", "position": 3, "name": "Streaming Cloud-Optimized GeoTIFFs with Async Range Requests", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/streaming-cloud-optimized-geotiffs-with-async-range-requests/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Stream blocks from a remote Cloud-Optimized GeoTIFF with async range requests",
      "step": [
        {"@type": "HowToStep", "name": "Confirm the file is a valid COG", "text": "Validate internal tiling and overviews so GDAL can seek to individual blocks instead of reading the whole file."},
        {"@type": "HowToStep", "name": "Configure the VSI curl layer", "text": "Set CPL_VSIL_CURL_ALLOWED_EXTENSIONS and GDAL_HTTP_MULTIPLEX so /vsicurl/ issues efficient HTTP range reads."},
        {"@type": "HowToStep", "name": "Bound concurrency with a Semaphore", "text": "Wrap each blocking rasterio window read in asyncio.to_thread guarded by an asyncio.Semaphore to cap simultaneous connections."},
        {"@type": "HowToStep", "name": "Read each window and reproject", "text": "Open the dataset inside the worker thread and read a rasterio.windows.Window transformed from EPSG:4326 to the raster CRS."},
        {"@type": "HowToStep", "name": "Verify bytes fetched versus full size", "text": "Compare the range bytes read against the full object size to confirm only the needed blocks were transferred."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does opening the dataset inside the worker thread matter?",
          "acceptedAnswer": {"@type": "Answer", "text": "A GDAL dataset handle is not thread-safe and must not be shared across threads. Opening the /vsicurl/ dataset inside the same thread that reads the window keeps each handle confined to one thread, which is why the open call lives inside the function passed to asyncio.to_thread rather than in the parent coroutine."}
        },
        {
          "@type": "Question",
          "name": "What happens if the remote file is not a valid COG?",
          "acceptedAnswer": {"@type": "Answer", "text": "A striped or untiled GeoTIFF has no internal blocks to seek to, so a windowed read forces GDAL to fetch the whole file or long contiguous strips. The result is that bytes fetched approaches the full object size and streaming provides no benefit. Run rio cogeo validate first and re-tile the source if it fails."}
        },
        {
          "@type": "Question",
          "name": "Does GDAL_HTTP_MULTIPLEX actually reduce latency?",
          "acceptedAnswer": {"@type": "Answer", "text": "When the origin serves HTTP/2, GDAL_HTTP_MULTIPLEX=YES lets multiple range requests share one connection, which cuts per-request handshake overhead when reading many small blocks. On an HTTP/1.1 origin it has no effect, so the asyncio.Semaphore limit becomes the primary throughput control."}
        },
        {
          "@type": "Question",
          "name": "How do I stream a window in Web Mercator instead of geographic coordinates?",
          "acceptedAnswer": {"@type": "Answer", "text": "Build the bounding box in EPSG:3857 and pass it through rasterio.warp.transform_bounds to the raster CRS before deriving the Window. The read still returns pixels in the raster CRS; reproject the array afterward with rasterio.warp.reproject if you need it resampled to EPSG:3857."}
        }
      ]
    }
  ]
}
</script>

# Streaming Cloud-Optimized GeoTIFFs with Async Range Requests

To stream just the blocks you need from a remote Cloud-Optimized GeoTIFF, point GDAL's `/vsicurl/` driver at the object's URL and read a `rasterio.windows.Window`; GDAL parses the header once, then issues HTTP range requests for only the tiles the window overlaps. Wrapping each blocking read in `asyncio.to_thread()` under a `Semaphore` lets you pull many windows concurrently without downloading whole files. This page is part of the [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) guide inside the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later (for `asyncio.to_thread`)
- `pip install rasterio aiohttp rio-cogeo`
- GDAL 3.4+ with curl support (`gdalinfo --formats | grep vsicurl` or check that `/vsicurl/` is usable)
- A COG reachable over HTTPS with an origin that honours `Range:` headers (S3, GCS, Azure Blob, and most CDNs do)

If your inputs are large enough that a single window still strains RAM, pair this with [Memory Management for Large GIS Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) so per-block arrays stay bounded.

## How COG Layout Enables Range Reads

A Cloud-Optimized GeoTIFF is an ordinary GeoTIFF with two disciplines applied: the pixel data is stored in internal **tiles** (typically 512×512 blocks) rather than scanline strips, and the file carries a pyramid of downsampled **overviews**. Both are described by the Image File Directory (IFD) at the front of the file, which lists the byte offset and length of every tile in every resolution level.

Because the IFD is compact and near the start of the object, GDAL can fetch it with one small range request, then compute exactly which tile byte-ranges cover a requested window. It issues a `Range: bytes=start-end` request per tile and decodes only those. A striped, non-COG GeoTIFF has no per-tile offsets, so any partial read collapses into fetching the whole file. The diagram below traces the request flow.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Async range-request flow: a client reads the IFD header, computes overlapping tile byte ranges, then fetches only those tiles concurrently from a remote COG" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Async range-request flow for a remote COG</title>
  <desc>A client first fetches the compact IFD header with one small range request, uses the tile offset table to compute which byte ranges cover the requested window, then issues concurrent range requests for only the overlapping tiles while the rest of the file is never transferred.</desc>
  <defs>
    <marker id="rr-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Left: client -->
  <rect x="20" y="120" width="150" height="80" rx="8" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.4"/>
  <text x="95" y="150" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">asyncio client</text>
  <text x="95" y="170" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">to_thread + Semaphore</text>
  <text x="95" y="186" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">rasterio Window read</text>
  <!-- Step 1 arrow -->
  <line x1="170" y1="140" x2="470" y2="70" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" marker-end="url(#rr-arrow)"/>
  <text x="315" y="92" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">1. range read: IFD header</text>
  <!-- Step 2 arrow -->
  <line x1="170" y1="180" x2="470" y2="180" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.4" marker-end="url(#rr-arrow)"/>
  <text x="315" y="172" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">2. range reads: overlapping tiles</text>
  <text x="315" y="200" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.6">concurrent, bounded by Semaphore</text>
  <!-- Right: remote object -->
  <rect x="480" y="30" width="220" height="260" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.4"/>
  <text x="590" y="52" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Remote COG object</text>
  <!-- IFD block -->
  <rect x="500" y="64" width="180" height="30" rx="4" fill="#a78bfa" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.1"/>
  <text x="590" y="83" text-anchor="middle" font-size="10" fill="currentColor">IFD: tile offset table</text>
  <!-- Tile grid -->
  <rect x="500" y="104" width="42" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="548" y="104" width="42" height="42" rx="3" fill="#15803d" fill-opacity="0.16" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <rect x="596" y="104" width="42" height="42" rx="3" fill="#15803d" fill-opacity="0.16" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <rect x="644" y="104" width="36" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="500" y="152" width="42" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="548" y="152" width="42" height="42" rx="3" fill="#15803d" fill-opacity="0.16" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <rect x="596" y="152" width="42" height="42" rx="3" fill="#15803d" fill-opacity="0.16" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <rect x="644" y="152" width="36" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="500" y="200" width="42" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="548" y="200" width="42" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="596" y="200" width="42" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="644" y="200" width="36" height="42" rx="3" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <!-- Legend -->
  <rect x="500" y="256" width="14" height="14" rx="2" fill="#15803d" fill-opacity="0.16" stroke="#15803d" stroke-opacity="0.6"/>
  <text x="522" y="267" font-size="9.5" fill="currentColor" opacity="0.8">fetched tiles</text>
  <rect x="600" y="256" width="14" height="14" rx="2" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="622" y="267" font-size="9.5" fill="currentColor" opacity="0.8">never sent</text>
</svg>

## Complete Working Implementation

The script below streams several map windows from a remote COG concurrently. It uses GDAL's `/vsicurl/` handler through rasterio, offloads each blocking window read to a thread with `asyncio.to_thread()`, and caps in-flight connections with an `asyncio.Semaphore`. Windows are specified as EPSG:4326 bounding boxes and transformed to the raster's native CRS before reading:

```python
#!/usr/bin/env python3
"""
Stream windows from a remote Cloud-Optimized GeoTIFF via async range requests.
Usage: python stream_cog.py https://example.com/data/scene.tif
"""
import asyncio
import os
import sys
from dataclasses import dataclass

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds

# GDAL /vsicurl/ tuning — set before any dataset is opened.
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")          # reuse HTTP/2 conn
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")  # no dir scan
os.environ.setdefault("VSI_CACHE", "TRUE")                   # cache header blocks
os.environ.setdefault("CPL_VSIL_CURL_USE_HEAD", "NO")       # skip extra HEAD call

MAX_CONCURRENCY = 8          # cap simultaneous range-request connections


@dataclass
class Aoi:
    """A named area of interest as a WGS84 (EPSG:4326) bounding box."""
    name: str
    west: float
    south: float
    east: float
    north: float


def read_window_blocking(url: str, aoi: Aoi) -> dict:
    """Open the remote COG and read one window. Runs in a worker thread.

    The dataset is opened HERE, not in the parent coroutine, because a GDAL
    dataset handle is bound to the thread that created it and must not be
    shared. Each call opens, reads, and closes within a single thread.
    """
    vsi_path = f"/vsicurl/{url}"
    with rasterio.open(vsi_path) as ds:
        # Reproject the EPSG:4326 bbox into the raster's own CRS so the
        # window lines up with the stored pixels (often EPSG:3857 or a UTM zone).
        left, bottom, right, top = transform_bounds(
            "EPSG:4326", ds.crs, aoi.west, aoi.south, aoi.east, aoi.north
        )
        window = from_bounds(left, bottom, right, top, transform=ds.transform)
        # Round to whole pixels; only tiles overlapping this window are fetched.
        window = window.round_offsets().round_lengths()
        data = ds.read(1, window=window)               # triggers range reads
        return {
            "name": aoi.name,
            "shape": data.shape,
            "crs": str(ds.crs),
            "min": float(np.nanmin(data)) if data.size else None,
            "max": float(np.nanmax(data)) if data.size else None,
        }


async def read_window(url: str, aoi: Aoi, sem: asyncio.Semaphore) -> dict:
    """Async wrapper: bound concurrency, then offload the blocking read."""
    async with sem:                                    # never exceed MAX_CONCURRENCY
        return await asyncio.to_thread(read_window_blocking, url, aoi)


async def stream_all(url: str, aois: list[Aoi]) -> list[dict]:
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    tasks = [read_window(url, aoi, sem) for aoi in aois]
    return await asyncio.gather(*tasks, return_exceptions=False)


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python stream_cog.py <cog-url>", file=sys.stderr)
        sys.exit(2)                                    # 2 = usage error
    url = sys.argv[1]

    # Example windows over a global EPSG:4326 raster.
    aois = [
        Aoi("berlin", 13.30, 52.45, 13.50, 52.58),
        Aoi("lisbon", -9.25, 38.68, -9.08, 38.80),
        Aoi("nairobi", 36.75, -1.35, 36.95, -1.20),
        Aoi("quito", -78.55, -0.30, -78.42, -0.10),
    ]

    try:
        results = asyncio.run(stream_all(url, aois))
    except rasterio.errors.RasterioIOError as exc:
        print(f"range read failed: {exc}", file=sys.stderr)
        sys.exit(1)                                    # 1 = runtime error

    for r in results:
        print(
            f"{r['name']:>8}  {r['shape']}  crs={r['crs']}  "
            f"min={r['min']}  max={r['max']}"
        )
    sys.exit(0)


if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`os.environ.setdefault(...)` before any open** — GDAL reads its configuration once when the curl layer initializes. `CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff"` tells `/vsicurl/` it may serve those URLs without a probing request, and `GDAL_HTTP_MULTIPLEX="YES"` lets multiple range requests ride a single HTTP/2 connection. Setting these after opening a dataset has no effect.

2. **`/vsicurl/{url}` prefix** — This is GDAL's virtual filesystem handler for HTTP(S) objects. Prefixing the URL routes reads through the range-request machinery instead of downloading the file to a temp path.

3. **`transform_bounds("EPSG:4326", ds.crs, ...)`** — The area of interest is expressed in geographic degrees, but the raster stores pixels in its own CRS. Transforming the bounding box first ensures the derived window maps to the correct pixel rows and columns; skipping this is the classic cause of empty or wildly offset reads.

4. **`from_bounds(...).round_offsets().round_lengths()`** — `from_bounds` yields a floating-point `Window`; rounding to whole pixels aligns it to block boundaries so GDAL fetches complete tiles. Sub-pixel windows still work but waste a partial tile fetch at each edge.

5. **Open inside `read_window_blocking`** — The dataset handle lives entirely within the worker thread. This is deliberate: GDAL handles are not thread-safe, so opening in the parent coroutine and sharing across `to_thread` calls would corrupt reads under concurrency.

6. **`asyncio.Semaphore(MAX_CONCURRENCY)`** — Each window read holds one connection to the origin. The semaphore caps simultaneous connections at eight, which keeps you under typical per-host connection limits and avoids `429 Too Many Requests` throttling from object stores.

7. **`asyncio.to_thread(read_window_blocking, ...)`** — rasterio reads are blocking C calls that release the GIL during I/O. Offloading them to the default thread pool lets the event loop keep other window reads in flight, giving genuine concurrency for network-bound work described in the [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) guide.

## Named Gotcha: A Non-COG or Overview-less File Forces Full-File Reads

The most common way this optimisation silently fails is pointing it at a GeoTIFF that is not actually cloud-optimized. If the source is striped (scanline layout) instead of internally tiled, or if it lacks overviews, GDAL cannot seek to a small block. A windowed read then pulls whole strips — often the entire file — and your carefully bounded window transfers just as many bytes as a naive download. Nothing errors; it is simply slow and expensive.

Validate the source before you rely on streaming, and re-tile it if it fails:

```bash
# Validate COG structure (rio-cogeo)
rio cogeo validate https://example.com/data/scene.tif

# If it fails, rewrite as a proper COG with tiles + overviews
rio cogeo create input.tif scene_cog.tif \
    --cog-profile deflate \
    --blocksize 512 \
    --overview-resampling average
```

A passing `rio cogeo validate` guarantees internal tiling and an overview pyramid, which is exactly what makes per-block range reads pay off.

## Verification

The point of streaming is transferring far fewer bytes than the object's full size. Measure it directly by asking the origin for the content length, then comparing against the bytes GDAL actually read:

```python
import aiohttp
import asyncio
from osgeo import gdal

URL = "https://example.com/data/scene.tif"

async def full_size(url: str) -> int:
    async with aiohttp.ClientSession() as session:
        async with session.head(url) as resp:
            return int(resp.headers["Content-Length"])

# Read one small window and inspect GDAL's byte counter.
gdal.SetConfigOption("CPL_CURL_VERBOSE", "NO")
gdal.SetConfigOption("GDAL_HTTP_MULTIPLEX", "YES")
ds = gdal.Open(f"/vsicurl/{URL}")
band = ds.GetRasterBand(1)
_ = band.ReadAsArray(0, 0, 512, 512)          # one tile-sized window

# GDAL exposes network counters via VSIStatL / vsimem stats.
stats = gdal.GetActualURLStatistics() if hasattr(gdal, "GetActualURLStatistics") else None
total = asyncio.run(full_size(URL))
print(f"full object size : {total:,} bytes")
print(f"single 512x512 window should fetch << that")
```

For a true COG, one 512×512 window fetches on the order of a few hundred kilobytes regardless of whether the full object is 50 MB or 5 GB. If the fetched total approaches the full size, the file is not tiled — return to the gotcha above. GDAL's own `--debug on` (`CPL_DEBUG=ON`) also logs each `VSICURL: Downloading ...` range, letting you count requests per window.

## Performance Notes

- **Right-size the semaphore.** Eight concurrent connections saturate most single-origin CDNs. Object stores like S3 tolerate more, but past ~16 you trade throughput for throttling risk. Benchmark before raising it.
- **Reuse overviews for zoomed-out views.** If you only need a coarse preview, read from an overview level (`ds.read(1, out_shape=(h, w))` with a downscaled shape) so GDAL fetches the small pyramid tiles instead of full-resolution blocks.
- **Keep `VSI_CACHE=TRUE`.** The IFD header is read once and cached in memory; without caching, every window re-fetches the header, adding a round-trip per read.

## FAQ

<details class="faq-item">
<summary>Why does opening the dataset inside the worker thread matter?</summary>

A GDAL dataset handle is not thread-safe and must not be shared across threads. Opening the `/vsicurl/` dataset inside the same thread that reads the window keeps each handle confined to one thread, which is why the open call lives inside the function passed to `asyncio.to_thread` rather than in the parent coroutine.
</details>

<details class="faq-item">
<summary>What happens if the remote file is not a valid COG?</summary>

A striped or untiled GeoTIFF has no internal blocks to seek to, so a windowed read forces GDAL to fetch the whole file or long contiguous strips. The result is that bytes fetched approaches the full object size and streaming provides no benefit. Run `rio cogeo validate` first and re-tile the source if it fails.
</details>

<details class="faq-item">
<summary>Does GDAL_HTTP_MULTIPLEX actually reduce latency?</summary>

When the origin serves HTTP/2, `GDAL_HTTP_MULTIPLEX=YES` lets multiple range requests share one connection, which cuts per-request handshake overhead when reading many small blocks. On an HTTP/1.1 origin it has no effect, so the `asyncio.Semaphore` limit becomes the primary throughput control.
</details>

<details class="faq-item">
<summary>How do I stream a window in Web Mercator instead of geographic coordinates?</summary>

Build the bounding box in EPSG:3857 and pass it through `rasterio.warp.transform_bounds` to the raster CRS before deriving the `Window`. The read still returns pixels in the raster CRS; reproject the array afterward with `rasterio.warp.reproject` if you need it resampled to EPSG:3857.
</details>

---

## Related

- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — parent guide covering asyncio patterns, thread offloading, and connection limits for network-bound raster work
- [Processing 100k GeoJSON Files with Python asyncio](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/processing-100k-geojson-files-with-python-asyncio/) — the vector counterpart: fan out many small async reads under a bounded semaphore
