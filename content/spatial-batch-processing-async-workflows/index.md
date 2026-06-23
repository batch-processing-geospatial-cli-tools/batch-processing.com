---
title: "Spatial Batch Processing & Async Workflows"
description: "Python GIS guide: async I/O, chunked vector reading, multiprocessing, memory management, and fault-tolerant batch pipelines for terabyte-scale spatial datasets."
slug: "spatial-batch-processing-async-workflows"
type: "pillar"
breadcrumb: "Spatial Batch Processing & Async Workflows"
datePublished: "2024-01-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Spatial Batch Processing & Async Workflows",
      "description": "Production-grade guide for Python GIS developers: async I/O, chunked vector reading, multiprocessing, memory management, and fault-tolerant batch pipelines for terabyte-scale spatial datasets.",
      "datePublished": "2024-01-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build Async Spatial Batch Pipelines in Python",
      "step": [
        {"@type": "HowToStep", "name": "Partition I/O and CPU work", "text": "Identify which pipeline stages are I/O-bound (cloud reads, network fetches) versus CPU-bound (GDAL transforms, spatial joins) and route each to the correct concurrency primitive."},
        {"@type": "HowToStep", "name": "Enforce chunk boundaries", "text": "Use block-aligned raster windows or feature-offset reads to keep per-task memory constant regardless of dataset size."},
        {"@type": "HowToStep", "name": "Implement structured error recovery", "text": "Quarantine invalid geometries and CRS mismatches into a dead-letter structure so the pipeline continues rather than halting."},
        {"@type": "HowToStep", "name": "Wire observability into the event loop", "text": "Emit structured JSON logs and progress callbacks from async tasks without blocking the event loop."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "When should I use asyncio instead of multiprocessing for spatial batch jobs?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use asyncio when the bottleneck is I/O latency—cloud storage reads, HTTP tile fetches, database queries. Use multiprocessing when GDAL or rasterio CPU transforms dominate, because the GIL blocks thread-based concurrency for C-extension work."}
        },
        {
          "@type": "Question",
          "name": "How do I prevent memory exhaustion when processing large raster files?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use block-aligned windowed reads via rasterio, enforce asyncio.Semaphore limits on concurrent open file handles, and close dataset objects explicitly in finally blocks or context managers."}
        },
        {
          "@type": "Question",
          "name": "What exit codes should a spatial batch CLI return?",
          "acceptedAnswer": {"@type": "Answer", "text": "Follow POSIX conventions: 0 for success, 1 for general runtime errors, 2 for usage/argument errors. Add domain codes: 10 for CRS mismatch, 11 for unsupported format, 12 for partial batch failure (some features processed, some quarantined)."}
        }
      ]
    }
  ]
}
</script>

# Spatial Batch Processing & Async Workflows

Modern geospatial infrastructure demands more than sequential scripts. As datasets scale into terabytes and cloud-native storage becomes the default, Python GIS developers, DevOps engineers, and internal tooling teams must transition from monolithic processing loops to orchestrated, concurrent execution models. The architectural decisions you make here — how to partition I/O and CPU work, how to bound memory across millions of features, how to survive transient failures without restarting jobs from zero — determine whether a pipeline is a research prototype or a production asset.

This guide establishes a production-grade framework for designing asynchronous geospatial pipelines. It covers concurrency boundaries, memory-safe data ingestion, fault tolerance, structured observability, and the testing discipline that makes spatial batch jobs trustworthy in automated environments.

---

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Spatial batch pipeline architecture: input sources feed the async orchestration layer, which dispatches I/O tasks and CPU tasks separately, then collects results into output sinks" style="width:100%;max-width:760px;height:auto;display:block;margin:2rem auto;">
  <title>Spatial Batch Pipeline Architecture</title>
  <desc>Diagram showing input sources (cloud object storage, vector files, tile endpoints) feeding into an async event loop orchestration layer. The event loop dispatches I/O-bound tasks directly via asyncio and CPU-bound tasks via a bounded process pool. Both converge into an output sink layer (cloud storage, database, local files) with a structured log stream emitted throughout.</desc>
  <defs>
    <style>
      .box { fill: none; stroke: currentColor; stroke-width: 1.5; rx: 6; }
      .box-fill { fill: #6366f1; fill-opacity: 0.08; stroke: #6366f1; stroke-width: 1.5; }
      .box-io { fill: #a78bfa; fill-opacity: 0.08; stroke: #a78bfa; stroke-width: 1.5; }
      .box-cpu { fill: #818cf8; fill-opacity: 0.08; stroke: #818cf8; stroke-width: 1.5; }
      .box-out { fill: #4ade80; fill-opacity: 0.08; stroke: #4ade80; stroke-width: 1.5; }
      .lbl { font-family: system-ui, sans-serif; font-size: 12px; fill: currentColor; text-anchor: middle; }
      .lbl-sm { font-family: system-ui, sans-serif; font-size: 10px; fill: currentColor; text-anchor: middle; opacity: 0.75; }
      .lbl-section { font-family: system-ui, sans-serif; font-size: 11px; fill: currentColor; text-anchor: middle; font-weight: 600; }
      .arrow { stroke: currentColor; stroke-width: 1.5; fill: none; marker-end: url(#arrowhead); opacity: 0.7; }
      .log-arrow { stroke: currentColor; stroke-width: 1; fill: none; stroke-dasharray: 4 3; marker-end: url(#arrowhead-sm); opacity: 0.5; }
    </style>
    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.7"/>
    </marker>
    <marker id="arrowhead-sm" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto">
      <polygon points="0 0, 6 2.5, 0 5" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
  <!-- Input sources -->
  <rect class="box-fill" x="10" y="60" width="140" height="36" rx="6"/>
  <text class="lbl" x="80" y="81">Cloud Object Storage</text>
  <text class="lbl-sm" x="80" y="93">S3 / GCS / Azure Blob</text>
  <rect class="box-fill" x="10" y="112" width="140" height="36" rx="6"/>
  <text class="lbl" x="80" y="133">Vector Files</text>
  <text class="lbl-sm" x="80" y="145">GeoJSON / FlatGeobuf</text>
  <rect class="box-fill" x="10" y="164" width="140" height="36" rx="6"/>
  <text class="lbl" x="80" y="183">Tile Endpoints</text>
  <text class="lbl-sm" x="80" y="195">WMS / XYZ / COG</text>
  <!-- Input label -->
  <text class="lbl-section" x="80" y="40">Input Sources</text>
  <!-- Orchestration box -->
  <rect class="box-fill" x="200" y="80" width="180" height="110" rx="8"/>
  <text class="lbl-section" x="290" y="105">Async Event Loop</text>
  <text class="lbl-sm" x="290" y="120">asyncio.run() entry point</text>
  <text class="lbl-sm" x="290" y="136">semaphore limits</text>
  <text class="lbl-sm" x="290" y="152">signal handlers (SIGINT/SIGTERM)</text>
  <text class="lbl-sm" x="290" y="168">graceful cancellation</text>
  <!-- Orchestration section label -->
  <text class="lbl-section" x="290" y="40">Orchestration Layer</text>
  <!-- I/O worker box -->
  <rect class="box-io" x="430" y="60" width="145" height="60" rx="6"/>
  <text class="lbl-section" x="502" y="83">I/O Workers</text>
  <text class="lbl-sm" x="502" y="98">asyncio.to_thread()</text>
  <text class="lbl-sm" x="502" y="112">aiohttp / aiofiles</text>
  <!-- CPU worker box -->
  <rect class="box-cpu" x="430" y="140" width="145" height="60" rx="6"/>
  <text class="lbl-section" x="502" y="163">CPU Workers</text>
  <text class="lbl-sm" x="502" y="178">ProcessPoolExecutor</text>
  <text class="lbl-sm" x="502" y="192">GDAL / rasterio</text>
  <!-- Worker section label -->
  <text class="lbl-section" x="502" y="40">Execution Workers</text>
  <!-- Output box -->
  <rect class="box-out" x="620" y="80" width="130" height="110" rx="6"/>
  <text class="lbl-section" x="685" y="105">Output Sinks</text>
  <text class="lbl-sm" x="685" y="122">Cloud storage writes</text>
  <text class="lbl-sm" x="685" y="138">Database inserts</text>
  <text class="lbl-sm" x="685" y="154">Local tile cache</text>
  <text class="lbl-sm" x="685" y="170">Dead-letter queue</text>
  <!-- Output section label -->
  <text class="lbl-section" x="685" y="40">Output Layer</text>
  <!-- Log stream box at bottom -->
  <rect class="box" x="10" y="230" width="740" height="48" rx="6" stroke-dasharray="5 3"/>
  <text class="lbl" x="380" y="250">Structured JSON Log Stream</text>
  <text class="lbl-sm" x="380" y="267">batch_id · chunk_offset · duration_ms · error_class</text>
  <!-- Arrows: inputs → orchestration -->
  <line class="arrow" x1="152" y1="78" x2="198" y2="115"/>
  <line class="arrow" x1="152" y1="130" x2="198" y2="135"/>
  <line class="arrow" x1="152" y1="182" x2="198" y2="155"/>
  <!-- Arrows: orchestration → workers -->
  <line class="arrow" x1="382" y1="110" x2="428" y2="90"/>
  <line class="arrow" x1="382" y1="160" x2="428" y2="170"/>
  <!-- Arrows: workers → output -->
  <line class="arrow" x1="577" y1="90" x2="618" y2="115"/>
  <line class="arrow" x1="577" y1="170" x2="618" y2="155"/>
  <!-- Log stream dashed arrows from layers -->
  <line class="log-arrow" x1="290" y1="192" x2="290" y2="228"/>
  <line class="log-arrow" x1="502" y1="202" x2="502" y2="228"/>
</svg>

## Foundational Principles

Effective spatial batch pipelines rest on four non-negotiable tenets. Every architectural decision below flows from one or more of these:

1. **I/O and CPU boundary isolation.** The Global Interpreter Lock (GIL) blocks pure-Python threads from running in parallel, but C extensions like GDAL can release it during computation. Know which pipeline stages are I/O-bound (cloud reads, HTTP tile fetches, database queries) and which are CPU-bound (coordinate transformations, raster algebra, topology validation). Route each to the correct primitive: `asyncio` for I/O, `ProcessPoolExecutor` for CPU.

2. **Chunk-aligned memory budgets.** Geospatial libraries allocate C-level buffers outside Python's garbage collector. A single uncontrolled raster read can exhaust RAM before Python can intervene. Enforce hard chunk boundaries — block-aligned raster windows, feature-offset vector batches — and release dataset handles explicitly. Memory usage must be predictable and bounded at all scales.

3. **Async safety for GDAL and OGR.** The GDAL documentation explicitly warns that GDAL objects are not thread-safe when shared across threads. Never pass open `rasterio.DatasetReader` objects or OGR `DataSource` objects across async tasks or process boundaries. Open datasets inside the worker, process, and close — every time.

4. **Idempotent, resumable execution.** Batch jobs run in environments where machines restart, spot instances are preempted, and networks drop. Every write must be atomic (`os.replace()` after writing to a temp path). Every job must be able to resume from the last committed checkpoint without reprocessing clean data or corrupting partial outputs.

## Architecture Overview

The pipeline's responsibilities are cleanly separated into four layers. Mixing logic across these boundaries is the leading cause of memory leaks, test brittleness, and difficult-to-reproduce failures in production.

| Layer | Responsibility | GIS-specific example |
|---|---|---|
| **Interface** | Argument parsing, config loading, early validation | `typer` command with `--crs`, `--workers`, `--config` flags; rejects invalid EPSG codes before I/O |
| **Orchestration** | Task scheduling, concurrency limits, signal handling | `asyncio` event loop with `Semaphore(max_open_files)`, `SIGTERM` handler that cancels pending tasks |
| **Execution** | I/O reads/writes and CPU computation, isolated per task | `asyncio.to_thread()` for GDAL reads; `ProcessPoolExecutor` worker for `pyproj` reprojection |
| **Observability** | Structured logging, progress tracking, dead-letter records | JSON log lines with `batch_id`, `chunk_offset`, `crs_source`, `error_class`; `rich` progress bar |

## Core Pattern 1: Async I/O Orchestration with Bounded Concurrency

The primary pattern for I/O-heavy pipelines — raster tile downloads, COG range reads, feature streaming over HTTP — is an `asyncio` event loop with a semaphore that caps concurrent open connections and file handles. GDAL calls are offloaded to threads via `asyncio.to_thread()` to avoid blocking the loop.

```python
# async_raster_pipeline.py
# Streams COG tiles from cloud storage with bounded concurrency.
# Requires: rasterio>=1.3, aiohttp>=3.9, pyproj>=3.6

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import aiohttp
import rasterio
from rasterio.windows import Window
from pyproj import CRS, Transformer

logger = logging.getLogger(__name__)

# Exit codes: 0=success, 1=runtime error, 2=usage error,
# 10=CRS mismatch, 12=partial batch failure
EXIT_SUCCESS = 0
EXIT_RUNTIME = 1
EXIT_CRS_MISMATCH = 10
EXIT_PARTIAL = 12

CHUNK_COLS = 512   # match underlying COG block size
CHUNK_ROWS = 512


async def read_window_async(
    src_path: str,
    window: Window,
    target_crs: CRS,
    sem: asyncio.Semaphore,
) -> dict:
    """
    Read one block-aligned window from a raster, reproject metadata to
    target_crs, and return a structured result dict. GDAL I/O is wrapped
    in asyncio.to_thread() to avoid blocking the event loop.
    """
    async with sem:  # bound concurrent open file handles
        def _read() -> dict:
            with rasterio.open(src_path) as ds:
                # Validate CRS before reading pixels — fail fast
                src_crs = CRS.from_user_input(ds.crs)
                if not src_crs.equals(target_crs):
                    # Log the mismatch; caller decides whether to quarantine
                    raise ValueError(
                        f"CRS mismatch: source={src_crs.to_epsg()} "
                        f"expected={target_crs.to_epsg()}"
                    )
                data = ds.read(window=window)          # numpy array
                transform = ds.window_transform(window)
            return {
                "path": src_path,
                "window": (window.col_off, window.row_off,
                           window.width, window.height),
                "shape": data.shape,
                "transform": list(transform),
            }

        # GDAL is not async-native; offload the blocking call to a thread pool
        return await asyncio.to_thread(_read)


async def process_tile_list(
    tile_paths: list[str],
    target_epsg: int,
    output_dir: Path,
    max_concurrent: int = 8,
) -> int:
    """
    Orchestrate tile reads concurrently. Returns exit code.
    Quarantines CRS mismatches into a dead-letter manifest rather than
    aborting the entire batch.
    """
    sem = asyncio.Semaphore(max_concurrent)
    target_crs = CRS.from_epsg(target_epsg)   # EPSG:4326, EPSG:32632, etc.

    # Build tasks — one per tile
    window = Window(0, 0, CHUNK_COLS, CHUNK_ROWS)  # simplified; real code iterates blocks
    tasks = [
        read_window_async(path, window, target_crs, sem)
        for path in tile_paths
    ]

    dead_letter: list[dict] = []
    results: list[dict] = []

    # asyncio.gather(return_exceptions=True) prevents one failure from
    # cancelling the remaining tasks in the batch
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    for path, outcome in zip(tile_paths, outcomes):
        if isinstance(outcome, ValueError):
            # CRS mismatch — quarantine, do not abort
            dead_letter.append({"path": path, "error": str(outcome)})
            logger.warning(
                "quarantined",
                extra={"path": path, "error_class": "CRS_MISMATCH"},
            )
        elif isinstance(outcome, Exception):
            dead_letter.append({"path": path, "error": repr(outcome)})
            logger.error(
                "unexpected_error",
                extra={"path": path, "error_class": type(outcome).__name__},
            )
        else:
            results.append(outcome)

    # Atomic write: write to tmp then os.replace() — no partial manifests
    output_dir.mkdir(parents=True, exist_ok=True)
    tmp = output_dir / ".results.tmp.json"
    tmp.write_text(json.dumps(results, indent=2))
    os.replace(tmp, output_dir / "results.json")

    if dead_letter:
        dl_tmp = output_dir / ".dead_letter.tmp.json"
        dl_tmp.write_text(json.dumps(dead_letter, indent=2))
        os.replace(dl_tmp, output_dir / "dead_letter.json")
        return EXIT_PARTIAL  # 12: some succeeded, some quarantined

    return EXIT_SUCCESS


def main() -> None:
    # In production this is a typer/click command that parses --config,
    # --epsg, --workers from CLI flags with layered config resolution
    tiles = ["s3://my-bucket/tile_0001.tif", "s3://my-bucket/tile_0002.tif"]
    code = asyncio.run(
        process_tile_list(tiles, target_epsg=4326, output_dir=Path("output/"))
    )
    sys.exit(code)
```

Key decisions annotated above:

- `asyncio.to_thread()` wraps every `rasterio.open()` call, keeping the event loop free to dispatch other I/O while GDAL blocks.
- `asyncio.Semaphore(max_concurrent)` caps open file descriptors, preventing `OSError: [Errno 24] Too many open files` in high-concurrency tiling operations.
- `asyncio.gather(return_exceptions=True)` isolates individual task failures so a single bad tile does not cancel the entire batch.
- `os.replace()` makes output writes atomic. If the process is killed mid-write the old file remains intact.

For a complete walkthrough of wrapping synchronous GDAL calls safely within an event loop, including driver thread-safety edge cases, see [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/).

## Core Pattern 2: CPU-Bound Work via ProcessPoolExecutor

When coordinate reprojection, raster algebra, or polygon topology validation dominate runtime, `asyncio` alone cannot help — the GIL serialises C-extension CPU work across threads. The solution is a `ProcessPoolExecutor` dispatched from the async event loop via `loop.run_in_executor()`. Each worker process initialises its own GDAL environment, eliminating cross-process state contamination.

```python
# cpu_worker_pipeline.py
# Reprojects a list of shapefiles to EPSG:4326 using a process pool.
# Requires: pyogrio>=0.7, pyproj>=3.6, geopandas>=0.14

import asyncio
import logging
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import geopandas as gpd
import pyogrio  # preferred over fiona for bulk vector I/O
from pyproj import CRS

logger = logging.getLogger(__name__)

TARGET_EPSG = 4326


def _reproject_worker(src_path: str, out_path: str) -> dict:
    """
    Runs inside a worker process. Each process has its own GIL and its own
    GDAL/OGR environment. Do NOT share open dataset handles with the parent.
    """
    target_crs = CRS.from_epsg(TARGET_EPSG)

    # pyogrio is significantly faster than fiona for bulk reads
    gdf: gpd.GeoDataFrame = gpd.read_file(src_path, engine="pyogrio")

    if gdf.crs is None:
        raise ValueError(f"No CRS defined in {src_path}")

    if not CRS.from_user_input(gdf.crs).equals(target_crs):
        gdf = gdf.to_crs(epsg=TARGET_EPSG)

    # Atomic write: temp file in same directory, then rename
    tmp = Path(out_path).with_suffix(".tmp.gpkg")
    gdf.to_file(tmp, driver="GPKG", engine="pyogrio")
    os.replace(tmp, out_path)

    return {
        "src": src_path,
        "out": out_path,
        "features": len(gdf),
        "crs_out": f"EPSG:{TARGET_EPSG}",
    }


async def reproject_batch(
    src_paths: list[str],
    out_dir: Path,
    max_workers: int = 4,
) -> list[dict]:
    """
    Dispatch CPU-bound reprojection tasks to a process pool from the async
    event loop. The event loop remains free to handle progress callbacks,
    log flushing, or other I/O while workers run.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_running_loop()

    with ProcessPoolExecutor(max_workers=max_workers) as pool:
        futures = [
            loop.run_in_executor(
                pool,
                _reproject_worker,
                src,
                str(out_dir / Path(src).name),
            )
            for src in src_paths
        ]
        results = await asyncio.gather(*futures, return_exceptions=True)

    successes = []
    for src, result in zip(src_paths, results):
        if isinstance(result, Exception):
            logger.error(
                "reproject_failed",
                extra={"src": src, "error": repr(result)},
            )
        else:
            successes.append(result)

    return successes


if __name__ == "__main__":
    sources = [
        "/data/parcels_utm32n.shp",
        "/data/roads_lv95.shp",
    ]
    completed = asyncio.run(
        reproject_batch(sources, out_dir=Path("/data/reprojected/"), max_workers=4)
    )
    code = 0 if len(completed) == len(sources) else 12
    sys.exit(code)
```

Annotations:

- `ProcessPoolExecutor` is created as a context manager so workers are cleanly joined on exit, even if the async task is cancelled.
- `_reproject_worker` opens its own dataset handle inside the worker process — never shared from the orchestrator.
- `pyogrio` is preferred over `fiona` here because it exposes a direct GDAL/OGR layer with significantly lower overhead per feature read. For a detailed comparison, see [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/).
- `os.replace()` guarantees atomic output — a killed worker leaves the source shapefile intact.

For benchmarks comparing `ProcessPoolExecutor` versus `asyncio.to_thread()` across raster and vector workloads, see [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/).

## Configuration & State Management

Production geospatial pipelines never run with hardcoded parameters. Chunk sizes, worker counts, CRS targets, cloud credentials, and output paths must be injectable at every level: defaults baked into the tool, project-level YAML/TOML overrides, environment variable overrides, and explicit CLI flag overrides. The precedence chain, lowest to highest, is:

```
built-in defaults → config file → environment variables → CLI flags
```

A minimal layered config loader for a spatial batch tool:

```python
# config.py
# Layered config: file (YAML) < env vars < explicit overrides.
# Requires: PyYAML>=6.0

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class BatchConfig:
    target_epsg: int = 4326
    max_workers: int = 4
    max_open_files: int = 32
    chunk_cols: int = 512
    chunk_rows: int = 512
    output_dir: Path = Path("output")
    log_format: str = "json"   # "json" | "text"


def load_config(config_path: Path | None = None) -> BatchConfig:
    cfg = BatchConfig()  # 1. built-in defaults

    # 2. Config file (YAML)
    if config_path and config_path.exists():
        with config_path.open() as fh:
            overrides = yaml.safe_load(fh) or {}
        for key, val in overrides.items():
            if hasattr(cfg, key):
                setattr(cfg, key, type(getattr(cfg, key))(val))

    # 3. Environment variables (BATCH_ prefix)
    env_map = {
        "BATCH_TARGET_EPSG": ("target_epsg", int),
        "BATCH_MAX_WORKERS": ("max_workers", int),
        "BATCH_MAX_OPEN_FILES": ("max_open_files", int),
        "BATCH_OUTPUT_DIR": ("output_dir", Path),
        "BATCH_LOG_FORMAT": ("log_format", str),
    }
    for env_key, (attr, cast) in env_map.items():
        val = os.environ.get(env_key)
        if val is not None:
            setattr(cfg, attr, cast(val))

    return cfg
    # 4. CLI flags are applied by the typer/click command after calling
    #    load_config(); they overwrite individual fields directly.
```

For full YAML configuration patterns including schema validation and CRS override chains, see [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) in the CLI architecture guide. For managing cloud credentials and `GDAL_CACHEMAX` via environment variables, see [Environment Variable Sync](/cli-architecture-design-patterns/environment-variable-sync/).

## Observability & Error Handling

Blind execution is a production risk. Spatial batch pipelines need three observability surfaces: real-time terminal progress for operators, structured JSON logs for downstream aggregation, and exit codes that automation systems can act on.

### Exit codes

Follow POSIX conventions and extend them for the spatial domain:

| Code | Meaning |
|---|---|
| `0` | Full success — all chunks processed, all outputs committed |
| `1` | Runtime error — unhandled exception or fatal I/O failure |
| `2` | Usage error — invalid arguments, unresolvable config |
| `10` | CRS mismatch — source and target coordinate systems incompatible |
| `11` | Unsupported format — GDAL driver unavailable for the input file type |
| `12` | Partial batch failure — some tasks succeeded, some quarantined into dead-letter |

### Structured logging

Emit JSON log lines, not print statements. Each line should carry fields that let you reconstruct the pipeline state at any point in time:

```python
# logging_setup.py
# Configures structured JSON logging compatible with ELK / Datadog / CloudWatch.

import logging
import sys


class JsonFormatter(logging.Formatter):
    """Emit one JSON object per log record — machine-parseable."""

    def format(self, record: logging.LogRecord) -> str:
        import json, traceback

        doc = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "batch_id": getattr(record, "batch_id", None),
            "chunk_offset": getattr(record, "chunk_offset", None),
            "duration_ms": getattr(record, "duration_ms", None),
            "error_class": getattr(record, "error_class", None),
        }
        if record.exc_info:
            doc["traceback"] = traceback.format_exception(*record.exc_info)
        return json.dumps({k: v for k, v in doc.items() if v is not None})


def configure_logging(log_format: str = "json") -> None:
    """
    Select JSON or human-readable format based on config.
    TTY detection: if stderr is not a terminal, always use JSON regardless
    of log_format setting — automation systems expect structured output.
    """
    handler = logging.StreamHandler(sys.stderr)

    if log_format == "json" or not sys.stderr.isatty():
        handler.setFormatter(JsonFormatter())
    else:
        # Human-readable for interactive terminal sessions
        handler.setFormatter(
            logging.Formatter("%(levelname)s %(name)s %(message)s")
        )

    logging.basicConfig(level=logging.INFO, handlers=[handler])
```

### Progress tracking

For long-running jobs, integrate progress reporting from the async pipeline into a `rich` progress bar without blocking the event loop. For detailed implementation, including async-safe progress callbacks and estimated time remaining per chunk batch, see [Progress Tracking in Batch Jobs](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/).

## Testing Strategy

A well-layered pipeline is straightforward to test. Each layer can be exercised in isolation without running the full GDAL stack.

### Fixture management

Use small, representative datasets stored under `tests/data/`:

```python
# tests/conftest.py
# In-memory raster fixture using GDAL's /vsimem/ driver.
# Avoids filesystem I/O in unit tests; valid rasterio dataset.

import io
import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds


@pytest.fixture
def in_memory_raster() -> MemoryFile:
    """
    4x4 single-band raster in EPSG:4326 covering a small bbox.
    Written to a MemoryFile — no disk I/O required.
    """
    data = np.random.randint(0, 255, (1, 4, 4), dtype=np.uint8)
    transform = from_bounds(
        west=8.0, south=47.0, east=8.1, north=47.1,
        width=4, height=4,
    )
    memfile = MemoryFile()
    with memfile.open(
        driver="GTiff",
        count=1,
        dtype="uint8",
        crs=CRS.from_epsg(4326),
        transform=transform,
        width=4,
        height=4,
    ) as ds:
        ds.write(data)
    return memfile  # caller opens with memfile.open() for reads
```

### Idempotency checks

Run the same batch command twice and assert outputs are byte-identical:

```python
# tests/test_idempotency.py

import hashlib
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_reproject_idempotent(tmp_path, sample_shapefile):
    out = tmp_path / "out.gpkg"
    # First run
    run_reproject(sample_shapefile, out)
    digest_1 = sha256(out)
    # Second run — must produce identical output
    run_reproject(sample_shapefile, out)
    digest_2 = sha256(out)
    assert digest_1 == digest_2, "Reproject output is not idempotent"
```

### CRS validation tests

Assert that CRS mismatches are caught before expensive I/O begins:

```python
# tests/test_crs_validation.py

import pytest
from pyproj import CRS
from your_pipeline import validate_crs


def test_rejects_mismatched_crs():
    source_crs = CRS.from_epsg(32632)   # UTM zone 32N
    target_crs = CRS.from_epsg(4326)    # WGS84 geographic
    with pytest.raises(ValueError, match="CRS mismatch"):
        validate_crs(source_crs, target_crs, strict=True)
```

## Child Topic Guide

The following topics expand on specific problem domains within spatial batch pipelines:

- **[Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/)** — Detailed patterns for wrapping GDAL reads in `asyncio.to_thread()`, managing driver thread safety, and streaming Cloud-Optimised GeoTIFF ranges without blocking the event loop.
- **[Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/)** — When CPU-bound GDAL operations dominate, this topic covers `ProcessPoolExecutor` initialisation, per-worker GDAL environments, and benchmark comparisons against thread-based approaches.
- **[Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/)** — Offset/limit feature reads via `pyogrio`, async generator patterns for bounded feature batches, and spatial index strategies that avoid full-file scans on large GeoJSON collections.
- **[Memory Management for Large Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/)** — Techniques for memory-mapped arrays, explicit C-buffer release, `asyncio.Semaphore` limits on open file handles, and diagnosing native memory leaks in rasterio/GDAL pipelines.
- **[Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/)** — Dead-letter queue patterns, structured exception hierarchies for GIS-specific failures, and idempotent retry strategies that prevent duplicate output on reprocessing.
- **[Progress Tracking in Batch Jobs](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/)** — Async-safe `rich` progress bars, throughput metrics (features/sec, tiles/sec), ETA estimation, and checkpoint manifests that survive process restarts.

## Conclusion

Transitioning from sequential scripts to resilient geospatial tooling requires deliberate choices at every layer: isolate I/O and CPU boundaries, enforce chunk-aligned memory budgets, design for idempotent atomic writes, and wire structured observability into the event loop from the start. These are not optimisations to add later — they are the conditions under which a pipeline remains operable at terabyte scale and across the interruptions that production environments guarantee.

Start with the patterns in this guide, profile your existing scripts to locate blocking calls, introduce bounded concurrency with a `Semaphore`, then measure. Iterate toward the hybrid async/process-pool architecture outlined here, and your tooling will remain resilient, testable, and maintainable as dataset complexity grows.

---

## Related

- [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) — Argument parsing, subcommand organisation, and layered configuration for the CLI layer that drives these pipelines
- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — Deep dive into non-blocking Cloud-Optimised GeoTIFF reads and GDAL thread safety
- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — Structured exception handling, dead-letter queues, and resilient retry patterns for GIS batch jobs
- [Memory Management for Large Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) — Strategies for keeping multi-terabyte raster and point-cloud pipelines within predictable memory bounds
