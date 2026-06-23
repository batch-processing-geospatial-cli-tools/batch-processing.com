---
title: "Progress Tracking for Python GIS Batch Pipelines"
description: "Progress tracking for Python GIS batch jobs: thread-safe counters, async-compatible renderers, persistent checkpointing, and graceful teardown for spatial pipelines."
slug: "progress-tracking-in-batch-jobs"
type: "cluster"
breadcrumb: "Progress Tracking in Batch Jobs"
datePublished: "2024-11-10"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Progress Tracking in Batch Jobs: Thread-Safe Patterns for Python GIS Pipelines",
      "description": "Build production-grade progress tracking for Python GIS batch jobs: thread-safe counters, async-compatible renderers, persistent checkpointing, and graceful teardown for long-running spatial pipelines.",
      "datePublished": "2024-11-10",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Progress Tracking in Batch Jobs", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement thread-safe progress tracking for Python GIS batch pipelines",
      "step": [
        {"@type": "HowToStep", "name": "Install dependencies and enumerate tasks", "text": "Install rich and tqdm, then pre-calculate total spatial units (tiles, features, or files) before spawning workers."},
        {"@type": "HowToStep", "name": "Build a thread-safe counter", "text": "Wrap a threading.Lock around an integer counter so concurrent workers can advance state without race conditions."},
        {"@type": "HowToStep", "name": "Render progress from the main thread", "text": "Drive rich.progress or tqdm exclusively from the main thread, syncing from the locked counter at safe boundaries — never from worker threads directly."},
        {"@type": "HowToStep", "name": "Attach async-compatible updates for I/O pipelines", "text": "In asyncio pipelines, call progress.advance() after each awaited task completes; the call is non-blocking and safe from coroutine context."},
        {"@type": "HowToStep", "name": "Persist checkpoint state to disk", "text": "Serialise completed indices and failed tasks to a JSON manifest at configurable intervals so long jobs can resume after interruption."},
        {"@type": "HowToStep", "name": "Verify with structured log output and exit codes", "text": "Confirm POSIX exit codes, final counts, and JSON log lines match expected totals after the batch finishes."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does updating a Rich progress bar from a worker thread cause garbled output?",
          "acceptedAnswer": {"@type": "Answer", "text": "Rich's internal live display uses a thread-safe internal lock, but calling advance() from multiple threads while the main thread is also updating causes interleaved ANSI writes. The correct pattern is to advance a plain threading.Lock-guarded counter in workers and call progress.update() from the main thread only, at safe synchronisation points such as as_completed() boundaries."}
        },
        {
          "@type": "Question",
          "name": "How often should I flush progress state to the checkpoint manifest?",
          "acceptedAnswer": {"@type": "Answer", "text": "Every 50–100 completed tasks or every 30 seconds, whichever comes first. Flushing too often (every task) turns progress into an I/O bottleneck on NFS or network-attached storage. Use an atomic write pattern: write to a .tmp file first, then os.replace() it into place so a crash never leaves a corrupt manifest."}
        },
        {
          "@type": "Question",
          "name": "Can tqdm and Rich be used together in the same pipeline?",
          "acceptedAnswer": {"@type": "Answer", "text": "Avoid mixing them in the same terminal session — both manipulate ANSI cursor positioning and will produce garbled output. Pick one renderer. Rich is preferable for multi-task dashboards with memory and throughput columns; tqdm is lighter weight and integrates with existing pandas/geopandas iteration patterns via tqdm.pandas()."}
        },
        {
          "@type": "Question",
          "name": "How do I suppress progress output when running in CI or piping to a log aggregator?",
          "acceptedAnswer": {"@type": "Answer", "text": "Check sys.stdout.isatty() at startup or test for a --quiet / NO_COLOR environment variable. Pass disable=True to tqdm or set Console(force_terminal=False) in Rich. This prevents orphaned ANSI codes in log files and avoids breaking CI log viewers."}
        },
        {
          "@type": "Question",
          "name": "What is the performance overhead of rich.progress on a high-throughput vector pipeline?",
          "acceptedAnswer": {"@type": "Answer", "text": "On a pipeline processing millions of features, calling progress.advance() on every feature adds roughly 5–15 µs per call. At 1 M features/s this is 5–15 s of overhead. Batch updates every 1 000 features (progress.advance(1000) after processing a chunk) reduces the overhead to microseconds per batch and is sufficient for accurate ETA rendering."}
        }
      ]
    }
  ]
}
</script>

Embedding visible, accurate progress state into a spatial batch job transforms a black-box process into a monitorable workflow — and is part of the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) guide on building resilient Python GIS pipelines.

## TL;DR

Decouple the rendering layer from the execution layer: workers advance a `threading.Lock`-guarded counter; the main thread drives the terminal UI. In `asyncio` pipelines, `rich.progress.advance()` is safe to call from coroutine context. Persist completion state to a JSON manifest so jobs can resume after a crash or spot-instance eviction.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.9+ | `asyncio.to_thread()` and stable `concurrent.futures` |
| `rich` | ≥ 13.0 | Multi-column progress dashboard, live display |
| `tqdm` | ≥ 4.65 | Lightweight bars, `tqdm.asyncio` support |
| `rasterio` | ≥ 1.3 | Raster I/O, windowed reads |
| `pyogrio` | ≥ 0.6 | Fast vector I/O (preferred over `fiona`) |
| `click` | ≥ 8.1 | CLI argument parsing and signal context |

```bash
pip install rich tqdm rasterio pyogrio click
python -c "import rich; print(rich.__version__)"
```

For patterns that structure multi-stage pipelines into composable subcommands, see [CLI Subcommand Organization](/cli-architecture-design-patterns/cli-subcommand-organization/), which covers how to wire progress state across nested command groups.

## Problem Framing

A synchronous loop over 10 000 GeoPackage files gives no indication of throughput, remaining time, or which file caused a stall. When a GDAL driver blocks on a corrupt geometry ring or a remote COG fetch times out, the terminal sits silent for minutes before the job either crashes or continues without explanation. Operators kill what they cannot observe.

The same pipeline with accurate progress instrumentation shows: `3 412 / 10 000 files | 47 feat/s | ETA 3 m 22 s | 12 errors`. That single line of terminal state reduces unnecessary interruptions, guides parallelism tuning, and provides the timestamp audit trail needed for post-mortems.

The core engineering challenge is that naive implementations break under concurrency. Calling `tqdm.update()` from multiple threads, writing to stdout from worker processes, or holding a display lock across a slow GDAL open all degrade throughput or produce corrupted output. The patterns below address each failure mode explicitly.

---

<svg viewBox="0 0 720 260" role="img" aria-label="Progress tracking pipeline: task enumeration feeds a locked counter, workers advance the counter, and the main thread syncs the UI and checkpoint manifest" xmlns="http://www.w3.org/2000/svg">
  <title>Progress Tracking Architecture</title>
  <desc>Data-flow diagram showing how spatial task items flow through workers that advance a thread-safe counter, while the main thread reads that counter to update the Rich terminal UI and write a JSON checkpoint manifest.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.7"/>
    </marker>
  </defs>
  <!-- Boxes -->
  <!-- Task Queue -->
  <rect x="20" y="90" width="130" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="85" y="111" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Task Queue</text>
  <text x="85" y="128" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.75">files / tiles / features</text>
  <!-- Workers -->
  <rect x="210" y="60" width="140" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="280" y="81" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Worker Pool</text>
  <text x="280" y="98" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.75">ThreadPoolExecutor</text>
  <rect x="210" y="130" width="140" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="280" y="151" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Async Workers</text>
  <text x="280" y="168" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.75">asyncio coroutines</text>
  <!-- Locked Counter -->
  <rect x="420" y="90" width="130" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.9"/>
  <text x="485" y="111" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">SafeCounter</text>
  <text x="485" y="128" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.75">threading.Lock</text>
  <!-- UI + Checkpoint -->
  <rect x="600" y="60" width="108" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="654" y="81" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Rich UI</text>
  <text x="654" y="98" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.75">main thread only</text>
  <rect x="600" y="130" width="108" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="654" y="151" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Checkpoint</text>
  <text x="654" y="168" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.75">JSON manifest</text>
  <!-- Arrows: Queue -> Workers -->
  <line x1="150" y1="110" x2="208" y2="90" stroke="currentColor" stroke-width="1.4" marker-end="url(#arrow)" opacity="0.7"/>
  <line x1="150" y1="116" x2="208" y2="148" stroke="currentColor" stroke-width="1.4" marker-end="url(#arrow)" opacity="0.7"/>
  <!-- Arrows: Workers -> Counter -->
  <line x1="350" y1="88" x2="418" y2="106" stroke="currentColor" stroke-width="1.4" marker-end="url(#arrow)" opacity="0.7"/>
  <line x1="350" y1="154" x2="418" y2="130" stroke="currentColor" stroke-width="1.4" marker-end="url(#arrow)" opacity="0.7"/>
  <!-- Arrows: Counter -> UI / Checkpoint -->
  <line x1="550" y1="104" x2="598" y2="90" stroke="currentColor" stroke-width="1.4" marker-end="url(#arrow)" opacity="0.7"/>
  <line x1="550" y1="120" x2="598" y2="148" stroke="currentColor" stroke-width="1.4" marker-end="url(#arrow)" opacity="0.7"/>
  <!-- Label: advance() -->
  <text x="384" y="80" text-anchor="middle" font-size="9" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.6">.advance()</text>
  <!-- Label: sync every N -->
  <text x="572" y="82" text-anchor="middle" font-size="9" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.6">sync / N tasks</text>
</svg>

---

## Step-by-Step Implementation

### Step 1 — Enumerate tasks before spawning workers

Pre-calculating the total before opening the worker pool gives the progress renderer an accurate denominator. Avoid deferring this calculation into the workers themselves, where race conditions can cause double-counting.

```python
from pathlib import Path
import pyogrio

def enumerate_vector_tasks(input_dir: str) -> list[Path]:
    """Return all GeoPackage files in input_dir, sorted for reproducible ordering."""
    files = sorted(Path(input_dir).glob("*.gpkg"))
    if not files:
        raise FileNotFoundError(f"No .gpkg files found in {input_dir!r}")
    return files
```

### Step 2 — Build a thread-safe counter

Python's `threading.Lock` serialises access to a shared integer. Keep the lock held for the minimum time needed — just the counter increment, not the I/O operation.

```python
import threading
from dataclasses import dataclass, field

@dataclass
class SafeCounter:
    total: int
    _completed: int = field(default=0, init=False)
    _failed: int = field(default=0, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def advance(self, failed: bool = False) -> None:
        with self._lock:
            self._completed += 1
            if failed:
                self._failed += 1

    @property
    def completed(self) -> int:
        with self._lock:
            return self._completed

    @property
    def failed(self) -> int:
        with self._lock:
            return self._failed

    @property
    def fraction(self) -> float:
        with self._lock:
            return min(self._completed / self.total, 1.0) if self.total else 0.0
```

### Step 3 — Run workers and render from the main thread

The `Rich` live display must be driven exclusively from the main thread. Workers mutate the `SafeCounter`; `as_completed()` provides the synchronisation boundary where the main thread safely reads the counter and updates the UI.

```python
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from rich.progress import (
    Progress, BarColumn, TextColumn,
    TimeRemainingColumn, MofNCompleteColumn
)
import pyogrio
import geopandas as gpd
from pathlib import Path

def _validate_one(fp: Path, counter: SafeCounter) -> tuple[Path, bool, str]:
    """Worker: open a GeoPackage, validate geometry rings, return result."""
    try:
        gdf: gpd.GeoDataFrame = pyogrio.read_dataframe(fp, use_arrow=True)
        # Buffer(0) repairs self-intersections and validates ring orientation
        gdf["geometry"] = gdf.geometry.buffer(0)
        counter.advance(failed=False)
        return (fp, True, "")
    except Exception as exc:
        counter.advance(failed=True)
        return (fp, False, str(exc))

def run_vector_validation(input_dir: str, max_workers: int = 4) -> int:
    """Validate all GeoPackage files; return POSIX exit code (0 = clean, 1 = errors)."""
    files = enumerate_vector_tasks(input_dir)
    counter = SafeCounter(total=len(files))

    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeRemainingColumn(),
        transient=False,
    ) as ui:
        task_id = ui.add_task("Validating vectors", total=len(files))

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_validate_one, fp, counter): fp for fp in files}

            for future in as_completed(futures):
                # Sync UI from main thread only — never from workers
                ui.update(task_id, completed=counter.completed)
                fp, ok, err = future.result()
                if not ok:
                    ui.console.log(f"[yellow]WARN[/yellow] {fp.name}: {err}")

        ui.update(task_id, completed=counter.total)

    failed = counter.failed
    if failed:
        print(f"{failed}/{counter.total} files failed validation.", flush=True)
        return 1
    return 0
```

### Step 4 — Async-compatible progress for I/O pipelines

When pipelines rely on [async I/O for raster processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — fetching cloud-optimized GeoTIFFs, querying feature servers, or streaming tile APIs — synchronous workers are replaced by coroutines. `rich.progress.advance()` is thread-safe and non-blocking, so it can be called directly from coroutine context without wrapping.

```python
import asyncio
import aiohttp
import rasterio
from rich.progress import Progress, TaskID
from pathlib import Path

EPSG_4326 = 4326

async def _fetch_and_validate_cog(
    session: aiohttp.ClientSession,
    url: str,
    out_dir: Path,
    progress: Progress,
    task_id: TaskID,
    semaphore: asyncio.Semaphore,
) -> tuple[str, bool]:
    """Fetch a COG URL, verify CRS is EPSG:4326, write to out_dir."""
    async with semaphore:
        try:
            async with session.get(url) as resp:
                resp.raise_for_status()
                data = await resp.read()

            dest = out_dir / Path(url).name
            dest.write_bytes(data)

            # Offload blocking GDAL open to thread pool
            def _check_crs() -> bool:
                with rasterio.open(dest) as src:
                    return src.crs and src.crs.to_epsg() == EPSG_4326

            ok = await asyncio.to_thread(_check_crs)
            progress.advance(task_id)
            return (url, ok)
        except Exception:
            progress.advance(task_id)
            return (url, False)

async def batch_fetch_cogs(urls: list[str], out_dir: Path, concurrency: int = 10) -> list[tuple[str, bool]]:
    """Fetch a list of COG URLs concurrently with a bounded semaphore."""
    out_dir.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(concurrency)

    with Progress() as progress:
        task_id = progress.add_task("Fetching COGs", total=len(urls))
        async with aiohttp.ClientSession() as session:
            tasks = [
                _fetch_and_validate_cog(session, url, out_dir, progress, task_id, semaphore)
                for url in urls
            ]
            results = await asyncio.gather(*tasks, return_exceptions=False)

    return list(results)
```

### Step 5 — Persist checkpoint state for long jobs

Geospatial jobs that process hundreds of gigabytes of imagery or millions of vector features run for hours. Spot-instance evictions, OOM kills, and manual interruptions (`SIGINT`) are routine. A checkpoint manifest written at regular intervals lets the pipeline resume from the last safe state rather than restarting from scratch. See [implementing checkpointing for interrupted spatial batches](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/) for a full treatment of atomic writes, idempotent task execution, and state reconciliation.

```python
import json
import os
import time
from pathlib import Path

CHECKPOINT_INTERVAL = 50  # tasks between writes

class CheckpointManager:
    def __init__(self, manifest_path: Path):
        self.path = manifest_path
        self._completed: set[str] = set()
        self._failed: dict[str, str] = {}
        self._since_flush = 0
        if manifest_path.exists():
            self._load()

    def _load(self) -> None:
        data = json.loads(self.path.read_text())
        self._completed = set(data.get("completed", []))
        self._failed = data.get("failed", {})

    def record(self, key: str, error: str | None = None) -> None:
        if error:
            self._failed[key] = error
        else:
            self._completed.add(key)
        self._since_flush += 1
        if self._since_flush >= CHECKPOINT_INTERVAL:
            self.flush()

    def flush(self) -> None:
        """Atomic write: tmp file then os.replace() to avoid corrupt state on crash."""
        tmp = self.path.with_suffix(".tmp")
        payload = {
            "completed": sorted(self._completed),
            "failed": self._failed,
            "flushed_at": time.time(),
        }
        tmp.write_text(json.dumps(payload, indent=2))
        os.replace(tmp, self.path)
        self._since_flush = 0

    def is_done(self, key: str) -> bool:
        return key in self._completed

    @property
    def completed_count(self) -> int:
        return len(self._completed)
```

## Configuration Integration

Progress verbosity and checkpointing behaviour should follow the site's layered config precedence: compiled defaults → YAML config file → environment variables → CLI flags. This ensures the same pipeline binary behaves correctly in an interactive developer session, a CI runner, and a headless cloud batch job.

```python
import os
import click

DEFAULTS = {
    "workers": 4,
    "checkpoint_interval": 50,
    "quiet": False,
}

@click.command()
@click.option("--input-dir", required=True, type=click.Path(exists=True))
@click.option("--workers", default=None, type=int,
              help="Override BATCH_WORKERS env var or config default.")
@click.option("--checkpoint-dir", default=".checkpoints", show_default=True,
              type=click.Path(), help="Directory for JSON manifest files.")
@click.option("--quiet", is_flag=True, default=False,
              help="Suppress progress rendering; structured logs only.")
def validate_cmd(input_dir: str, workers: int | None, checkpoint_dir: str, quiet: bool) -> None:
    """Validate all GeoPackage files in INPUT_DIR."""
    resolved_workers = workers or int(os.environ.get("BATCH_WORKERS", DEFAULTS["workers"]))
    is_tty = not quiet and os.sys.stdout.isatty()

    checkpoint = CheckpointManager(
        Path(checkpoint_dir) / "validate_manifest.json"
    )

    # Skip already-completed tasks if resuming
    all_files = enumerate_vector_tasks(input_dir)
    pending = [f for f in all_files if not checkpoint.is_done(str(f))]
    click.echo(
        f"Tasks: {len(all_files)} total, {checkpoint.completed_count} already done, "
        f"{len(pending)} pending.",
        err=True,
    )

    if is_tty:
        exit_code = run_vector_validation_with_checkpoint(
            pending, resolved_workers, checkpoint
        )
    else:
        exit_code = run_vector_validation_quiet(pending, resolved_workers, checkpoint)

    raise SystemExit(exit_code)
```

Environment variables supported:

| Variable | Default | Effect |
|---|---|---|
| `BATCH_WORKERS` | `4` | Thread/process pool size |
| `NO_COLOR` | unset | Disables ANSI output (honoured by Rich) |
| `BATCH_CHECKPOINT_DIR` | `.checkpoints` | Directory for manifest files |
| `BATCH_CHECKPOINT_INTERVAL` | `50` | Tasks between checkpoint flushes |

## Error Handling and Gotchas

### GDAL driver lock on corrupted GeoTIFF blocks a thread indefinitely

GDAL's internal error handling in certain drivers (notably GTiff and JPEG 2000) can block a worker thread for minutes when encountering a truncated file header. The symptom is a progress bar that stops advancing even though other workers are running.

Mitigation: set `GDAL_HTTP_TIMEOUT` and `GDAL_HTTP_MAX_RETRY` for remote reads, and wrap `rasterio.open()` in `concurrent.futures.wait()` with an explicit timeout:

```python
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import rasterio
from pathlib import Path

def open_with_timeout(fp: Path, timeout_s: float = 30.0):
    with ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(rasterio.open, fp)
        done, _ = wait([future], timeout=timeout_s)
        if not done:
            raise TimeoutError(f"rasterio.open timed out after {timeout_s}s: {fp}")
        return future.result()
```

### CRS mismatch silently produces wrong geometry after buffer

`geopandas.GeoDataFrame.buffer(0)` operates in the coordinate units of the current CRS. Calling it on a GeoDataFrame in geographic coordinates (EPSG:4326) produces buffers in degrees, not metres. Always re-project to a suitable projected CRS before any metric geometry operation:

```python
import pyogrio, geopandas as gpd
from pathlib import Path

def validate_and_reproject(fp: Path, target_epsg: int = 32633) -> gpd.GeoDataFrame:
    gdf: gpd.GeoDataFrame = pyogrio.read_dataframe(fp, use_arrow=True)
    if gdf.crs is None:
        raise ValueError(f"No CRS defined in {fp.name}")
    gdf = gdf.to_crs(epsg=target_epsg)    # EPSG:32633 — UTM zone 33N
    gdf["geometry"] = gdf.geometry.buffer(0)
    return gdf
```

### Progress bar leaves ghost artifacts when a worker raises an uncaught exception

If an unhandled exception escapes the `with Progress()` context manager, Rich's live display may not restore the terminal cursor. Always re-raise exceptions **after** the `with Progress()` block exits, not from inside it:

```python
# BAD — exception escapes the context manager mid-render
with Progress() as p:
    task = p.add_task("...", total=100)
    raise RuntimeError("oops")   # Rich may leave cursor hidden

# GOOD — collect exceptions and raise after the display closes
errors: list[Exception] = []
with Progress() as p:
    task = p.add_task("...", total=100)
    for future in as_completed(futures):
        try:
            future.result()
        except Exception as exc:
            errors.append(exc)
        p.advance(task)

if errors:
    raise ExceptionGroup("batch errors", errors)
```

For structured logging patterns that complement progress tracking, see [error handling in spatial pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/), which covers JSON log emission, POSIX exit codes, and retry strategies across synchronous and async execution models.

## Verification

After a batch run, confirm the implementation is working correctly at three levels:

**1. Exit code check**

```bash
python validate.py --input-dir ./sample_data --workers 4
echo "Exit: $?"
# Expected: 0 (all passed) or 1 (some failed)
```

**2. Checkpoint manifest inspection**

```bash
python -c "
import json, pathlib
m = json.loads(pathlib.Path('.checkpoints/validate_manifest.json').read_text())
print(f'Completed: {len(m[\"completed\"])}')
print(f'Failed: {len(m[\"failed\"])}')
print(f'Sample completed: {m[\"completed\"][:3]}')
"
```

**3. Structured log cross-check**

```bash
# Count ERROR lines in the JSON log and compare to manifest failed count
python -c "
import json, pathlib
lines = pathlib.Path('batch.log').read_text().splitlines()
errors = [json.loads(l) for l in lines if l.strip() and json.loads(l).get('level') == 'ERROR']
print(f'Log errors: {len(errors)}')
"
```

Expected output on a clean dataset:

```
Tasks: 500 total, 0 already done, 500 pending.
Validating vectors ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 500/500 0:00:00
Exit: 0
Completed: 500
Failed: 0
Log errors: 0
```

## Performance Notes

Progress instrumentation adds measurable overhead. At high throughput, the choices below make the difference between a negligible tax and a bottleneck:

| Pattern | Overhead | Recommendation |
|---|---|---|
| `progress.advance()` per feature | 5–15 µs per call | Batch-advance every 1 000 features |
| Checkpoint flush per task | Full JSON serialisation per task | Flush every 50–100 tasks or 30 s |
| Rendering from worker threads | ANSI write contention | Never; drive UI from main thread only |
| `tqdm` in non-TTY context | Repeated string formatting | Pass `disable=not sys.stdout.isatty()` |

For memory footprint: the `SafeCounter` above uses ~200 bytes. The `CheckpointManager` holds a Python `set` of completed keys in memory — at 1 M tasks with 64-character keys this is roughly 64 MB. For very large task counts, store completed keys in a SQLite table and query with `SELECT COUNT(*)` instead of holding the full set in a `set`.

For deeper parallelism considerations, including how to combine thread-pool progress tracking with process-based concurrency, see [memory management for large datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) and the discussion of `multiprocessing.Manager` proxies in [chunked vector data reading](/spatial-batch-processing-async-workflows/chunked-vector-data-reading/).

## FAQ

<details class="faq-item">
<summary>Why does updating a Rich progress bar from a worker thread cause garbled output?</summary>

Rich's live display uses an internal lock, but calling `advance()` from multiple worker threads while the main thread renders causes interleaved ANSI cursor writes. The correct pattern is to advance a plain `threading.Lock`-guarded counter in workers and call `progress.update()` from the main thread only, at `as_completed()` boundaries.

</details>

<details class="faq-item">
<summary>How often should I flush progress state to the checkpoint manifest?</summary>

Every 50–100 completed tasks or every 30 seconds, whichever comes first. Use an atomic write: write to a `.tmp` file first, then `os.replace()` it into place so a crash never leaves a corrupt manifest. Flushing on every task serialises I/O and negates the throughput benefit of the worker pool.

</details>

<details class="faq-item">
<summary>Can tqdm and Rich be used together in the same pipeline?</summary>

Avoid mixing them in the same terminal session — both manipulate ANSI cursor positioning and will produce garbled output. Rich is preferable for multi-task dashboards with ETA, memory, and throughput columns. `tqdm` integrates well with `pandas` iteration via `tqdm.pandas()` and is lighter weight when you need a single bar. Pick one per process.

</details>

<details class="faq-item">
<summary>How do I suppress progress output in CI or when piping to a log aggregator?</summary>

Check `sys.stdout.isatty()` at startup or honour the `NO_COLOR` environment variable. Pass `disable=True` to `tqdm`, or construct `rich.console.Console(force_terminal=False)`. This prevents orphaned ANSI codes in log files and avoids breaking CI log viewers.

</details>

<details class="faq-item">
<summary>What is the overhead of rich.progress on a high-throughput vector pipeline?</summary>

Calling `progress.advance()` on every feature costs roughly 5–15 µs. At 1 M features per second this adds 5–15 s of pure overhead. Advancing in chunks of 1 000 features — `progress.advance(1000)` after each chunk — reduces the overhead to negligible while keeping ETA rendering accurate to within a second.

</details>

## Related

- [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) — parent guide covering task queues, worker pools, and async safety across the full pipeline stack
- [Implementing checkpointing for interrupted spatial batches](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/) — atomic writes, idempotent task execution, and state reconciliation for resumable jobs
- [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) — integrating progress tracking with aiohttp + rasterio COG pipelines
- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — structured JSON logging and POSIX exit codes that complement progress state
