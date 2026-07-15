---
title: "Multiprocessing vs Asyncio for Raster Batch Jobs"
description: "Decide between a process pool and an async event loop for raster batch work by matching CPU-bound warps to multiprocessing and I/O-bound cloud reads to asyncio."
slug: "multiprocessing-vs-asyncio-for-raster-batch-jobs"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Async I/O for Raster Processing: CLI Patterns"
    url: "/spatial-batch-processing-async-workflows/async-io-for-raster-processing/"
  - label: "Multiprocessing vs Asyncio for Raster Batch Jobs"
    url: "/spatial-batch-processing-async-workflows/async-io-for-raster-processing/multiprocessing-vs-asyncio-for-raster-batch-jobs/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Multiprocessing vs Asyncio for Raster Batch Jobs

Match the tool to the bottleneck: use `multiprocessing` for CPU-bound raster work — warp, reproject, resample, raster algebra — because that pixel math holds the CPU and only true parallel processes scale it, and use `asyncio` for I/O-bound work such as cloud-optimized GeoTIFF range reads and many small HTTP fetches, where tasks spend their time awaiting the network. For jobs that mix both, run an async loop that dispatches to a process pool. It belongs to the [Async I/O for Raster Processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) guide, part of the [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install rasterio aiohttp` (rasterio wraps GDAL 3.4+)
- `concurrent.futures`, `asyncio`, and `multiprocessing` are all standard library

If your job is purely CPU-bound and you have already decided on processes, the [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) guide covers pool tuning, worker isolation, and the `spawn` start method in depth. This page is the decision layer that sits above it.

## The One Question That Decides Everything

Concurrency models do not compete on features; they compete on which bottleneck they remove. A process pool removes the CPU ceiling by running N Python interpreters on N cores. An event loop removes the waiting ceiling by letting one thread juggle thousands of in-flight network requests. Pick the wrong one and you pay all the overhead for none of the benefit. The decision tree below turns the whole choice into three questions about where wall-clock time actually goes.

<svg viewBox="0 0 720 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree for choosing a concurrency model: if the raster work is CPU-bound use a process pool, if it is I/O-bound use asyncio, and if it is mixed use an async loop that dispatches to a process pool" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Choosing multiprocessing, asyncio, or a hybrid for raster batch jobs</title>
  <desc>A top-down decision tree. The root asks whether the dominant cost is CPU or I/O. A CPU-bound branch leads to a process pool box. An I/O-bound branch leads to an asyncio box. A mixed branch leads to a hybrid box that combines an async loop with a process pool executor.</desc>
  <defs>
    <marker id="dt-arr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
  <!-- Root -->
  <rect x="250" y="20" width="220" height="56" rx="8" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.4"/>
  <text x="360" y="44" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Where does wall-clock</text>
  <text x="360" y="62" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">time go?</text>
  <!-- Branch labels from root -->
  <line x1="290" y1="76" x2="140" y2="130" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#dt-arr)"/>
  <line x1="360" y1="76" x2="360" y2="130" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#dt-arr)"/>
  <line x1="430" y1="76" x2="580" y2="130" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#dt-arr)"/>
  <text x="188" y="104" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">CPU-bound</text>
  <text x="360" y="104" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">mixed</text>
  <text x="536" y="104" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">I/O-bound</text>
  <!-- Condition row -->
  <rect x="60" y="130" width="160" height="52" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="140" y="151" text-anchor="middle" font-size="10.5" fill="currentColor">warp, reproject,</text>
  <text x="140" y="166" text-anchor="middle" font-size="10.5" fill="currentColor">resample, algebra</text>
  <rect x="280" y="130" width="160" height="52" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="360" y="151" text-anchor="middle" font-size="10.5" fill="currentColor">read cloud tiles,</text>
  <text x="360" y="166" text-anchor="middle" font-size="10.5" fill="currentColor">then warp them</text>
  <rect x="500" y="130" width="160" height="52" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="580" y="151" text-anchor="middle" font-size="10.5" fill="currentColor">COG range reads,</text>
  <text x="580" y="166" text-anchor="middle" font-size="10.5" fill="currentColor">many small fetches</text>
  <!-- Down arrows to result -->
  <line x1="140" y1="182" x2="140" y2="238" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#dt-arr)"/>
  <line x1="360" y1="182" x2="360" y2="238" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#dt-arr)"/>
  <line x1="580" y1="182" x2="580" y2="238" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#dt-arr)"/>
  <!-- Result boxes -->
  <rect x="55" y="238" width="170" height="66" rx="8" fill="currentColor" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.5"/>
  <text x="140" y="264" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Process pool</text>
  <text x="140" y="283" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">ProcessPoolExecutor</text>
  <text x="140" y="297" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">scales with cores</text>
  <rect x="275" y="238" width="170" height="66" rx="8" fill="currentColor" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.8" stroke-width="1.5"/>
  <text x="360" y="264" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Hybrid</text>
  <text x="360" y="283" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">async loop plus</text>
  <text x="360" y="297" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">run_in_executor</text>
  <rect x="495" y="238" width="170" height="66" rx="8" fill="currentColor" fill-opacity="0.08" stroke="#818cf8" stroke-opacity="0.8" stroke-width="1.5"/>
  <text x="580" y="264" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Asyncio</text>
  <text x="580" y="283" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">single-thread loop</text>
  <text x="580" y="297" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">scales with awaits</text>
  <!-- Footer note -->
  <rect x="150" y="332" width="420" height="34" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.1"/>
  <text x="360" y="353" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">Measure the stage split first — the tree only works on real timings</text>
</svg>

## The Same Task, Both Ways, Side by Side

The script below performs one job — fetch a set of cloud rasters and reproject each to `EPSG:32633` — three ways. `run_multiprocessing()` treats it as CPU work, `run_asyncio()` treats it as I/O work, and `run_hybrid()` combines them. Running all three against your own data is the fastest way to see which bottleneck dominates:

```python
#!/usr/bin/env python3
"""
Compare multiprocessing, asyncio, and a hybrid for the same raster batch:
fetch remote rasters, then reproject each to EPSG:32633.

Usage: python compare_models.py --mode hybrid --workers 4
"""
import time
import asyncio
import argparse
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

import aiohttp
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.io import MemoryFile

TARGET_CRS = "EPSG:32633"
SOURCES = [
    "https://example-bucket.s3.amazonaws.com/scene_001.tif",
    "https://example-bucket.s3.amazonaws.com/scene_002.tif",
    "https://example-bucket.s3.amazonaws.com/scene_003.tif",
    "https://example-bucket.s3.amazonaws.com/scene_004.tif",
]

def warp_bytes(raw: bytes, dst_path: Path) -> Path:
    """CPU-bound stage: reproject an in-memory raster to EPSG:32633.

    This runs the same pixel math whether it is called from a process
    worker or from an executor. It holds the CPU and does not await.
    """
    with MemoryFile(raw) as mem, mem.open() as src:
        transform, width, height = calculate_default_transform(
            src.crs, TARGET_CRS, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(crs=TARGET_CRS, transform=transform,
                       width=width, height=height, driver="GTiff")
        with rasterio.open(dst_path, "w", **profile) as dst:
            for band in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band),
                    destination=rasterio.band(dst, band),
                    src_transform=src.transform, src_crs=src.crs,
                    dst_transform=transform, dst_crs=TARGET_CRS,
                    resampling=Resampling.bilinear,
                )
    return dst_path

def fetch_sync(url: str) -> bytes:
    """Blocking read — used by the process-pool path."""
    with rasterio.open(url) as src:            # GDAL /vsicurl/ read
        return Path(src.name).read_bytes() if Path(src.name).exists() else src.read().tobytes()

# --- Model 1: multiprocessing (best when warp dominates) -----------------
def _worker(args: tuple) -> str:
    url, out_dir = args
    raw = fetch_sync(url)                       # blocks, but each process is separate
    return str(warp_bytes(raw, Path(out_dir) / f"{Path(url).stem}.tif"))

def run_multiprocessing(out_dir: Path, workers: int) -> list:
    tasks = [(url, out_dir) for url in SOURCES]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(_worker, tasks))

# --- Model 2: asyncio (best when the network read dominates) -------------
async def _fetch_async(session: aiohttp.ClientSession, url: str) -> bytes:
    async with session.get(url) as resp:       # awaits — loop runs others meanwhile
        resp.raise_for_status()
        return await resp.read()

async def run_asyncio(out_dir: Path) -> list:
    async with aiohttp.ClientSession() as session:
        raws = await asyncio.gather(*(_fetch_async(session, u) for u in SOURCES))
    # Warp runs inline here — on the single loop thread — so it is serial.
    return [str(warp_bytes(raw, out_dir / f"{Path(u).stem}.tif"))
            for raw, u in zip(raws, SOURCES)]

# --- Model 3: hybrid (async fetch + process-pool warp) -------------------
async def run_hybrid(out_dir: Path, workers: int) -> list:
    loop = asyncio.get_running_loop()
    async with aiohttp.ClientSession() as session:
        raws = await asyncio.gather(*(_fetch_async(session, u) for u in SOURCES))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        # run_in_executor offloads each CPU-bound warp to a real process
        # while the event loop stays free to keep other awaits moving.
        futures = [
            loop.run_in_executor(pool, warp_bytes, raw,
                                 out_dir / f"{Path(u).stem}.tif")
            for raw, u in zip(raws, SOURCES)
        ]
        return [str(p) for p in await asyncio.gather(*futures)]

def main() -> None:
    parser = argparse.ArgumentParser(description="Compare concurrency models")
    parser.add_argument("--mode", choices=["mp", "asyncio", "hybrid"], default="hybrid")
    parser.add_argument("--out", type=Path, default=Path("./out"))
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    start = time.perf_counter()
    if args.mode == "mp":
        results = run_multiprocessing(args.out, args.workers)
    elif args.mode == "asyncio":
        results = asyncio.run(run_asyncio(args.out))
    else:
        results = asyncio.run(run_hybrid(args.out, args.workers))
    elapsed = time.perf_counter() - start

    print(f"mode={args.mode} files={len(results)} elapsed={elapsed:.2f}s")

if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`warp_bytes()` is the CPU-bound core** — It runs identical rasterio reprojection math regardless of caller. Isolating it as a plain function is what lets the hybrid path hand it to a process pool with `loop.run_in_executor(pool, warp_bytes, ...)` without any async plumbing inside the warp itself.

2. **`_fetch_async()` awaits the socket** — `async with session.get(url)` yields control back to the event loop while bytes travel over the network. This is the exact moment asyncio pays off: the loop starts the next fetch instead of blocking, so hundreds of reads overlap on one thread.

3. **`run_asyncio()` warps inline and stays serial** — After the concurrent fetch, the warp loop runs on the single event-loop thread. This deliberately shows the trap: the I/O parallelism is real, but the CPU stage runs one file at a time at single-core speed.

4. **`run_hybrid()` splits the two bottlenecks** — Fetches fan out through `asyncio.gather`, then `loop.run_in_executor(pool, ...)` pushes each warp into a separate process. The event loop coordinates while real cores do the pixel math, so neither stage starves the other.

5. **`ProcessPoolExecutor` over `multiprocessing.Pool`** — The executor returns awaitable futures that integrate directly with `run_in_executor` and `asyncio.gather`. For pure CPU jobs either works; for the hybrid the executor is the natural bridge between the loop and the workers.

6. **`time.perf_counter()` brackets each run** — The single printed `elapsed` per mode is the whole point. Swap `--mode` across `mp`, `asyncio`, and `hybrid` on the same inputs and let the numbers, not intuition, pick the architecture.

## When to Use Which

| Model | Throughput profile | Memory cost | Complexity | Use when |
|---|---|---|---|---|
| `multiprocessing` | Scales to N cores for pixel math | High — one interpreter per worker | Low | Warp, reproject, resample, raster algebra dominate |
| `asyncio` | Scales to thousands of concurrent awaits | Low — one thread, one process | Medium | COG range reads and many small cloud fetches dominate |
| Hybrid | Saturates network and cores at once | High — pool plus loop overhead | High | A job mixes heavy reads and heavy warps |

## Named Gotcha: Using Asyncio for CPU-Bound Reprojection

The most common mistake is wrapping a reprojection in `async def` and expecting a speedup. There is none. `asyncio` runs every coroutine on a single thread inside a single process, and it can only switch tasks at an `await`. A warp never awaits — it holds the CPU inside GDAL's C code doing pixel math — so the event loop has no opportunity to interleave anything. Worse, because Python's Global Interpreter Lock serialises the bytecode around those C calls, even reaching for threads instead of the loop buys nothing for the Python-visible portion. Your "concurrent" warps execute strictly one after another at single-core speed, and you have added coroutine overhead for zero gain.

The fix is to keep the warp synchronous and move it off the loop. In the script above that is exactly what `run_hybrid()` does: `await loop.run_in_executor(pool, warp_bytes, raw, dst)` sends each reprojection to a real process in a `ProcessPoolExecutor`. The loop stays free for I/O, and the CPU stage finally runs in parallel across cores. If your job is pure warp with no meaningful I/O, skip asyncio entirely and use `run_multiprocessing()`.

## Verification

Profile which stage actually dominates before you trust any model choice. Time the fetch and the warp separately for one representative file:

```python
import time
from pathlib import Path
from compare_models import fetch_sync, warp_bytes

url = "https://example-bucket.s3.amazonaws.com/scene_001.tif"

t0 = time.perf_counter()
raw = fetch_sync(url)                       # I/O-bound segment
t1 = time.perf_counter()
warp_bytes(raw, Path("./out/probe.tif"))    # CPU-bound segment
t2 = time.perf_counter()

io_s, cpu_s = t1 - t0, t2 - t1
print(f"io={io_s:.2f}s cpu={cpu_s:.2f}s  ->", 
      "asyncio" if io_s > 2 * cpu_s else
      "multiprocessing" if cpu_s > 2 * io_s else "hybrid")
```

If the I/O segment dwarfs the CPU segment, asyncio wins; if compute dwarfs the read, multiprocessing wins; if both are large, the hybrid is worth its extra complexity. This one measurement replaces a lot of guesswork and prevents building the wrong architecture around a bottleneck that was never there.

## FAQ

<details class="faq-item">
<summary>Why does asyncio give no speedup for reprojection?</summary>

Reprojection is CPU-bound pixel math, and `asyncio` runs all coroutines on a single thread inside one process. Because the warp holds the CPU rather than awaiting I/O, the event loop cannot interleave anything, so tasks run one after another at single-core speed. A process pool is the only model that gives real parallelism for that work.
</details>

<details class="faq-item">
<summary>When should I use a hybrid of asyncio and a process pool?</summary>

Use a hybrid when a job mixes heavy network reads with heavy pixel math, such as streaming cloud-optimized GeoTIFFs and then reprojecting them. Run an `asyncio` loop to fan out the range reads and call `loop.run_in_executor` with a `ProcessPoolExecutor` to offload each warp, so both stages saturate their respective bottleneck.
</details>

<details class="faq-item">
<summary>Does multiprocessing help for reading many small cloud files?</summary>

Rarely. Processes cost real memory and startup time, and for network-bound reads each worker spends most of its life blocked on a socket. An `asyncio` loop handles thousands of concurrent awaits on one thread with far less overhead, so it usually beats a process pool for high-latency, low-CPU fetches.
</details>

<details class="faq-item">
<summary>How do I decide which model to use before writing code?</summary>

Time one representative file end to end and split the total into an I/O wait segment and a CPU compute segment. If compute dominates choose multiprocessing, if waiting dominates choose asyncio, and if both are large choose the hybrid. Measuring first prevents building the wrong architecture.
</details>

---

## Related

- [Async I/O for Raster Processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — parent guide covering event-loop patterns and CLI structure for I/O-bound raster pipelines
- [Streaming Cloud-Optimized GeoTIFFs with Async Range Requests](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/streaming-cloud-optimized-geotiffs-with-async-range-requests/) — the async range-read technique that feeds the I/O-bound side of this decision
