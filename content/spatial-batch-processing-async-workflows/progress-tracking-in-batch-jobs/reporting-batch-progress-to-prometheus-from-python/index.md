---
title: "Reporting Batch Progress to Prometheus from Python"
description: "Expose tiles-processed, failures, and throughput as Prometheus metrics from a long-running geospatial batch job so dashboards and alerts track progress live."
slug: "reporting-batch-progress-to-prometheus-from-python"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Progress Tracking for Batch Pipelines"
    url: "/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/"
  - label: "Reporting Batch Progress to Prometheus from Python"
    url: "/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/reporting-batch-progress-to-prometheus-from-python/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Reporting Batch Progress to Prometheus from Python

Expose progress by defining `prometheus_client` metric objects in the parent process — a `Counter` for `tiles_processed_total` and `tiles_failed_total`, a `Gauge` for `tiles_remaining` and `throughput_tiles_per_second`, and a `Histogram` for `tile_duration_seconds` — then update them as `ProcessPoolExecutor` futures complete. For a long-running daemon call `start_http_server(8000)` so Prometheus scrapes it; for a short batch push to the Pushgateway on exit. For the wider context, see the [Progress Tracking for Batch Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) guide, part of the [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install prometheus-client` (the client library, no server needed to develop)
- A raster job that already yields tiles or windows; rasterio 1.3+ if you use `Window` reads
- A running Prometheus server only for end-to-end scraping — not required to emit or `curl` the metrics locally

If you are new to why long batch runs need external observability rather than a progress bar, start with the [Progress Tracking for Batch Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) overview. The parallelism model referenced here builds on [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/).

## How Metrics Flow Out of a Multiprocess Batch

The core constraint is that the metric registry is per-process. When a `ProcessPoolExecutor` forks or spawns workers, each worker receives its own registry copy, and any increment it makes stays local — the HTTP server in the parent never sees it. The reliable pattern is to keep every metric object in the parent and update it as each future resolves, so the worker only returns a small result dict and the parent owns all counter arithmetic.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Data flow showing worker processes returning result dicts to the parent process, which updates the shared Prometheus registry that Prometheus scrapes over HTTP or that pushes to a Pushgateway" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Where metrics are updated in a multiprocess batch</title>
  <desc>Three worker processes each return a result dictionary to the parent process. Only the parent holds the Prometheus registry and updates the Counter, Gauge, and Histogram. From there Prometheus scrapes an HTTP endpoint for a daemon, or the job pushes to a Pushgateway when it is short-lived.</desc>
  <!-- Workers -->
  <rect x="20" y="30" width="150" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="95" y="54" text-anchor="middle" font-size="11" fill="currentColor">Worker 1 (own registry)</text>
  <rect x="20" y="90" width="150" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="95" y="114" text-anchor="middle" font-size="11" fill="currentColor">Worker 2 (own registry)</text>
  <rect x="20" y="150" width="150" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="95" y="174" text-anchor="middle" font-size="11" fill="currentColor">Worker 3 (own registry)</text>
  <!-- Arrows to parent -->
  <line x1="170" y1="50" x2="270" y2="100" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrp)"/>
  <line x1="170" y1="110" x2="270" y2="110" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrp)"/>
  <line x1="170" y1="170" x2="270" y2="120" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrp)"/>
  <text x="205" y="205" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">result dicts</text>
  <!-- Parent -->
  <rect x="275" y="70" width="180" height="90" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.55" stroke-width="1.4"/>
  <text x="365" y="94" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">Parent process</text>
  <text x="365" y="112" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">holds the registry</text>
  <text x="365" y="128" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">Counter / Gauge</text>
  <text x="365" y="144" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">Histogram</text>
  <!-- Split to two exposition modes -->
  <line x1="455" y1="95" x2="560" y2="55" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrp)"/>
  <line x1="455" y1="135" x2="560" y2="215" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrp)"/>
  <!-- Daemon path -->
  <rect x="560" y="30" width="140" height="52" rx="5" fill="#27ae60" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="630" y="50" text-anchor="middle" font-size="10.5" fill="currentColor">Prometheus scrapes</text>
  <text x="630" y="65" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">start_http_server</text>
  <text x="630" y="77" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">long-running daemon</text>
  <!-- Push path -->
  <rect x="560" y="188" width="140" height="52" rx="5" fill="#a78bfa" fill-opacity="0.10" stroke="#a78bfa" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="630" y="208" text-anchor="middle" font-size="10.5" fill="currentColor">Pushgateway</text>
  <text x="630" y="223" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">push_to_gateway</text>
  <text x="630" y="235" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">short-lived job</text>
  <text x="365" y="185" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">pick one exposition mode</text>
  <defs>
    <marker id="arrp" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below reprojects a directory of GeoTIFF tiles in a `ProcessPoolExecutor` and reports live progress to Prometheus. Every metric lives in the parent; workers return timing and outcome only. Toggle between the scrape endpoint and the Pushgateway with `--mode`:

```python
#!/usr/bin/env python3
"""
Batch tile reprojection with live Prometheus progress metrics.
Usage (daemon, scraped):   python tile_metrics.py ./in ./out --crs EPSG:3857 --mode serve
Usage (short job, pushed):  python tile_metrics.py ./in ./out --crs EPSG:3857 --mode push \
                                --gateway localhost:9091
"""
import sys
import time
import argparse
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

from osgeo import gdal
from prometheus_client import (
    Counter, Gauge, Histogram, CollectorRegistry,
    start_http_server, push_to_gateway,
)

gdal.UseExceptions()

# A dedicated registry keeps this job's series isolated and makes the
# Pushgateway payload deterministic. Label names are declared once here.
REGISTRY = CollectorRegistry()
LABELS = ("job", "crs")

TILES_PROCESSED = Counter(
    "tiles_processed_total", "Tiles reprojected successfully",
    LABELS, registry=REGISTRY,
)
TILES_FAILED = Counter(
    "tiles_failed_total", "Tiles that raised during reprojection",
    LABELS, registry=REGISTRY,
)
TILES_REMAINING = Gauge(
    "tiles_remaining", "Tiles not yet completed",
    LABELS, registry=REGISTRY,
)
THROUGHPUT = Gauge(
    "throughput_tiles_per_second", "Rolling completion rate",
    LABELS, registry=REGISTRY,
)
TILE_DURATION = Histogram(
    "tile_duration_seconds", "Wall-clock time to reproject one tile",
    LABELS, registry=REGISTRY,
    buckets=(0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
)

def reproject_tile(task: tuple) -> dict:
    """Runs in a WORKER process. Does not touch any metric object —
    it only measures and returns a plain dict for the parent to record."""
    src_path, dst_path, target_crs = task
    start = time.perf_counter()
    try:
        ds = gdal.Warp(str(dst_path), str(src_path), dstSRS=target_crs,
                       format="GTiff", numThreads=1)
        if ds is None:
            raise RuntimeError(f"gdal.Warp produced no output for {src_path}")
        ds = None  # trigger GDALClose() now, do not wait for GC
        return {"ok": True, "duration": time.perf_counter() - start}
    except Exception as exc:
        return {"ok": False, "duration": time.perf_counter() - start,
                "error": str(exc)}

def main() -> None:
    parser = argparse.ArgumentParser(description="Batch reproject with Prometheus metrics")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--crs", default="EPSG:4326")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--mode", choices=("serve", "push"), default="serve")
    parser.add_argument("--gateway", default="localhost:9091")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    labels = {"job": "tile_reproject", "crs": args.crs}
    tasks = [
        (src, args.output_dir / f"{src.stem}_{args.crs.split(':')[-1]}.tif", args.crs)
        for src in sorted(args.input_dir.glob("*.tif"))
    ]
    total = len(tasks)
    if total == 0:
        print(f"No .tif files in {args.input_dir}", file=sys.stderr)
        sys.exit(0)

    TILES_REMAINING.labels(**labels).set(total)

    if args.mode == "serve":
        # Long-running daemon: expose /metrics for Prometheus to scrape.
        start_http_server(args.port, registry=REGISTRY)
        print(f"Serving metrics on :{args.port}/metrics", file=sys.stderr)

    started = time.perf_counter()
    done = 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(reproject_tile, t): t for t in tasks}
        for fut in as_completed(futures):
            result = fut.result()          # metric updates happen HERE, in the parent
            TILE_DURATION.labels(**labels).observe(result["duration"])
            if result["ok"]:
                TILES_PROCESSED.labels(**labels).inc()
            else:
                TILES_FAILED.labels(**labels).inc()
            done += 1
            TILES_REMAINING.labels(**labels).set(total - done)
            THROUGHPUT.labels(**labels).set(done / (time.perf_counter() - started))

    if args.mode == "push":
        # Short-lived job: push the final snapshot before the process exits.
        push_to_gateway(args.gateway, job="tile_reproject", registry=REGISTRY)
        print(f"Pushed final metrics to {args.gateway}", file=sys.stderr)

    failed = int(TILES_FAILED.labels(**labels)._value.get())
    sys.exit(0 if failed == 0 else 12)   # 12 = partial batch failure

if __name__ == "__main__":
    main()
```

## Step Annotations

1. **A dedicated `CollectorRegistry`** — passing `registry=REGISTRY` to every metric and to `start_http_server`/`push_to_gateway` keeps this job's series isolated from the default global registry. It also makes the Pushgateway payload deterministic: only the series you declared are pushed.

2. **Label set `("job", "crs")`** — labels are declared once at construction, then bound per update with `.labels(job=..., crs=...)`. Both values come from a small fixed set, so cardinality stays bounded. Never add a per-tile path or timestamp label here.

3. **Workers return dicts, not metric calls** — `reproject_tile` runs in a separate process and deliberately touches no metric object. It measures `time.perf_counter()` around the warp and returns the outcome. All counter and gauge arithmetic happens in the parent inside the `as_completed` loop.

4. **`Histogram.observe(duration)`** — the histogram records the distribution of per-tile durations into fixed buckets, letting you query p95 tile time in Prometheus with `histogram_quantile`. The bucket boundaries are chosen to straddle the typical sub-second-to-30-second range of a warp.

5. **`Gauge.set()` for remaining and throughput** — a gauge holds an absolute point-in-time value, so `tiles_remaining` is set to `total - done` and `throughput_tiles_per_second` is set to the rolling `done / elapsed`. Counters, by contrast, only ever `inc()`.

6. **Exit code `12` on partial failure** — reading `TILES_FAILED` back and exiting `12` follows the batch convention for partial failure, so a supervising scheduler can distinguish a clean run from one with dropped tiles. Feed the per-tile error strings into [structured JSON logging](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) for the full failure record.

## Named Gotcha: Updating Metrics Inside Worker Processes

The single most common failure is incrementing counters inside the worker function and then wondering why the scraped `/metrics` endpoint never moves. Each `ProcessPoolExecutor` worker gets its own copy of the registry when it is forked or spawned, so `TILES_PROCESSED.labels(...).inc()` inside `reproject_tile` mutates a registry that only that child can see. The parent's HTTP server exposes the parent registry, which stays at zero.

There are two correct fixes. The simplest, used above, is to keep every metric object in the parent and update it as futures complete — the worker returns a plain dict. The alternative, needed when the metric must be produced deep inside worker code, is to enable `prometheus_client` multiprocess mode: set a shared `PROMETHEUS_MULTIPROC_DIR` environment variable pointing at a writable directory before any worker starts, build a `MultiProcessCollector` over that directory in the parent, and let each worker write its own `.db` files that the collector aggregates at scrape time. For most geospatial batches the parent-side aggregation is simpler and avoids the cleanup burden of stale per-PID files.

## Verification

With the job running in `serve` mode, confirm the series are live and carry the expected labels:

```bash
# The named series should appear with job and crs labels
curl -s localhost:8000/metrics | grep -E '^tiles_(processed|failed)_total|^tiles_remaining|^throughput_tiles'

# Expected shape (values will differ):
# tiles_processed_total{crs="EPSG:3857",job="tile_reproject"} 128.0
# tiles_failed_total{crs="EPSG:3857",job="tile_reproject"} 2.0
# tiles_remaining{crs="EPSG:3857",job="tile_reproject"} 70.0
# throughput_tiles_per_second{crs="EPSG:3857",job="tile_reproject"} 6.4

# Confirm the histogram buckets are populated
curl -s localhost:8000/metrics | grep '^tile_duration_seconds_bucket'
```

For a `push` run, query the Pushgateway instead: `curl -s localhost:9091/metrics | grep tiles_processed_total`. If the series are present with a non-zero value, the parent-side update path is wired correctly.

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| `/metrics` stays at zero while job runs | Counter incremented inside worker process | Update metrics in the parent as futures complete |
| Prometheus scrapes nothing | `start_http_server` never called or port blocked | Call it before the loop; check `--port` and firewall |
| Series vanish after job exits | Daemon assumed but job is short-lived | Use `--mode push` to the Pushgateway |
| Stale series linger in gateway | Pushed from a daemon that keeps re-pushing | Use scrape mode for daemons; delete the group on exit |
| Prometheus server memory spikes | Per-tile label values explode cardinality | Restrict labels to `job` and `crs` only |

## FAQ

<details class="faq-item">
<summary>Should I use the Pushgateway or an HTTP scrape endpoint?</summary>

Use `start_http_server` for a long-running daemon that lives long enough for Prometheus to scrape it on its normal interval. Use `push_to_gateway` only for short-lived batch jobs that finish and exit before the next scrape would occur. Pushing from a daemon leaves stale series in the gateway that never get cleaned up.
</details>

<details class="faq-item">
<summary>Why can't my ProcessPoolExecutor workers update the metrics directly?</summary>

Each worker process gets its own copy of the metric registry when it is forked or spawned, so increments inside a worker never reach the parent's registry that the HTTP server exposes. Update metrics from the parent as futures complete, or enable `prometheus_client` multiprocess mode with a shared `PROMETHEUS_MULTIPROC_DIR`.
</details>

<details class="faq-item">
<summary>How do I keep label cardinality under control?</summary>

Only use labels whose values come from a small fixed set, such as job name and target CRS. Never label a metric with a per-tile identifier, file path, or timestamp, because every distinct value creates a new time series and can overwhelm the Prometheus server.
</details>

<details class="faq-item">
<summary>What is the difference between a Counter and a Gauge here?</summary>

A `Counter` only ever increases and is right for cumulative totals like `tiles_processed_total`, so you take `rate()` of it in queries. A `Gauge` can go up or down and suits point-in-time values like `tiles_remaining` or `throughput_tiles_per_second` that you set to an absolute number each update.
</details>

---

## Related

- [Progress Tracking for Batch Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) — parent guide covering progress bars, checkpoints, and observability for long batch runs
- [Estimating ETA for Long-Running Raster Batch Jobs](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/estimating-eta-for-long-running-raster-batch-jobs/) — turn the same throughput signal into a remaining-time estimate
