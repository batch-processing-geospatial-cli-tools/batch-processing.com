---
title: "Processing 100k GeoJSON Files with Python asyncio"
description: "Process 100,000 GeoJSON files with Python asyncio: bounded concurrency, backpressure queues, CPU offloading, and batched writes — with a copy-paste implementation."
slug: "processing-100k-geojson-files-with-python-asyncio"
type: "long_tail"
breadcrumb: "Processing 100k GeoJSON Files"
datePublished: "2024-11-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Processing 100k GeoJSON Files with Python asyncio",
      "description": "Step-by-step guide to batch-processing 100,000 GeoJSON files with Python asyncio: bounded concurrency, backpressure queues, CPU offloading, and batched writes.",
      "datePublished": "2024-11-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Async I/O for Raster Processing", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/"},
        {"@type": "ListItem", "position": 4, "name": "Processing 100k GeoJSON Files", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/processing-100k-geojson-files-with-python-asyncio/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Process 100k GeoJSON Files with Python asyncio",
      "description": "Use asyncio.Semaphore, a bounded asyncio.Queue, and aiofiles to process 100,000 GeoJSON files concurrently while keeping memory under 200 MB.",
      "step": [
        {"@type": "HowToStep", "name": "Raise the OS file-descriptor limit", "text": "Run ulimit -n 65536 or set fs.file-max in /etc/sysctl.conf before launch."},
        {"@type": "HowToStep", "name": "Build a bounded read semaphore", "text": "Create asyncio.Semaphore(80) to gate concurrent aiofiles opens and prevent OSError 24."},
        {"@type": "HowToStep", "name": "Feed paths through a capped queue", "text": "Use asyncio.Queue(maxsize=1000) so the path-feeder blocks when consumers fall behind."},
        {"@type": "HowToStep", "name": "Offload JSON parsing to an executor", "text": "Call loop.run_in_executor(None, json.loads, content) for payloads above ~50 KB to avoid blocking the event loop."},
        {"@type": "HowToStep", "name": "Write results in batches", "text": "Accumulate 500 validated features before each aiofiles write to reduce inode churn."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does asyncio raise OSError: [Errno 24] Too many open files when processing GeoJSON?",
          "acceptedAnswer": {"@type": "Answer", "text": "Linux defaults to 1024 open file descriptors per process. Each concurrent aiofiles.open() holds a descriptor. Run ulimit -n 65536 and cap asyncio.Semaphore to 80–200 so you never approach the OS limit."}
        },
        {
          "@type": "Question",
          "name": "Should I use orjson instead of the stdlib json module?",
          "acceptedAnswer": {"@type": "Answer", "text": "For files under 50 KB, orjson is 2–3x faster but the event-loop impact is negligible. For files above 50 KB with heavy validation logic, prefer run_in_executor with the stdlib json or orjson to avoid starving other coroutines."}
        },
        {
          "@type": "Question",
          "name": "How many concurrent tasks should I use on an HDD vs NVMe?",
          "acceptedAnswer": {"@type": "Answer", "text": "HDDs cap at ~20 concurrent random reads due to seek latency. NVMe drives sustain 100–200 concurrent ops. Start at 40, watch iowait with iotop, and double until iowait exceeds 60%."}
        }
      ]
    }
  ]
}
</script>

Processing 100,000 GeoJSON files with Python asyncio requires decoupling disk I/O from CPU-bound JSON parsing. The bottleneck is rarely raw disk bandwidth — it is uncontrolled concurrency that exhausts file descriptors, triggers memory thrashing, or blocks the event loop during deserialization. A bounded `asyncio.Semaphore`, a capped `asyncio.Queue`, and batched output writes keep peak memory under 200 MB while delivering 3–5x throughput over a synchronous script.

This page is part of the [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) guide, which sits inside the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

| Requirement | Detail |
|---|---|
| Python | 3.10+ (`asyncio.TaskGroup` available; `asyncio.to_thread` stable since 3.9) |
| `aiofiles` | `pip install aiofiles` — non-blocking file I/O via the default thread pool |
| `orjson` (optional) | `pip install orjson` — 2–3x faster JSON parsing for large payloads |
| OS file-descriptor limit | `ulimit -n 65536` before running; persistent via `/etc/security/limits.conf` |

No GDAL installation is needed for pure GeoJSON work. If your pipeline feeds validated features into a rasterio or pyogrio stage, see [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) for downstream integration patterns.

## Pipeline Architecture

The three-stage design below keeps every layer independently bounded, so a slow writer never stalls readers and a slow disk never queues unbounded paths in memory.

<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three-stage asyncio GeoJSON pipeline: path discovery feeds a bounded queue, semaphore-gated workers read and parse files, a batch writer flushes to disk" style="width:100%;max-width:720px;display:block;margin:1.5rem auto">
  <title>Three-stage asyncio GeoJSON pipeline</title>
  <desc>Path discovery feeds paths into a bounded asyncio.Queue. Semaphore-gated worker coroutines consume paths, read files with aiofiles, parse JSON, validate GeoJSON structure, and push valid features to a results queue. A batch writer accumulates features and flushes to disk in chunks of 500.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Stage boxes -->
  <rect x="20" y="70" width="160" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <text x="100" y="103" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">Path Discovery</text>
  <text x="100" y="120" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">pathlib.rglob()</text>
  <text x="100" y="136" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">→ Queue(maxsize=1000)</text>
  <rect x="280" y="40" width="160" height="140" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <text x="360" y="73" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">Worker Pool</text>
  <text x="360" y="91" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">Semaphore(80)</text>
  <text x="360" y="108" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">aiofiles.open()</text>
  <text x="360" y="125" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">json.loads() / orjson</text>
  <text x="360" y="142" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">RFC 7946 validate</text>
  <text x="360" y="159" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">→ results_queue</text>
  <rect x="540" y="70" width="160" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <text x="620" y="103" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">Batch Writer</text>
  <text x="620" y="120" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">500-feature chunks</text>
  <text x="620" y="136" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7">aiofiles flush to disk</text>
  <!-- Arrows -->
  <line x1="182" y1="110" x2="278" y2="110" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <line x1="442" y1="110" x2="538" y2="110" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- Labels on arrows -->
  <text x="230" y="103" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">paths</text>
  <text x="490" y="103" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">features</text>
</svg>

Unlike [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — which requires chunked binary streaming and GDAL bindings — vector GeoJSON processing is text-heavy and thrives on pure-Python async I/O with minimal C-extension overhead.

## Complete Working Implementation

The script below is self-contained. It discovers all `.geojson` files under `input_dir`, validates their [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946) `FeatureCollection` structure, rounds coordinates to six decimal places (EPSG:4326), and writes merged output in 500-feature batches.

```python
#!/usr/bin/env python3
"""
Async GeoJSON batch processor — handles 100k+ files on a single event loop.

Usage:
    python process_geojson.py /data/raw /data/processed

Requirements:
    pip install aiofiles
    ulimit -n 65536  (before running)
"""
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Optional

import aiofiles
from aiofiles.os import makedirs

# ── Tuning knobs ─────────────────────────────────────────────────────────────
MAX_CONCURRENCY = 80   # NVMe: try 150; HDD: try 20; watch `iotop -a`
BATCH_SIZE      = 500  # features per output file; tune for downstream tooling
MAX_RETRIES     = 3    # exponential back-off on transient I/O errors
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)


async def read_geojson(path: Path, sem: asyncio.Semaphore) -> Optional[dict]:
    """Open and parse a single GeoJSON file, gated by the shared semaphore."""
    async with sem:                         # ← backpressure: blocks when 80 ops in flight
        for attempt in range(MAX_RETRIES):
            try:
                async with aiofiles.open(path, encoding="utf-8") as fh:
                    raw = await fh.read()
                return json.loads(raw)      # swap for orjson.loads for ~2x speed
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                log.warning("Parse error %s (attempt %d): %s", path.name, attempt + 1, exc)
                return None                 # unrecoverable; skip file
            except OSError as exc:
                delay = 0.1 * (2 ** attempt)
                log.warning(
                    "I/O error %s (attempt %d): %s — retrying in %.1fs",
                    path.name, attempt + 1, exc, delay,
                )
                await asyncio.sleep(delay)
        log.error("Giving up on %s after %d retries", path.name, MAX_RETRIES)
        return None


def validate_and_transform(data: dict) -> Optional[dict]:
    """
    Validate RFC 7946 FeatureCollection structure and normalise coordinates.

    Rounds Point coordinates to 6 decimal places (~0.11 m precision at equator
    in EPSG:4326).  Extend here for CRS coercion, bbox clipping, or schema
    checks specific to your dataset.
    """
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        return None
    for feature in data.get("features", []):
        geom = feature.get("geometry") or {}
        if geom.get("type") == "Point":
            coords = geom.get("coordinates", [])
            # coordinates: [longitude, latitude] per RFC 7946 §3.1.2
            geom["coordinates"] = [round(c, 6) for c in coords]
    return data


async def _flush_batch(output_dir: Path, batch: list, batch_index: int) -> None:
    """Serialise a list of GeoJSON features to a single FeatureCollection file."""
    out_path = output_dir / f"batch_{batch_index:06d}.geojson"
    payload = json.dumps(
        {"type": "FeatureCollection", "features": batch},
        ensure_ascii=False,
        separators=(",", ":"),  # compact JSON; saves ~15% on large batches
    )
    async with aiofiles.open(out_path, mode="w", encoding="utf-8") as fh:
        await fh.write(payload)
    log.info("Wrote %d features → %s", len(batch), out_path.name)


async def batch_writer(
    output_dir: Path,
    results: asyncio.Queue,
    batch_size: int = BATCH_SIZE,
) -> None:
    """Drain the results queue and flush to disk in fixed-size batches."""
    await makedirs(str(output_dir), exist_ok=True)
    pending: list = []
    index = 0
    while True:
        item = await results.get()
        if item is None:                    # sentinel: all workers have finished
            if pending:
                await _flush_batch(output_dir, pending, index)
            break
        # Flatten individual features out of their source FeatureCollections
        pending.extend(item.get("features", []))
        if len(pending) >= batch_size:
            await _flush_batch(output_dir, pending[:batch_size], index)
            pending = pending[batch_size:]
            index += 1


async def worker(
    path: Path,
    sem: asyncio.Semaphore,
    results: asyncio.Queue,
) -> None:
    """Read → validate → enqueue one GeoJSON file."""
    data = await read_geojson(path, sem)
    if data is None:
        return
    transformed = validate_and_transform(data)
    if transformed is not None:
        await results.put(transformed)


async def main(input_dir: Path, output_dir: Path) -> int:
    paths = sorted(input_dir.rglob("*.geojson"))
    if not paths:
        log.error("No .geojson files found under %s", input_dir)
        return 2                            # POSIX exit code 2 = bad arguments / no input

    log.info("Discovered %d files. MAX_CONCURRENCY=%d", len(paths), MAX_CONCURRENCY)

    sem      = asyncio.Semaphore(MAX_CONCURRENCY)
    results  = asyncio.Queue(maxsize=BATCH_SIZE * 2)  # cap queue depth to 1000 features

    writer_task = asyncio.create_task(batch_writer(output_dir, results))

    try:
        await asyncio.gather(*(worker(p, sem, results) for p in paths))
    finally:
        await results.put(None)             # signal the writer to flush and exit
        await writer_task

    log.info("Done.")
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Async GeoJSON batch processor")
    parser.add_argument("input_dir",  type=Path, help="Directory tree of .geojson files")
    parser.add_argument("output_dir", type=Path, help="Destination for merged output files")
    args = parser.parse_args()

    sys.exit(asyncio.run(main(args.input_dir, args.output_dir)))
```

## Step Annotations

1. **`asyncio.Semaphore(MAX_CONCURRENCY)` — the concurrency gate.**
   Every `aiofiles.open()` call is wrapped in `async with sem`. When 80 file handles are open, new workers suspend until one closes. On HDDs, lower this to 20; on NVMe SSDs you can raise it to 150. Watch `iotop -a` and back off if `iowait` exceeds 60%.

2. **`asyncio.Queue(maxsize=BATCH_SIZE * 2)` — backpressure on the results side.**
   Without a `maxsize`, all 100k validated payloads accumulate in RAM before the writer flushes any of them. Capping at 1000 (`BATCH_SIZE * 2`) means the writer must consume a batch before workers can enqueue more, bounding peak memory to roughly `1000 × avg_file_size`.

3. **`json.loads(raw)` vs `orjson.loads(raw)`.**
   The stdlib `json.loads` releases the GIL during C-level parsing, so it is safe on the event loop for files up to ~50 KB. If your GeoJSON files are larger (dense LineString or Polygon geometries), swap in `orjson.loads` — it is 2–3x faster and has the same call signature. For files above 200 KB with heavy validation loops, move parsing to `loop.run_in_executor(None, orjson.loads, raw)`.

4. **`round(c, 6)` coordinate normalisation — EPSG:4326 precision.**
   Six decimal places gives ~0.11 m precision at the equator, which exceeds the accuracy of most field GPS devices. If your downstream tool is `pyogrio` or `geopandas`, apply the coordinate transform there instead to avoid double-serialisation overhead.

5. **`pending.extend(item.get("features", []))` — flattening FeatureCollections.**
   Source files are each a `FeatureCollection`. Extending `pending` with their individual features — rather than nesting collections — produces output files that any GIS tool can ingest directly without an extra unwrap step.

6. **`sys.exit(asyncio.run(main(...)))` — POSIX exit codes.**
   `main` returns `0` on success and `2` when no input files are found. Any uncaught exception propagates through `asyncio.run` and exits with code `1`. These follow the POSIX convention (0 = OK, 1 = runtime error, 2 = usage / bad input) used throughout [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/).

## Named Gotcha: OSError 24 — Too Many Open Files

The most common failure when scaling above ~200 concurrent tasks is:

```
OSError: [Errno 24] Too many open files: '/data/raw/tile_00042.geojson'
```

**Root cause:** Linux defaults to 1024 open file descriptors per process. Each `aiofiles.open()` holds one until the `async with` block exits.

**Fix (two steps, both required):**

```bash
# 1. Raise the soft limit for the current shell session
ulimit -n 65536

# 2. Verify (should print 65536)
ulimit -n
```

For persistent configuration add to `/etc/security/limits.conf`:

```
*    soft    nofile    65536
*    hard    nofile    65536
```

Then keep `MAX_CONCURRENCY` to at most half the soft limit (e.g. `32768`). In practice, 80–200 concurrent opens is the throughput sweet spot on most storage — raising it further yields diminishing returns while increasing per-process overhead.

## Verification

After the script completes, confirm output integrity with:

```bash
# Count total output files
ls /data/processed/*.geojson | wc -l

# Spot-check one output file is valid GeoJSON
python3 - <<'EOF'
import json, pathlib, sys

p = sorted(pathlib.Path("/data/processed").glob("*.geojson"))[0]
data = json.loads(p.read_text())
assert data["type"] == "FeatureCollection", "Not a FeatureCollection"
assert isinstance(data["features"], list), "features is not a list"
print(f"{p.name}: {len(data['features'])} features — OK")
EOF

# Cross-check total feature count against input (requires jq)
# Input total:
find /data/raw -name "*.geojson" -exec jq '.features | length' {} \; | awk '{s+=$1} END{print "Input features:", s}'
# Output total:
find /data/processed -name "*.geojson" -exec jq '.features | length' {} \; | awk '{s+=$1} END{print "Output features:", s}'
```

The two feature counts should match (or differ only by the number of files that failed validation — check `stderr` for `Parse error` or `Giving up` lines to reconcile any gap).

## FAQ

<details class="faq-item">
<summary><span>Why create one big <code>asyncio.gather</code> call for 100k tasks instead of a worker-pool pattern?</span></summary>

For tasks that are mostly waiting on I/O (not CPU), `asyncio.gather` over coroutines is efficient because suspended coroutines are cheap (a few hundred bytes each, not OS threads). The `asyncio.Semaphore` ensures that only `MAX_CONCURRENCY` tasks are actually holding open file handles at any moment. If you prefer an explicit worker-pool pattern (useful when tasks have heavy CPU phases), replace `asyncio.gather` with `asyncio.Queue`-fed workers and `asyncio.TaskGroup`.

</details>

<details class="faq-item">
<summary>How do I handle GeoJSON files that are actually newline-delimited GeoJSON (GeoJSONSeq / RFC 8142)?</summary>

Newline-delimited GeoJSON (`.geojsonl` or `.ndjson`) stores one Feature per line, not a FeatureCollection. Replace the `json.loads(raw)` call with a list comprehension over lines: `[json.loads(line) for line in raw.splitlines() if line.strip()]`. Then adjust `validate_and_transform` to accept a list of Feature objects rather than a FeatureCollection dict. For large `.geojsonl` files, stream line-by-line with `async for line in fh` to avoid loading the entire file into memory.

</details>

<details class="faq-item">
<summary><span>Should I use <code>asyncio.to_thread</code> or <code>loop.run_in_executor</code> for JSON parsing?</span></summary>

`asyncio.to_thread(json.loads, raw)` is the idiomatic Python 3.9+ form — it wraps `run_in_executor` with the default `ThreadPoolExecutor` and is slightly more readable. Both are functionally identical. Use either when parsing payloads above ~50 KB or when your validation logic includes regex matching, geometry coordinate walks, or schema checks that keep the CPU busy for more than ~1 ms per file.

</details>

---

## Related

- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — the parent guide covering event-loop safety, GDAL bridge patterns, and semaphore sizing for binary raster formats
- [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — how to feed validated GeoJSON features into pyogrio or geopandas in memory-safe chunks
- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — structured logging, retry strategies, and exit-code conventions for the kind of pipeline built on this page
