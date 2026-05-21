# Progress Tracking in Batch Jobs

In geospatial command-line tooling, **Progress Tracking in Batch Jobs** transforms opaque, long-running spatial pipelines into transparent, monitorable workflows. When processing terabytes of satellite imagery, iterating over millions of vector features, or executing cloud-native tile generation, developers and DevOps teams require deterministic visibility into execution state. Without reliable progress instrumentation, debugging stalled processes, estimating completion windows, and orchestrating downstream dependencies becomes guesswork. This guide outlines production-ready patterns for embedding progress tracking into Python-based GIS CLI tools, with emphasis on thread-safe counters, async-compatible renderers, and state persistence.

## Environment Prerequisites

Before implementing progress instrumentation, ensure your runtime environment meets baseline stability requirements:
- **Python 3.9+**: Required for mature `asyncio` improvements, `zoneinfo` support, and `concurrent.futures` stability.
- **Geospatial I/O Libraries**: `rasterio`, `geopandas`, or `pyogrio` for reading/writing spatial formats.
- **Progress Renderers**: `tqdm>=4.65` for lightweight CLI bars, or `rich>=13.0` for rich-text, multi-column dashboards.
- **CLI Framework**: `click` or `typer` for argument parsing, subcommand routing, and signal handling.
- **Architectural Context**: Familiarity with [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) is essential, particularly how task queues, worker pools, and I/O-bound operations interact under load.

## Architectural Workflow Design

Implementing robust progress tracking follows a predictable, decoupled pipeline:
1. **Task Enumeration**: Pre-calculate or dynamically yield the total number of spatial units (tiles, features, files). Avoid hardcoding totals when working with streaming APIs or dynamically partitioned datasets.
2. **State Initialization**: Instantiate a thread-safe counter or async-compatible progress object before spawning workers.
3. **Worker Integration**: Bind progress updates to task completion callbacks. Updating the UI on every single iteration creates severe I/O bottlenecks; instead, batch updates or use rate-limited renderers.
4. **Checkpointing**: Periodically serialize completion state to disk. Geospatial jobs often run for hours or days, and fault tolerance requires recoverable state.
5. **Teardown & Reporting**: Flush logs, render final metrics, handle partial failures, and exit with appropriate POSIX status codes.

Geospatial workloads rarely distribute evenly. A single corrupted GeoTIFF, a malformed shapefile topology, or a network timeout during cloud raster fetch can stall a worker, causing naive progress indicators to freeze indefinitely. Decoupling the rendering layer from the execution layer mitigates this risk and ensures the CLI remains responsive even when underlying GDAL or rasterio operations block.

## Thread-Safe State Management

Standard `for` loops fail under concurrency. When distributing work across multiple cores or threads, shared state must be synchronized to prevent race conditions. Python’s `threading.Lock` or `multiprocessing.Value` provides the necessary guarantees. The following pattern demonstrates a production-ready integration using `rich.progress` with a `ThreadPoolExecutor` for vector file processing:

```python
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from rich.progress import Progress, BarColumn, TextColumn, TimeRemainingColumn
import geopandas as gpd
from typing import List, Tuple

# Thread-safe progress wrapper
class SafeProgress:
    def __init__(self, total: int, description: str):
        self.lock = threading.Lock()
        self.total = total
        self.completed = 0
        self.description = description

    def advance(self, n: int = 1) -> None:
        with self.lock:
            self.completed += n

    @property
    def fraction(self) -> float:
        with self.lock:
            return min(self.completed / self.total, 1.0)

def process_file_batch(file_paths: List[Path], progress: SafeProgress) -> List[Tuple[Path, bool]]:
    """Simulates heavy spatial processing with controlled progress updates."""
    results = []
    for fp in file_paths:
        try:
            # Simulate I/O + computation
            gdf = gpd.read_file(fp)
            # Perform spatial operations...
            _ = gdf.buffer(1.0)
            results.append((fp, True))
        except Exception:
            results.append((fp, False))
        finally:
            # Update progress safely after each file
            progress.advance()
    return results

def run_batch_pipeline(input_dir: str, max_workers: int = 4) -> None:
    files = list(Path(input_dir).glob("*.gpkg"))
    total = len(files)
    progress = SafeProgress(total, "Processing Vector Layers")

    # Rich UI runs in the main thread, workers update state safely
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeRemainingColumn(),
        transient=True
    ) as ui:
        task_id = ui.add_task(progress.description, total=total)
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Split work into chunks to reduce lock contention
            chunk_size = max(1, total // (max_workers * 2))
            chunks = [files[i:i + chunk_size] for i in range(0, total, chunk_size)]
            
            futures = [executor.submit(process_file_batch, chunk, progress) for chunk in chunks]
            
            for future in as_completed(futures):
                # Update UI from main thread
                ui.update(task_id, completed=progress.completed)
                # Handle exceptions if needed
                future.result()
                
        ui.update(task_id, completed=progress.total)

if __name__ == "__main__":
    run_batch_pipeline("./sample_data")
```

This architecture avoids the common pitfall of calling UI render methods from worker threads, which violates thread-safety guarantees in most terminal libraries. Instead, workers mutate a locked counter, and the main thread polls or syncs the UI at safe boundaries. For deeper concurrency patterns, see [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/), which covers process isolation, shared memory arrays, and `multiprocessing.Manager` proxies.

## Async-Compatible Progress Rendering

When pipelines rely on non-blocking I/O—such as fetching remote tiles, querying cloud-optimized GeoTIFFs, or streaming API responses—synchronous progress bars introduce unacceptable latency. `asyncio` requires progress updates to be scheduled on the event loop without blocking coroutines.

The `tqdm` library provides native async support via `tqdm.asyncio`, but custom implementations using `rich` often yield better control over multi-task dashboards. The key is to decouple the update frequency from the coroutine execution rate:

```python
import asyncio
from rich.progress import Progress, TaskID

async def async_worker(task_queue: asyncio.Queue, progress: Progress, task_id: TaskID):
    while True:
        item = await task_queue.get()
        try:
            # Simulate async raster fetch
            await asyncio.sleep(0.1)
            # Process item...
        finally:
            progress.advance(task_id)
            task_queue.task_done()

async def run_async_pipeline(total_tasks: int):
    queue = asyncio.Queue()
    for i in range(total_tasks):
        await queue.put(i)

    with Progress() as progress:
        task_id = progress.add_task("Async Raster Fetch", total=total_tasks)
        
        workers = [asyncio.create_task(async_worker(queue, progress, task_id)) for _ in range(4)]
        await queue.join()
        
        for w in workers:
            w.cancel()
```

When rendering async progress, always use `asyncio.gather` or `asyncio.wait` with proper cancellation handling. For I/O-heavy raster workflows, consult [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) to understand how connection pooling and backpressure interact with progress callbacks.

## Checkpointing and Fault Tolerance

Long-running spatial jobs fail. Network partitions, OOM kills, or manual interruptions (`SIGINT`) are inevitable. Progress tracking must extend beyond terminal rendering into persistent state management. A robust implementation serializes completion indices, failed tasks, and partial aggregates to disk at configurable intervals.

The simplest approach uses a JSON manifest or SQLite database. When the CLI restarts, it reads the manifest, skips completed tasks, and resumes from the last checkpoint. This pattern is critical for cloud-native batch execution where spot instances may terminate without warning. For a complete implementation strategy, review [Implementing checkpointing for interrupted spatial batches](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/), which covers atomic writes, idempotent task execution, and state reconciliation.

## CLI Integration and Graceful Teardown

CLI frameworks like `click` and `typer` provide built-in signal handling and context managers that simplify teardown. Always wrap progress contexts in `try...finally` blocks or use context managers to guarantee terminal state restoration.

```python
import click
import signal
import sys

@click.command()
@click.option("--input-dir", required=True, type=click.Path(exists=True))
@click.option("--workers", default=4, type=int)
def cli_pipeline(input_dir: str, workers: int):
    """CLI entrypoint with graceful shutdown."""
    def handle_interrupt(sig, frame):
        click.echo("\n⚠️  Interrupt received. Flushing progress state...")
        sys.exit(130)

    signal.signal(signal.SIGINT, handle_interrupt)
    
    try:
        run_batch_pipeline(input_dir, max_workers=workers)
        click.echo("✅ Batch completed successfully.")
    except Exception as e:
        click.echo(f"❌ Pipeline failed: {e}", err=True)
        sys.exit(1)
```

Proper teardown ensures that terminal raw mode is restored, progress bars don't leave ghost artifacts, and partial logs are flushed before exit. This is especially important when piping CLI output to log aggregators or CI/CD runners.

## Performance Optimization and Debugging

Progress instrumentation introduces measurable overhead. Updating a terminal UI involves ANSI escape sequences, buffer flushes, and context switches. In high-throughput pipelines, this overhead can degrade throughput by 10–30% if not managed.

**Optimization Strategies:**
- **Batched Updates**: Increment counters in memory and sync the UI every `N` items or every `T` seconds.
- **Conditional Rendering**: Disable progress bars in non-interactive environments (`sys.stdout.isatty()` check) or when `--quiet` flags are passed.
- **Memory-Aware Counters**: Use `array` or `numpy` for shared state when processing millions of features, avoiding Python object overhead.
- **Structured Logging**: Pair progress bars with JSON-formatted logs for downstream observability platforms (Prometheus, Datadog, ELK).

When debugging stalled jobs, attach a profiler or use `faulthandler` to dump thread states. Often, a frozen progress bar indicates a deadlock in a GDAL driver, a blocked socket, or a GIL contention issue in C-extension libraries. Refer to Python’s official [concurrent.futures documentation](https://docs.python.org/3/library/concurrent.futures.html) for executor lifecycle management and timeout handling. Additionally, the [Rich Progress API reference](https://rich.readthedocs.io/en/stable/progress.html) details advanced features like transient output, nested tasks, and custom renderables that improve CLI ergonomics.

## Conclusion

Effective progress tracking is not merely a cosmetic enhancement; it is a critical observability layer for production geospatial pipelines. By decoupling rendering from execution, enforcing thread-safe state mutations, supporting async workflows, and implementing persistent checkpointing, developers can build CLI tools that remain transparent, resilient, and debuggable under heavy load. When combined with structured logging and graceful signal handling, these patterns transform brittle batch scripts into enterprise-grade spatial infrastructure.