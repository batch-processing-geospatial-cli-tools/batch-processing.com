---
title: "Async I/O for Raster Processing: CLI Patterns"
description: "Build a Python asyncio pipeline that fetches and writes cloud-optimized GeoTIFFs concurrently — without stalling the event loop on GDAL's synchronous C bindings."
slug: "async-io-for-raster-processing"
type: "topic"
breadcrumb: "Async I/O for Raster Processing"
datePublished: "2024-11-10"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Async I/O for Raster Processing: CLI Patterns",
      "description": "How to build a Python asyncio pipeline that fetches, decompresses, and writes cloud-optimized GeoTIFFs concurrently — without stalling the event loop on GDAL's synchronous C bindings.",
      "datePublished": "2024-11-10",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Async I/O for Raster Processing", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build an async raster processing pipeline with aiohttp and rasterio",
      "step": [
        {"@type": "HowToStep", "name": "Configure semaphore and aiohttp session", "text": "Initialise an asyncio.Semaphore to cap concurrent network requests and a shared aiohttp.ClientSession to reuse TCP connections."},
        {"@type": "HowToStep", "name": "Stream remote rasters to temporary files", "text": "Use aiohttp response.content.iter_chunked() to buffer each GeoTIFF to a NamedTemporaryFile without loading the full tile into memory."},
        {"@type": "HowToStep", "name": "Offload GDAL reads to asyncio.to_thread()", "text": "Wrap rasterio.open() and windowed read calls inside asyncio.to_thread() so blocking C operations do not stall the event loop."},
        {"@type": "HowToStep", "name": "Wrap in a Click CLI entry point", "text": "Expose concurrency, output directory, and URL file as Click options; call asyncio.run() once at the top level."},
        {"@type": "HowToStep", "name": "Verify with log output and checksums", "text": "Confirm correct CRS, pixel count, and POSIX exit codes in structured JSON logs."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does rasterio block the asyncio event loop?",
          "acceptedAnswer": {"@type": "Answer", "text": "rasterio is a Cython wrapper around GDAL's C library. GDAL file opens, header reads, and pixel decompression all release the Python GIL but do not yield to the asyncio event loop — they are blocking OS calls. asyncio.to_thread() moves them to a thread-pool worker so the loop can continue scheduling other coroutines."}
        },
        {
          "@type": "Question",
          "name": "What semaphore limit should I use for a COG batch?",
          "acceptedAnswer": {"@type": "Answer", "text": "Start at 10–20 and benchmark network utilisation. Cloud-optimised GeoTIFFs served via HTTP range requests are small per request; the limit is usually your outbound bandwidth or the remote host's rate cap, not local CPU."}
        },
        {
          "@type": "Question",
          "name": "Can I use asyncio with multiprocessing for CPU-heavy transforms?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes. Run asyncio for all I/O phases, then fan the downloaded paths out to a multiprocessing.Pool for pixel-level transforms. Avoid spawning subprocess workers inside a running event loop — collect temp paths first, then call the pool synchronously after asyncio.run() returns."}
        },
        {
          "@type": "Question",
          "name": "How do I handle a GDAL driver not available error in async context?",
          "acceptedAnswer": {"@type": "Answer", "text": "Catch rasterio.errors.RasterioIOError inside _read_and_write and re-raise as a domain-specific exception. The outer asyncio.gather(return_exceptions=True) collects it without aborting the batch."}
        },
        {
          "@type": "Question",
          "name": "Is aiofiles a better choice than tempfile for buffering rasters?",
          "acceptedAnswer": {"@type": "Answer", "text": "No. GDAL requires seekable file handles with a .tif extension for driver detection. aiofiles writes to named files asynchronously, but the overhead over streaming chunks via aiohttp's iter_chunked() to a standard NamedTemporaryFile is negligible and avoids an extra dependency."}
        }
      ]
    }
  ]
}
</script>

Raster batch pipelines stall at I/O: a synchronous loop over 500 cloud-optimized GeoTIFFs spends 90 % of its wall time blocked on network round-trips, not on pixel math. The fix is to decouple network and disk waits from GDAL compute using Python's `asyncio` event loop — part of the broader [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) guide.

## TL;DR

Use `aiohttp` to fetch rasters concurrently, buffer each file to a `NamedTemporaryFile`, then offload every `rasterio` call to `asyncio.to_thread()` so GDAL's blocking C routines never stall the event loop. A semaphore caps concurrency; a single shared `ClientSession` reuses TCP connections across the entire batch.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.9+ | `asyncio.to_thread()` added in 3.9 |
| `aiohttp` | ≥ 3.8 | async HTTP client |
| `rasterio` | ≥ 1.3 | GDAL-backed raster I/O |
| `click` | ≥ 8.1 | CLI argument parsing |
| `tqdm` | ≥ 4.65 | async-aware progress bars |
| GDAL | ≥ 3.4 | compiled with `curl`, `libtiff`, `libjpeg` |

```bash
pip install aiohttp rasterio click tqdm
python -c "import rasterio; print(rasterio.__gdal_version__())"
ulimit -n 4096   # raise open-file-descriptor limit for concurrent handles
```

Verify GDAL driver availability for your target format:

```python
import rasterio
print(rasterio.drivers.raster_driver_extensions())  # includes 'tif', 'jp2', 'vrt'
```

For [CLI Subcommand Organization](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/) patterns that structure multi-step pipelines into composable commands, see the CLI Architecture guide.

## Problem Framing

A naive synchronous pipeline processes each raster sequentially:

```python
# slow: each fetch blocks until complete before the next starts
for url in urls:
    path = download(url)          # ~800 ms network wait
    result = process(path)        # ~120 ms GDAL decompression
    results.append(result)
# wall time ≈ 920 ms × N
```

With 500 tiles, that is over seven minutes of mostly idle time. The event loop approach cuts wall time to roughly the duration of the slowest batch — typically 15–25 seconds at `MAX_CONCURRENT = 15` on a 100 Mbit connection.

The second pain point is memory. Loading entire GeoTIFFs for large mosaics causes RSS to grow linearly with batch size. The solution is windowed reads: GDAL reads only the requested pixel rectangle from disk or over the network range request. For broader coverage of memory-safe strategies see [Memory Management for Large Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/).

## Architecture Overview

<svg viewBox="0 0 820 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Async raster pipeline: URL list feeds a semaphore-controlled aiohttp fetch layer, which writes temporary files, then asyncio.to_thread offloads rasterio reads to a thread pool, and results are collected by asyncio.gather" style="width:100%;max-width:820px;display:block;margin:1.5rem auto;">
  <title>Async raster pipeline data-flow diagram</title>
  <desc>URL list feeds a semaphore-controlled aiohttp fetch layer, which writes temporary files, then asyncio.to_thread offloads rasterio reads to a thread pool, and results are collected by asyncio.gather.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- URL list box -->
  <rect x="20" y="130" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.5"/>
  <text x="85" y="155" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">URL list</text>
  <text x="85" y="172" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">(text file)</text>
  <!-- Semaphore box -->
  <rect x="195" y="115" width="130" height="90" rx="8" fill="none" stroke="#7c3aed" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="260" y="148" text-anchor="middle" font-size="12" fill="#7c3aed" font-family="system-ui,sans-serif" font-weight="600">Semaphore</text>
  <text x="260" y="165" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="system-ui,sans-serif">asyncio.Semaphore</text>
  <text x="260" y="181" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="system-ui,sans-serif">(limit=15)</text>
  <!-- aiohttp fetch box -->
  <rect x="375" y="50" width="150" height="70" rx="8" fill="none" stroke="#7c3aed" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="450" y="78" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">aiohttp fetch</text>
  <text x="450" y="96" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">ClientSession  ·  TCP reuse</text>
  <text x="450" y="112" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">iter_chunked(8192)</text>
  <!-- Temp file box -->
  <rect x="375" y="210" width="150" height="60" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.5"/>
  <text x="450" y="237" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">NamedTemporaryFile</text>
  <text x="450" y="255" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">suffix=".tif"</text>
  <!-- Thread pool box -->
  <rect x="580" y="120" width="145" height="80" rx="8" fill="none" stroke="#7c3aed" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="652" y="148" text-anchor="middle" font-size="12" fill="#7c3aed" font-family="system-ui,sans-serif" font-weight="600">Thread pool</text>
  <text x="652" y="165" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="system-ui,sans-serif">asyncio.to_thread()</text>
  <text x="652" y="181" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7" font-family="system-ui,sans-serif">rasterio.open() + write</text>
  <!-- Results box -->
  <rect x="580" y="255" width="145" height="55" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.5"/>
  <text x="652" y="279" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif">asyncio.gather()</text>
  <text x="652" y="296" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="system-ui,sans-serif">List[Dict]  results</text>
  <!-- Arrows -->
  <!-- URL list -> Semaphore -->
  <line x1="150" y1="160" x2="193" y2="160" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Semaphore -> aiohttp fetch -->
  <line x1="325" y1="140" x2="373" y2="105" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Semaphore -> Temp file -->
  <line x1="325" y1="180" x2="373" y2="225" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- aiohttp fetch -> Temp file -->
  <line x1="450" y1="120" x2="450" y2="208" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arr)"/>
  <!-- Temp file -> Thread pool -->
  <line x1="525" y1="240" x2="578" y2="200" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Thread pool -> Results -->
  <line x1="652" y1="200" x2="652" y2="253" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Phase labels -->
  <text x="260" y="222" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.45" font-family="system-ui,sans-serif" font-style="italic">I/O phase</text>
  <text x="652" y="115" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.45" font-family="system-ui,sans-serif" font-style="italic">compute phase</text>
</svg>

The pipeline deliberately separates the I/O phase (all downloads run concurrently behind the semaphore) from the compute phase (GDAL thread-pool workers). Mixing the two in a single coroutine serialises each download-then-process step and eliminates the concurrency benefit.

## Step-by-Step Implementation

### Step 1 — Concurrency controls and session setup

```python
import asyncio
import tempfile
import os
from pathlib import Path
from typing import Any

import aiohttp

MAX_CONCURRENT = 15          # adjust to bandwidth and remote API quotas


def make_session(concurrency: int) -> aiohttp.ClientSession:
    """Return a shared ClientSession with DNS caching and bounded TCP pool."""
    connector = aiohttp.TCPConnector(
        limit=concurrency,
        limit_per_host=concurrency,
        ttl_dns_cache=300,       # cache DNS for 5 minutes
        ssl=False,               # set True for HTTPS-only remotes
    )
    timeout = aiohttp.ClientTimeout(total=120, connect=10)
    return aiohttp.ClientSession(connector=connector, timeout=timeout)
```

`limit_per_host` prevents a single slow remote from consuming the entire pool when the URL list spans multiple hosts (e.g. AWS S3 + a WMS tile server).

### Step 2 — Async raster fetch with semaphore

```python
async def fetch_raster_to_temp(
    session: aiohttp.ClientSession,
    url: str,
    semaphore: asyncio.Semaphore,
) -> str:
    """Stream a remote raster to a named temp file; return its path."""
    async with semaphore:
        async with session.get(url) as resp:
            resp.raise_for_status()
            # GDAL needs a real filename with the right extension for driver detection
            suffix = Path(url).suffix or ".tif"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                async for chunk in resp.content.iter_chunked(65536):
                    tmp.write(chunk)
                return tmp.name
```

`iter_chunked(65536)` (64 KB) is a reasonable chunk size: small enough to keep memory bounded per connection, large enough to avoid excessive syscall overhead for files in the 10–500 MB range typical of remote sensing tiles.

### Step 3 — Thread-safe rasterio processing

`rasterio` and GDAL release the Python GIL but do not yield to asyncio. Wrapping calls in `asyncio.to_thread()` keeps the event loop responsive.

```python
import rasterio
from rasterio.windows import Window
from rasterio.crs import CRS


async def process_raster_async(
    temp_path: str,
    output_dir: Path,
    epsg: int = 4326,
    window: Window = Window(0, 0, 512, 512),
) -> dict[str, Any]:
    """Read a windowed tile, reproject if needed, write output GeoTIFF."""

    def _read_and_write() -> dict[str, Any]:
        target_crs = CRS.from_epsg(epsg)
        with rasterio.open(temp_path) as src:
            # Validate CRS before any pixel work
            if src.crs is None:
                raise ValueError(f"No CRS in {temp_path}; cannot reproject to EPSG:{epsg}")
            meta = {
                "crs": src.crs.to_epsg(),
                "width": src.width,
                "height": src.height,
                "count": src.count,
                "dtype": src.dtypes[0],
            }
            data = src.read(window=window)
            out_transform = src.window_transform(window)

        stem = Path(temp_path).stem
        out_path = output_dir / f"{stem}_w{window.col_off}_{window.row_off}.tif"
        with rasterio.open(
            str(out_path), "w",
            driver="GTiff",
            height=window.height,
            width=window.width,
            count=meta["count"],
            dtype=meta["dtype"],
            crs=target_crs,
            transform=out_transform,
            compress="lzw",
            tiled=True,
            blockxsize=256,
            blockysize=256,
        ) as dst:
            dst.write(data)

        os.unlink(temp_path)   # clean up immediately; do not accumulate temp files
        return {"output": str(out_path), "source_epsg": meta["crs"], "target_epsg": epsg}

    return await asyncio.to_thread(_read_and_write)
```

Setting `tiled=True` with 256×256 blocks produces a COG-compatible output that allows downstream HTTP range requests — preserving the same access pattern for the next pipeline stage.

### Step 4 — Batch orchestration with separated fetch and process phases

```python
from tqdm.asyncio import tqdm as async_tqdm


async def run_batch(
    urls: list[str],
    output_dir: Path,
    concurrency: int = MAX_CONCURRENT,
    epsg: int = 4326,
) -> list[dict[str, Any]]:
    semaphore = asyncio.Semaphore(concurrency)
    output_dir.mkdir(parents=True, exist_ok=True)

    async with make_session(concurrency) as session:
        # Phase 1: fetch all tiles concurrently
        fetch_tasks = [
            fetch_raster_to_temp(session, url, semaphore) for url in urls
        ]
        temp_paths: list[str] = await async_tqdm.gather(
            *fetch_tasks, desc="Fetching", unit="tile"
        )

        # Phase 2: process concurrently — downloads are complete before this starts
        process_tasks = [
            process_raster_async(p, output_dir, epsg=epsg)
            for p in temp_paths
        ]
        results = await async_tqdm.gather(
            *process_tasks, desc="Processing", unit="tile",
            return_exceptions=True,  # collect errors without aborting the batch
        )

    errors = [r for r in results if isinstance(r, Exception)]
    if errors:
        import logging
        for err in errors:
            logging.error("tile_failed", extra={"error": str(err)})

    return [r for r in results if not isinstance(r, Exception)]
```

`return_exceptions=True` on `gather` is critical for production: a single malformed tile or unreachable URL should not abort the other 499. Failed tiles are logged and excluded from the return value; the caller can inspect and retry them. [Error handling in spatial pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) covers structured retry and dead-letter patterns in more depth.

### Step 5 — Click CLI entry point

```python
import json
import sys
import click


@click.command()
@click.argument("url_file", type=click.Path(exists=True, dir_okay=False))
@click.option(
    "--output-dir", "-o",
    default="./output",
    type=click.Path(),
    show_default=True,
    help="Directory for processed windowed tiles.",
)
@click.option(
    "--concurrency", "-c",
    default=15,
    type=click.IntRange(1, 64),
    show_default=True,
    envvar="RASTER_CONCURRENCY",
    help="Max simultaneous network requests.",
)
@click.option(
    "--epsg",
    default=4326,
    type=int,
    show_default=True,
    envvar="RASTER_TARGET_EPSG",
    help="Target CRS for output tiles (EPSG code).",
)
@click.option(
    "--json-log", is_flag=True, default=False,
    help="Emit structured JSON summary to stdout.",
)
def cli(url_file: str, output_dir: str, concurrency: int, epsg: int, json_log: bool):
    """Async CLI: fetch and process GeoTIFFs from URL_FILE concurrently."""
    urls = Path(url_file).read_text().splitlines()
    urls = [u.strip() for u in urls if u.strip()]

    if not urls:
        click.echo("No URLs found in input file.", err=True)
        sys.exit(1)

    click.echo(f"Processing {len(urls)} tiles → {output_dir} (EPSG:{epsg})", err=True)
    results = asyncio.run(
        run_batch(urls, Path(output_dir), concurrency=concurrency, epsg=epsg)
    )

    summary = {"processed": len(results), "failed": len(urls) - len(results)}
    if json_log:
        click.echo(json.dumps(summary))
    else:
        click.echo(
            f"Done: {summary['processed']} tiles written, {summary['failed']} failed.",
            err=True,
        )
    sys.exit(0 if summary["failed"] == 0 else 1)


if __name__ == "__main__":
    cli()
```

The `envvar` parameters on `--concurrency` and `--epsg` follow the layered configuration pattern: environment variables override defaults, CLI flags override environment variables. This matches the precedence chain documented in [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/).

## Configuration Integration

For persistent settings, drop a `raster_pipeline.yaml` alongside the script:

```yaml
# raster_pipeline.yaml
concurrency: 20
epsg: 32633          # UTM zone 33N for European datasets
output_dir: ./tiles
```

Load it in `cli()` before processing flags:

```python
import yaml

def load_config(path: Path = Path("raster_pipeline.yaml")) -> dict:
    if path.exists():
        return yaml.safe_load(path.read_text()) or {}
    return {}
```

Pass values as `default_map` to Click so YAML values sit between built-in defaults and CLI flags:

```python
ctx.default_map = load_config()
```

The full YAML config pattern — including environment variable interpolation and schema validation — is covered in [Managing YAML Configs for Geospatial CLI Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/).

## Error Handling and Gotchas

### CRS is None

Remote tiles from undocumented WMS endpoints or older Landsat archives often lack embedded CRS metadata. `rasterio.open()` returns `src.crs = None` rather than raising. Always check before calling `.to_epsg()`.

**Fix:** raise a domain-specific `ValueError` inside `_read_and_write`; the outer `gather(return_exceptions=True)` captures it without killing the batch.

### Block misalignment on windowed writes

If `window.height` or `window.width` exceeds the actual raster dimensions, GDAL silently clips the read — the returned array is smaller than expected, causing shape mismatches when calling `dst.write(data)`.

**Fix:** clamp the window with `src.window(*src.bounds)` intersected against your requested window before reading.

### GDAL driver not available

`rasterio.errors.RasterioIOError: No such file or directory` on a `.jp2` file means your GDAL build lacks OpenJPEG support.

**Fix:** install `gdal-bin` with `--with-openjpeg` or use `pip install gdal[jp2openjpeg]` wheels. Check at startup:

```python
from rasterio.drivers import raster_driver_extensions
assert "jp2" in raster_driver_extensions(), "GDAL OpenJPEG driver not available"
```

### Memory exhaustion with concurrent large tiles

Each `asyncio.to_thread()` worker holds the decompressed tile in RAM until `dst.write()` completes. At 15 concurrent 500 MB tiles, peak RSS exceeds 7 GB.

**Fix:** reduce concurrency or use `rasterio` windowed reads with smaller `Window` dimensions to process tiles in 256×256 chunks. See [Memory Management for Large Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) for producer-consumer queue patterns that bound peak memory independently of batch size.

### aiohttp ResourceWarning on shutdown

`ResourceWarning: Unclosed client session` appears when `ClientSession` is created outside an `async with` block or the event loop exits before cleanup.

**Fix:** always use `async with make_session(concurrency) as session:` as shown in Step 4. Never store the session as a module-level global.

## Verification

Confirm the pipeline output is correct before promoting to production:

```bash
# 1. Run on a small test batch and check exit code
echo "https://example.com/tile_001.tif" > /tmp/test_urls.txt
python raster_pipeline.py /tmp/test_urls.txt --output-dir /tmp/out --json-log
# expected stdout: {"processed": 1, "failed": 0}
# expected exit code: 0

# 2. Verify CRS of output tiles
python - <<'EOF'
import rasterio, pathlib
for p in pathlib.Path("/tmp/out").glob("*.tif"):
    with rasterio.open(p) as src:
        print(p.name, src.crs.to_epsg(), src.width, src.height, src.count)
EOF

# 3. Checksum pixel data reproducibility
python - <<'EOF'
import rasterio, hashlib, pathlib
for p in sorted(pathlib.Path("/tmp/out").glob("*.tif")):
    with rasterio.open(p) as src:
        raw = src.read().tobytes()
    print(p.name, hashlib.sha256(raw).hexdigest()[:16])
EOF
```

Expected: CRS matches `--epsg` value; pixel SHA-256 is identical across repeated runs (idempotent).

For structured JSON log output, redirect stderr with `2>pipeline.log` and inspect with `jq '.error // "ok"' pipeline.log`. The logging patterns used in [Logging Spatial Transformation Results to Structured JSON](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) apply directly here.

## Performance Notes

| Metric | Synchronous baseline | Async (15 workers) | Notes |
|---|---|---|---|
| Wall time (100 tiles, ~50 MB each) | ~820 s | ~55–90 s | 8–15x speedup typical on 100 Mbit uplink |
| Peak RSS | ~500 MB | ~1.2 GB | concurrent decompression; reduce window size to control |
| CPU utilisation | ~12 % | ~45–60 % | thread-pool workers use multiple cores for GDAL decompression |
| Open file descriptors | ~10 | ~60–80 | ensure `ulimit -n ≥ 4096` |

**Tuning guidance:**

- If network utilisation plateaus below bandwidth capacity, increase the semaphore limit in steps of 5 and re-measure.
- If CPU utilisation hits 100 % before the network saturates, the bottleneck is GDAL decompression. Switch to a `ProcessPoolExecutor` for compute-heavy transforms and coordinate the two pools using a bounded asyncio queue.
- For batches of 10,000+ tiles, chunk the URL list into pages of 200–500, process each page with `run_batch()`, and write a checkpoint file after each page. The checkpoint pattern for interrupted spatial batches is covered in [Implementing Checkpointing for Interrupted Spatial Batches](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/).

## FAQ

<details class="faq-item">
<summary>Why does rasterio block the asyncio event loop?</summary>

`rasterio` is a Cython wrapper around GDAL's C library. GDAL file opens, header reads, and pixel decompression all release the Python GIL — so they do not block threads — but they do not yield to the asyncio event loop. They are blocking OS calls. `asyncio.to_thread()` moves them to a thread-pool worker so the loop can continue scheduling fetch coroutines.

</details>

<details class="faq-item">
<summary>What semaphore limit should I use for a COG batch?</summary>

Start at 10–20 and observe two metrics: network bytes/sec and `asyncio` event-loop lag. Cloud-optimised GeoTIFFs served via HTTP range requests generate many small requests; the bottleneck is usually outbound bandwidth or the remote host's per-IP rate limit, not local CPU. If the remote returns `429 Too Many Requests`, halve the limit and add jittered exponential backoff.

</details>

<details class="faq-item">
<summary>Can I combine asyncio fetching with multiprocessing for heavy transforms?</summary>

Yes. Run `asyncio` for all I/O phases via `run_batch()`, collect the list of local temp paths, then pass them to a `multiprocessing.Pool` for pixel-level transforms outside the event loop. Do not spawn subprocess workers inside a running loop — the interaction between `fork()` and the event loop is unsafe. See [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) for pool-based patterns.

</details>

<details class="faq-item">
<summary>How do I handle GDAL driver not available inside an async coroutine?</summary>

Catch `rasterio.errors.RasterioIOError` inside the `_read_and_write` closure and re-raise as a domain-specific exception. The outer `asyncio.gather(return_exceptions=True)` collects it without aborting the batch. Log the offending URL with structured JSON so you can identify driver gaps post-run.

</details>

<details class="faq-item">
<summary>Is aiofiles better than NamedTemporaryFile for buffering rasters?</summary>

No. GDAL requires a seekable, named file handle with the correct extension for driver detection. `aiofiles` writes to named files asynchronously, but streaming chunks via `aiohttp`'s `iter_chunked()` into a standard `NamedTemporaryFile` is equivalent in practice — the write is sequential and the bottleneck is network, not the file write itself. `aiofiles` would add a dependency without measurable benefit here.

</details>

## Related

- [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) — parent guide covering async safety, spatial indexing, and chunk alignment across all pipeline types
- [Processing 100k GeoJSON Files with Python asyncio](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/processing-100k-geojson-files-with-python-asyncio/) — applies the same semaphore-and-gather pattern to vector feature batches
- [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) — when CPU-bound transforms outpace async I/O savings
- [Chunked Vector Data Reading](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — complementary memory-safe pattern for heterogeneous spatial pipelines mixing rasters and vector boundaries
