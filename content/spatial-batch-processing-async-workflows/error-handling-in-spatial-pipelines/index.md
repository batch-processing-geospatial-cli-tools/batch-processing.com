---
title: "Error Handling in Spatial Pipelines"
description: "Isolate CRS mismatches, GDAL driver failures, and geometry corruption in Python GIS batch jobs — production patterns with structured telemetry and graceful shutdown."
slug: "error-handling-in-spatial-pipelines"
type: "cluster"
breadcrumb: "Error Handling in Spatial Pipelines"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Error Handling in Spatial Pipelines",
      "description": "Production patterns for isolating CRS mismatches, GDAL driver failures, and geometry corruption in Python GIS batch jobs — with structured telemetry and graceful shutdown.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Error Handling in Spatial Pipelines", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build fault-tolerant error handling for Python spatial pipelines",
      "step": [
        {"@type": "HowToStep", "name": "Gate inputs with a CRS and geometry validation pass"},
        {"@type": "HowToStep", "name": "Isolate GDAL context per worker with ProcessPoolExecutor"},
        {"@type": "HowToStep", "name": "Wrap transient I/O in bounded exponential-backoff retry"},
        {"@type": "HowToStep", "name": "Emit structured JSON telemetry with spatial context"},
        {"@type": "HowToStep", "name": "Register SIGINT/SIGTERM handlers to flush and checkpoint on shutdown"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does rasterio raise a CPLE_AppDefined error inside a multiprocessing worker?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "GDAL's global error handler is not fork-safe. Each worker process must call gdal.UseExceptions() and reset the error handler after the fork, or the C-level state inherited from the parent can fire spurious callbacks. Use the configure_gdal_for_worker() guard shown in the implementation section."
          }
        },
        {
          "@type": "Question",
          "name": "When should I use CancelledError vs a custom sentinel in asyncio pipelines?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Raise asyncio.CancelledError for cooperative cancellation triggered by the event loop (e.g. task.cancel()). Use a custom sentinel value (e.g. None in a queue) to signal producers/consumers to stop when you are coordinating shutdown yourself without actually cancelling tasks."
          }
        },
        {
          "@type": "Question",
          "name": "How do I avoid duplicate output files after a retried raster write?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Write to a .tmp file first, then call os.replace() atomically. If the worker crashes mid-write, the .tmp is left behind (detectable and removable on restart) rather than a partially-written final file that silently passes CRC checks."
          }
        },
        {
          "@type": "Question",
          "name": "What is the right exit code for a pipeline that succeeds but skips some files?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Exit 0 only when every requested file succeeded. Use exit code 1 for partial success (some files skipped or degraded), and exit code 2 for argument/configuration errors before any file is processed. This follows POSIX conventions and lets CI scripts distinguish hard failures from soft degradation."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use tenacity's retry decorator inside asyncio coroutines?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Replace @retry with @retry (async=True) or use tenacity's AsyncRetrying context manager. Wrap only the I/O-bound coroutine — never the CPU-bound function dispatched via asyncio.to_thread(), or you risk retrying the thread dispatch itself rather than the actual network call."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR:** Wrap each spatial operation in an explicit failure boundary — validate CRS before opening file descriptors, isolate GDAL context per process, retry transient I/O with jittered backoff, and emit machine-readable telemetry that includes extent, CRS, and duration alongside the error message.

## Prerequisites

This page is part of the [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) guide. Before continuing, you should have:

- Python 3.10+ (`asyncio`, `concurrent.futures`, `logging`, `signal` from the standard library)
- `rasterio`, `geopandas`, `shapely`, and `pyogrio` installed; GDAL ≥ 3.4 on the `PATH`
- `click` or `typer` for CLI wiring; `tenacity` for retry logic
- `GDAL_DATA` and `PROJ_LIB` pointing at valid data directories
- A working mental model of the event loop from [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — the cancellation and retry patterns below build on those foundations

```bash
pip install rasterio geopandas shapely pyogrio click tenacity
```

## Problem Framing

A spatial pipeline that processes 20,000 GeoTIFFs overnight will encounter at least a dozen distinct failure modes before sunrise: a source file with no CRS metadata, a GDAL driver that silently locks and never releases, a cloud-optimized GeoTIFF that returns HTTP 503 mid-read, a geometry whose ring orientation violates OGC simple-feature rules, and a worker process that segfaults from PROJ's C-layer state inherited across a fork boundary.

None of these are programming errors. They are environmental realities of production GIS work. The only resilient approach is to treat each file as an independent unit of failure, isolate its damage radius, and record enough spatial context to diagnose it without rerunning the entire batch.

## Pipeline Failure Architecture

The diagram below maps each failure class to the layer where it must be caught, and shows how the four containment strategies — validation gate, process isolation, retry envelope, and checkpoint flush — compose into a single fault-tolerant pipeline.

<svg viewBox="0 0 820 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Error handling architecture diagram showing four containment layers in a spatial pipeline" style="width:100%;max-width:820px;font-family:inherit;">
  <title>Spatial pipeline error containment layers</title>
  <desc>Four horizontal layers: Input Validation Gate, Process Isolation, Retry Envelope, and Checkpoint Flush. Each layer lists the failure classes it catches and the action it takes.</desc>
  <defs>
    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
  <!-- Background lanes -->
  <rect x="10" y="10" width="800" height="80" rx="8" fill="currentColor" opacity="0.06"/>
  <rect x="10" y="105" width="800" height="80" rx="8" fill="currentColor" opacity="0.04"/>
  <rect x="10" y="200" width="800" height="80" rx="8" fill="currentColor" opacity="0.06"/>
  <rect x="10" y="295" width="800" height="80" rx="8" fill="currentColor" opacity="0.04"/>
  <!-- Layer labels (left column) -->
  <text x="30" y="44" font-size="12" font-weight="700" fill="currentColor" opacity="0.85">1. Input Validation Gate</text>
  <text x="30" y="139" font-size="12" font-weight="700" fill="currentColor" opacity="0.85">2. Process Isolation</text>
  <text x="30" y="234" font-size="12" font-weight="700" fill="currentColor" opacity="0.85">3. Retry Envelope</text>
  <text x="30" y="329" font-size="12" font-weight="700" fill="currentColor" opacity="0.85">4. Checkpoint Flush</text>
  <!-- Catches (middle column) -->
  <text x="250" y="38" font-size="11" fill="currentColor" opacity="0.7">CRS missing/mismatched</text>
  <text x="250" y="54" font-size="11" fill="currentColor" opacity="0.7">Driver not available (GDAL_DRIVERS)</text>
  <text x="250" y="70" font-size="11" fill="currentColor" opacity="0.7">Geometry invalid (TopologicalError)</text>
  <text x="250" y="133" font-size="11" fill="currentColor" opacity="0.7">GDAL C-layer SIGSEGV / lock contention</text>
  <text x="250" y="149" font-size="11" fill="currentColor" opacity="0.7">PROJ fork-safety violations</text>
  <text x="250" y="165" font-size="11" fill="currentColor" opacity="0.7">Memory leak containment per batch</text>
  <text x="250" y="228" font-size="11" fill="currentColor" opacity="0.7">HTTP 503, TLS renegotiation, partial download</text>
  <text x="250" y="244" font-size="11" fill="currentColor" opacity="0.7">Transient GDAL VSI errors (S3, GCS, VSICURL)</text>
  <text x="250" y="323" font-size="11" fill="currentColor" opacity="0.7">SIGINT / SIGTERM / Kubernetes eviction</text>
  <text x="250" y="339" font-size="11" fill="currentColor" opacity="0.7">Partial writes, orphaned .tmp files</text>
  <!-- Actions (right column) -->
  <text x="570" y="38" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ reject / skip with structured log</text>
  <text x="570" y="54" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ exit 2 before allocating memory</text>
  <text x="570" y="70" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ apply make_valid(), re-validate</text>
  <text x="570" y="133" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ ProcessPoolExecutor (one GDAL ctx/worker)</text>
  <text x="570" y="149" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ configure_gdal_for_worker() post-fork</text>
  <text x="570" y="165" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ chunk_size=50 per executor lifetime</text>
  <text x="570" y="228" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ jittered backoff, max 3 attempts</text>
  <text x="570" y="244" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ circuit-break after 5 consecutive fails</text>
  <text x="570" y="323" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ flush buffers, os.replace() atomics</text>
  <text x="570" y="339" font-size="11" font-weight="600" fill="currentColor" opacity="0.85">→ persist pipeline_manifest.json</text>
  <!-- Vertical flow arrow -->
  <line x1="410" y1="92" x2="410" y2="103" stroke="currentColor" stroke-width="2" opacity="0.35" marker-end="url(#arrowhead)"/>
  <line x1="410" y1="187" x2="410" y2="198" stroke="currentColor" stroke-width="2" opacity="0.35" marker-end="url(#arrowhead)"/>
  <line x1="410" y1="282" x2="410" y2="293" stroke="currentColor" stroke-width="2" opacity="0.35" marker-end="url(#arrowhead)"/>
</svg>

## Step-by-Step Implementation

### Step 1 — Input Validation Gate

Before opening a single file descriptor or allocating GDAL memory, verify every input against known constraints. A failed precondition should exit immediately with code `2` and a structured error log — it is a configuration problem, not a runtime failure.

```python
import sys
import logging
from pathlib import Path
from typing import Optional

import pyogrio
import rasterio
from rasterio.crs import CRS
from rasterio.errors import CRSError
from shapely.errors import TopologicalError
from shapely.geometry import shape
from shapely.validation import make_valid

logger = logging.getLogger("spatial_pipeline.validation")


def validate_raster_input(src_path: Path, required_epsg: int) -> Optional[str]:
    """
    Return None on success or an error message string on failure.
    Never raises — all exceptions are caught and returned as messages.
    """
    if not src_path.exists():
        return f"File not found: {src_path}"

    try:
        with rasterio.open(src_path) as ds:
            if ds.crs is None:
                return f"No CRS metadata in {src_path.name}"
            source_epsg = ds.crs.to_epsg()
            if source_epsg is None:
                return f"CRS cannot be mapped to an EPSG code: {ds.crs.to_wkt()[:60]}"
            # Accept the required CRS or any CRS we can reproject from
            if ds.count == 0:
                return f"Raster has 0 bands: {src_path.name}"
    except CRSError as exc:
        return f"CRS parse error in {src_path.name}: {exc}"
    except Exception as exc:
        return f"Cannot open {src_path.name}: {exc}"

    return None  # passed validation


def validate_vector_geometry(geom_dict: dict) -> dict:
    """
    Accept a GeoJSON-style geometry dict, return a valid Shapely geometry.
    Applies make_valid() repair for TopologicalError rather than discarding.
    """
    try:
        geom = shape(geom_dict)
        if not geom.is_valid:
            geom = make_valid(geom)
        return geom
    except TopologicalError as exc:
        raise ValueError(f"Geometry repair failed: {exc}") from exc
```

Calling `validate_raster_input` for every file in a pre-flight sweep surfaces configuration errors before the expensive transformation work begins — especially important when processing remote Cloud-Optimized GeoTIFFs where the first HTTP request would otherwise happen inside a worker.

### Step 2 — Process Isolation with Correct GDAL Initialisation

GDAL maintains global C-layer state: error handlers, virtual filesystem registrations, driver caches. When Python forks a worker with `ProcessPoolExecutor`, the child inherits that state verbatim. On Linux this is often harmless; on macOS (and in some GDAL 3.5+ builds on Linux) it causes spurious `CPLE_AppDefined` callbacks and silent lock contention.

The `configure_gdal_for_worker` initialiser passed to `ProcessPoolExecutor` resets that state cleanly in every child process.

```python
import os
import signal
import json
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from osgeo import gdal
import rasterio
from rasterio.errors import RasterioError, CRSError


def configure_gdal_for_worker() -> None:
    """
    Called once per worker process immediately after fork.
    Resets GDAL/PROJ state to a known-clean baseline.
    """
    gdal.UseExceptions()
    gdal.SetConfigOption("GDAL_CACHEMAX", "256")        # 256 MB block cache per worker
    gdal.SetConfigOption("CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE", "YES")
    os.environ.setdefault("PROJ_NETWORK", "OFF")         # prevent PROJ from hitting CDN in CI


def process_single_raster(src_path: Path, out_dir: Path, target_epsg: int) -> dict[str, Any]:
    """
    Transform one raster to target_epsg.  Returns a result dict with status,
    file path, EPSG codes, duration, and any error message — never raises.
    """
    import time
    from rasterio.warp import calculate_default_transform, reproject, Resampling

    start = time.perf_counter()
    try:
        with rasterio.open(src_path) as src:
            src_crs = src.crs
            if src_crs is None:
                raise CRSError("Source has no CRS")

            dst_crs = rasterio.crs.CRS.from_epsg(target_epsg)
            transform, width, height = calculate_default_transform(
                src_crs, dst_crs, src.width, src.height, *src.bounds
            )
            profile = src.profile.copy()
            profile.update(crs=dst_crs, transform=transform, width=width, height=height)

            out_path = out_dir / f"{src_path.stem}_epsg{target_epsg}.tif"
            tmp_path = out_path.with_suffix(".tmp")

            with rasterio.open(tmp_path, "w", **profile) as dst:
                for band_idx in range(1, src.count + 1):
                    reproject(
                        source=rasterio.band(src, band_idx),
                        destination=rasterio.band(dst, band_idx),
                        src_transform=src.transform,
                        src_crs=src_crs,
                        dst_transform=transform,
                        dst_crs=dst_crs,
                        resampling=Resampling.lanczos,
                    )

            os.replace(tmp_path, out_path)  # atomic rename — safe on partial failure

        return {
            "status": "success",
            "file": str(src_path),
            "out": str(out_path),
            "src_epsg": src_crs.to_epsg(),
            "dst_epsg": target_epsg,
            "duration_s": round(time.perf_counter() - start, 3),
        }

    except CRSError as exc:
        return {"status": "skipped", "file": str(src_path), "error": str(exc),
                "duration_s": round(time.perf_counter() - start, 3)}
    except RasterioError as exc:
        return {"status": "failed", "file": str(src_path), "error": str(exc),
                "duration_s": round(time.perf_counter() - start, 3)}
    except Exception as exc:
        return {"status": "fatal", "file": str(src_path), "error": str(exc),
                "duration_s": round(time.perf_counter() - start, 3)}
    finally:
        # Clean up any leftover .tmp files from this worker
        tmp_path = out_dir / f"{src_path.stem}_epsg{target_epsg}.tmp"
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def run_batch(
    files: list[Path],
    out_dir: Path,
    target_epsg: int,
    max_workers: int = 4,
    chunk_size: int = 50,
) -> list[dict[str, Any]]:
    """
    Process files in fixed-size chunks, recycling the executor between chunks.
    Chunking bounds per-executor GDAL memory growth and keeps each chunk's
    failure radius small enough to recover from without losing the whole batch.
    """
    results: list[dict[str, Any]] = []
    out_dir.mkdir(parents=True, exist_ok=True)

    for i in range(0, len(files), chunk_size):
        chunk = files[i : i + chunk_size]
        # A fresh executor per chunk means fresh GDAL contexts — no accumulated state leak
        with ProcessPoolExecutor(
            max_workers=max_workers,
            initializer=configure_gdal_for_worker,
        ) as pool:
            futures = {
                pool.submit(process_single_raster, f, out_dir, target_epsg): f
                for f in chunk
            }
            for future in as_completed(futures):
                try:
                    results.append(future.result(timeout=300))
                except TimeoutError:
                    results.append({
                        "status": "timeout",
                        "file": str(futures[future]),
                        "error": "Worker exceeded 300 s deadline",
                    })
                except Exception as exc:
                    results.append({
                        "status": "worker_crash",
                        "file": str(futures[future]),
                        "error": str(exc),
                    })

    return results
```

For CPU-bound raster operations the `ProcessPoolExecutor` pattern aligns with the patterns described in [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/), where GDAL context isolation is equally critical for avoiding silent corruption across workers.

### Step 3 — Retry Envelope for Transient I/O

Cloud-hosted rasters — particularly VSICURL-accessed COGs on S3 or GCS — fail transiently at a meaningful rate. HTTP 503, incomplete range responses, and TLS renegotiations are all safe to retry. Permanent failures (file not found, invalid CRS, corrupt DEFLATE stream) must not be retried — they waste time and obscure the root cause.

```python
import random
import time
import logging
from typing import Callable, TypeVar

T = TypeVar("T")
logger = logging.getLogger("spatial_pipeline.retry")

_circuit_failure_counts: dict[str, int] = {}
CIRCUIT_OPEN_THRESHOLD = 5


def is_transient_error(exc: Exception) -> bool:
    """
    Classify whether an exception is worth retrying.
    Network timeouts and VSI errors are transient; CRS/geometry errors are permanent.
    """
    from rasterio.errors import CRSError
    from shapely.errors import TopologicalError

    if isinstance(exc, (CRSError, TopologicalError, ValueError)):
        return False
    msg = str(exc).lower()
    transient_signals = ("503", "timeout", "connection reset", "partial read", "ssl", "vsicurl")
    return any(sig in msg for sig in transient_signals)


def with_retry(
    fn: Callable[[], T],
    resource_key: str,
    max_attempts: int = 3,
    base_delay_s: float = 1.0,
    cap_delay_s: float = 30.0,
) -> T:
    """
    Call fn() with jittered exponential backoff.
    Opens a circuit after CIRCUIT_OPEN_THRESHOLD consecutive failures
    for the same resource_key (e.g. a remote hostname or driver name).
    """
    if _circuit_failure_counts.get(resource_key, 0) >= CIRCUIT_OPEN_THRESHOLD:
        raise RuntimeError(
            f"Circuit open for {resource_key!r}: "
            f"{_circuit_failure_counts[resource_key]} consecutive failures"
        )

    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            result = fn()
            # Reset circuit on success
            _circuit_failure_counts.pop(resource_key, None)
            return result
        except Exception as exc:
            last_exc = exc
            if not is_transient_error(exc) or attempt == max_attempts:
                _circuit_failure_counts[resource_key] = (
                    _circuit_failure_counts.get(resource_key, 0) + 1
                )
                raise

            delay = min(base_delay_s * (2 ** (attempt - 1)), cap_delay_s)
            jitter = random.uniform(0, delay * 0.25)
            logger.warning(
                "Transient error on attempt %d/%d for %s — retrying in %.1fs: %s",
                attempt, max_attempts, resource_key, delay + jitter, exc,
            )
            time.sleep(delay + jitter)

    raise last_exc  # unreachable, but satisfies type checkers
```

### Step 4 — Structured Telemetry with Spatial Context

Traditional log lines are adequate for interactive debugging but collapse under the weight of a 20,000-file batch. [Logging spatial transformation results to structured JSON](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) describes the full schema, but the minimum viable record must include the source extent, source and destination EPSG codes, processing duration, and a machine-readable status tag.

```python
import json
import logging
from pathlib import Path
from typing import Any

# Emit JSON lines to stderr so stdout stays clean for piped consumers
class JsonLineHandler(logging.Handler):
    """Write one JSON object per line — parseable by jq, Elasticsearch, Datadog."""

    def emit(self, record: logging.LogRecord) -> None:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Attach any extra spatial fields passed as keyword arguments
        for key in ("file", "src_epsg", "dst_epsg", "duration_s", "status", "extent"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)

        import sys
        print(json.dumps(payload), file=sys.stderr, flush=True)


def configure_structured_logging(log_path: Path | None = None) -> None:
    root = logging.getLogger("spatial_pipeline")
    root.setLevel(logging.DEBUG)

    # Always emit JSON lines to stderr
    root.addHandler(JsonLineHandler())

    # Optionally persist to a rotating file as well
    if log_path is not None:
        from logging.handlers import RotatingFileHandler
        fh = RotatingFileHandler(log_path, maxBytes=50 * 1024 * 1024, backupCount=5)
        fh.setFormatter(logging.Formatter(
            "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
        ))
        root.addHandler(fh)
```

### Step 5 — Graceful Shutdown and CLI Entry Point

Pulling together the validation gate, process isolation, retry envelope, and structured telemetry into a `click` CLI entry point, with `SIGINT`/`SIGTERM` handlers that flush the checkpoint manifest before exiting:

```python
import signal
import sys
import json
import logging
from pathlib import Path

import click

from .validation import validate_raster_input
from .isolation import run_batch
from .telemetry import configure_structured_logging

logger = logging.getLogger("spatial_pipeline.cli")
_manifest: list[dict] = []


def _write_manifest(path: Path) -> None:
    """Flush the in-progress manifest atomically."""
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as fh:
        json.dump(_manifest, fh, indent=2)
    import os
    os.replace(tmp, path)
    logger.info("Manifest written: %s (%d records)", path, len(_manifest))


@click.command()
@click.argument("input_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--out-dir", type=click.Path(path_type=Path), default=Path("output"),
              show_default=True, help="Directory to write reprojected rasters.")
@click.option("--epsg", default=4326, show_default=True, help="Target EPSG code.")
@click.option("--workers", default=4, show_default=True, help="Parallel worker processes.")
@click.option("--log-file", type=click.Path(path_type=Path), default=None,
              help="Optional rotating log file path.")
def reproject_batch(
    input_dir: Path,
    out_dir: Path,
    epsg: int,
    workers: int,
    log_file: Path | None,
) -> None:
    """
    Reproject all GeoTIFFs under INPUT_DIR to --epsg, writing results to --out-dir.

    Exit codes:
      0  All files processed successfully.
      1  One or more files skipped, failed, or timed out (partial success).
      2  Argument or configuration error — no files processed.
    """
    configure_structured_logging(log_file)
    manifest_path = out_dir / "pipeline_manifest.json"

    def _shutdown(sig: int, _frame: object) -> None:
        logger.warning("Received %s — flushing manifest and exiting.", signal.Signals(sig).name)
        _write_manifest(manifest_path)
        sys.exit(1)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    rasters = sorted(input_dir.rglob("*.tif")) + sorted(input_dir.rglob("*.tiff"))
    if not rasters:
        logger.error("No .tif/.tiff files found under %s", input_dir)
        sys.exit(2)

    # Pre-flight validation — reject bad inputs before touching the worker pool
    valid_files: list[Path] = []
    for f in rasters:
        err = validate_raster_input(f, epsg)
        if err:
            logger.warning("Skipping %s: %s", f.name, err,
                           extra={"file": str(f), "status": "skipped"})
            _manifest.append({"status": "skipped", "file": str(f), "error": err})
        else:
            valid_files.append(f)

    logger.info("Pre-flight complete: %d valid / %d total", len(valid_files), len(rasters))

    results = run_batch(valid_files, out_dir, epsg, workers)
    _manifest.extend(results)
    _write_manifest(manifest_path)

    success = sum(1 for r in _manifest if r["status"] == "success")
    total = len(_manifest)
    logger.info("Pipeline finished: %d/%d succeeded", success, total)

    sys.exit(0 if success == total else 1)


if __name__ == "__main__":
    reproject_batch()
```

## Configuration Integration

The pipeline respects the layered config precedence described in [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/): defaults baked into `click.option`, overridden by a YAML config file (via `--config`), then by environment variables, then by explicit flags.

Critical GDAL/PROJ options that should live in the environment layer, not hardcoded:

| Environment variable | Effect | Recommended value |
|---|---|---|
| `GDAL_CACHEMAX` | GDAL block cache in MB | `256` per worker process |
| `GDAL_MAX_DATASET_POOL_SIZE` | Open file descriptor limit | `100` |
| `CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE` | Safer remote writes | `YES` |
| `PROJ_NETWORK` | Allow PROJ CDN lookups | `OFF` in CI/offline |
| `PROJ_LIB` | Override PROJ data directory | absolute path on non-standard installs |

Set these in a `.env` file at the project root and load them with `python-dotenv` at CLI startup, before any `rasterio` or `gdal` import fires.

## Error Handling & Gotchas

**CRS missing on TIFF but present in a world file (.tfw)**  
`rasterio.open()` reads `CRS` from embedded metadata only. If your source files depend on `.prj` or `.tfw` sidecars, the `validate_raster_input` check above catches this before the worker pool sees the file. The fix is to bake the CRS into the TIFF with `gdal_edit.py -a_srs EPSG:XXXX` in a pre-processing step.

**GDAL driver availability mismatch between host and worker**  
`gdal.GetDriverByName("GPKG")` returning `None` inside a worker signals that the child process's GDAL build lacks that driver — common with conda environments where each subprocess gets a different library path. Call `gdal.AllRegister()` inside `configure_gdal_for_worker` to guarantee all drivers are registered in every child.

**`os.replace()` fails across filesystem boundaries**  
`os.replace()` is only atomic within a single filesystem mount. Writing `.tmp` to a network volume and replacing to a local path will fail. Always write both `.tmp` and the final file to the same directory, which is why `process_single_raster` constructs `tmp_path = out_dir / ...`.

**`asyncio.CancelledError` leaking through `asyncio.to_thread()`**  
When a CPU-bound rasterio function is dispatched via `asyncio.to_thread()`, cancellation of the outer coroutine does not interrupt the running thread — it raises `CancelledError` when the thread returns. Catch it and run your cleanup (flush manifest, remove `.tmp` files) before re-raising:

```python
import asyncio

async def reproject_async(src_path: Path, out_dir: Path, epsg: int) -> dict:
    try:
        return await asyncio.to_thread(process_single_raster, src_path, out_dir, epsg)
    except asyncio.CancelledError:
        # Thread may have completed; clean up any leftover tmp
        (out_dir / f"{src_path.stem}_epsg{epsg}.tmp").unlink(missing_ok=True)
        raise
```

**Chunked vector reading and partial failures**  
When iterating large vector datasets with [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/), a corrupted record mid-chunk will raise before the remaining valid records are written. Use `pyogrio.read_dataframe(path, skip_features=[bad_idx])` to skip known-bad feature indices on retry rather than abandoning the entire chunk.

## Verification

After a batch run, verify correctness at three levels:

```bash
# 1. Check the manifest for any non-success records
python - <<'PY'
import json, sys
manifest = json.load(open("output/pipeline_manifest.json"))
failures = [r for r in manifest if r["status"] != "success"]
if failures:
    for f in failures:
        print(f["status"], f["file"], f.get("error",""))
    sys.exit(1)
print(f"All {len(manifest)} files succeeded.")
PY

# 2. Spot-check output CRS with gdalinfo
gdalinfo output/my_raster_epsg4326.tif | grep -E "EPSG|Coordinate System"

# 3. Verify no .tmp files were left behind (indicates a crash mid-write)
find output/ -name "*.tmp" -print
```

Exit code from step 1 is `0` (all succeeded) or `1` (at least one failure), matching the POSIX conventions set by the CLI entry point.

For [progress tracking across long-running batches](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/), the manifest file doubles as a live checkpoint: re-reads can skip any file whose `status` is already `"success"`, enabling resume-from-failure without reprocessing completed work.

## Performance Notes

- **Worker count vs. GDAL cache:** each worker allocates `GDAL_CACHEMAX` independently. With 4 workers at 256 MB each, budget 1 GB of GDAL block cache alone — before Python heap. On memory-constrained hosts, reduce to 2 workers at 128 MB.
- **Chunk size vs. startup overhead:** smaller chunks recycle the executor more often, increasing fork/initialisation overhead. 50 files per chunk is a reasonable baseline; scale down to 10 for large COG files, up to 200 for small in-memory vector operations.
- **COG range requests and retry amplification:** each retry on a COG issues a new HTTP range request, which can trigger CDN rate limiting. Set `GDAL_HTTP_MAX_RETRY=0` and handle retries in the Python layer only — otherwise GDAL and your retry decorator both retry independently.
- **Structured JSON telemetry I/O overhead:** flushing a `JsonLineHandler` on every record adds minimal overhead (< 1 ms per record) but can become significant at > 10,000 records/second. Buffer records in memory and flush every 500 records if I/O throughput is a bottleneck.

For deeper guidance on staying within Python's memory budget across large raster mosaics, see [Memory Management for Large Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/).

## FAQ

<details class="faq-item">
<summary>Why does rasterio raise a CPLE_AppDefined error inside a multiprocessing worker?</summary>

GDAL's global error handler is not fork-safe. Each worker process must call `gdal.UseExceptions()` and reset the error handler after the fork, or the C-level state inherited from the parent can fire spurious callbacks. The `configure_gdal_for_worker()` initialiser shown in Step 2 handles this by calling `gdal.UseExceptions()` as the first action in every child process.

</details>

<details class="faq-item">
<summary>When should I use CancelledError vs a custom sentinel in asyncio pipelines?</summary>

Raise `asyncio.CancelledError` for cooperative cancellation triggered by the event loop (e.g. `task.cancel()`). Use a custom sentinel value — `None` in a `asyncio.Queue`, for example — to signal producers or consumers to stop when you are coordinating shutdown yourself without actually cancelling tasks. Mixing both mechanisms in the same pipeline leads to double-handling and missed cleanup.

</details>

<details class="faq-item">
<summary>How do I avoid duplicate output files after a retried raster write?</summary>

Write to a `.tmp` file first, then call `os.replace()` atomically. If the worker crashes mid-write, the `.tmp` is left behind and detectable on restart — rather than a partially-written final file that silently passes CRC checks. The `process_single_raster` function above uses this pattern; the `finally` block removes any leftover `.tmp` from that worker's working directory.

</details>

<details class="faq-item">
<summary>What is the right exit code when a pipeline succeeds but skips some files?</summary>

Exit `0` only when every requested file succeeded. Use exit code `1` for partial success (some files skipped or degraded), and exit code `2` for argument or configuration errors before any file is processed. This follows POSIX conventions and lets CI scripts distinguish hard failures — which should page someone — from soft degradation, which might be acceptable in production.

</details>

<details class="faq-item">
<summary>Can I use tenacity's retry decorator inside asyncio coroutines?</summary>

Yes. Use `tenacity.AsyncRetrying` as a context manager inside your coroutine, or decorate the coroutine with `@retry` after importing `tenacity`'s async-compatible `retry`. Wrap only the I/O-bound coroutine — never the `asyncio.to_thread()` call itself — or you risk retrying the thread dispatch rather than the underlying network operation.

</details>

## Related

- [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) — parent guide covering async I/O, multiprocessing, and memory management for Python GIS batch jobs
- [Logging Spatial Transformation Results to Structured JSON](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) — extend the telemetry patterns here with a full JSON schema and Elasticsearch ingestion pipeline
- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — overlap network latency with CPU decompression while keeping the retry logic bounded
- [Chunked Vector Data Reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — apply the same partial-failure isolation patterns to large vector datasets using pyogrio batch reads
