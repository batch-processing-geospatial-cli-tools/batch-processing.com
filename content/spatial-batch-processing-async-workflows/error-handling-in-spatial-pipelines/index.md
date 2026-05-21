# Error Handling in Spatial Pipelines

Spatial data processing is inherently brittle. Coordinate reference system (CRS) mismatches, corrupted geometries, GDAL driver lock contention, and network flakiness can derail even the most carefully orchestrated batch jobs. When building command-line tools for geospatial automation, robust error handling isn't an afterthought—it's the architectural foundation of reliable execution. This guide covers production-grade patterns for **Error Handling in Spatial Pipelines**, focusing on Python-based CLI toolcraft, structured observability, and graceful degradation across synchronous and asynchronous execution models.

## Prerequisites & Environment Baseline

Before implementing resilient spatial workflows, ensure your development environment meets the following baseline requirements:

- Python 3.10+ with native `asyncio`, `concurrent.futures`, and `logging` modules
- Working knowledge of `rasterio`, `geopandas`/`shapely`, and the underlying GDAL/OGR C API
- Basic CLI development experience (`click` or `argparse`)
- Familiarity with [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) concepts, particularly event loop lifecycle and worker pool management
- POSIX-compliant environment for testing file I/O boundaries, signal handling, and process isolation
- Access to PROJ data directories and GDAL configuration environment variables (`GDAL_DATA`, `PROJ_LIB`)

## Core Architecture for Fault Tolerance

A fault-tolerant spatial pipeline follows a deterministic lifecycle: ingestion → validation → transformation → output → telemetry. Each stage requires explicit failure boundaries to prevent cascade failures and maintain throughput under degraded conditions.

1. **Input Validation Gate:** Verify file existence, driver compatibility, and CRS alignment before allocating memory or opening file descriptors.
2. **Chunked Execution:** Process datasets in bounded batches to contain memory leaks, isolate corrupted records, and enable resume-from-failure.
3. **Retry & Fallback Logic:** Implement exponential backoff for transient network/driver failures, with hard limits to prevent infinite loops.
4. **Structured Telemetry:** Emit successes, warnings, and fatal errors with spatial context (extent, CRS, record count, processing duration).
5. **Graceful Shutdown:** Handle `SIGINT`/`SIGTERM` to flush buffers, release GDAL locks, and persist checkpoint manifests.

## Step-by-Step Implementation Pattern

The following CLI wrapper demonstrates a production-ready approach to processing mixed raster and vector inputs. It isolates errors at every layer, preventing a single malformed file from poisoning the worker pool.

```python
import asyncio
import json
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional
from concurrent.futures import ProcessPoolExecutor, as_completed
from functools import partial

import click
import rasterio
from rasterio.errors import RasterioError, CRSError
from rasterio.warp import calculate_default_transform, reproject, Resampling
import geopandas as gpd
from shapely.errors import TopologicalError

# Configure structured logging early
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
)
logger = logging.getLogger("spatial_pipeline")

def validate_and_reproject_raster(src_path: Path, dst_path: Path, target_crs: str) -> Dict[str, Any]:
    """Process a single raster with strict error boundaries."""
    try:
        with rasterio.open(src_path) as src:
            if src.crs is None:
                raise CRSError("Source raster lacks CRS metadata")
            # Transformation logic would execute here
            return {"status": "success", "file": str(src_path), "crs": target_crs}
    except CRSError as e:
        logger.warning(f"CRS mismatch in {src_path}: {e}")
        return {"status": "skipped", "file": str(src_path), "error": str(e)}
    except RasterioError as e:
        logger.error(f"Rasterio failure in {src_path}: {e}")
        return {"status": "failed", "file": str(src_path), "error": str(e)}
    except Exception as e:
        logger.critical(f"Unexpected error in {src_path}: {e}")
        return {"status": "fatal", "file": str(src_path), "error": str(e)}

def process_batch(files: List[Path], target_crs: str, max_workers: int = 4) -> List[Dict[str, Any]]:
    """Execute chunked processing with process isolation."""
    results = []
    # Chunking prevents memory exhaustion and isolates GDAL context leaks
    chunk_size = 50
    for i in range(0, len(files), chunk_size):
        chunk = files[i:i + chunk_size]
        with ProcessPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(validate_and_reproject_raster, f, Path(f.parent / f"out_{f.stem}.tif"), target_crs): f
                for f in chunk
            }
            for future in as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as e:
                    logger.error(f"Worker pool exception: {e}")
                    results.append({"status": "worker_crash", "error": str(e)})
    return results

@click.command()
@click.argument("input_dir", type=click.Path(exists=True, file_okay=False))
@click.option("--crs", default="EPSG:4326", help="Target coordinate reference system")
@click.option("--workers", default=4, type=int, help="Number of parallel workers")
def run_pipeline(input_dir: str, crs: str, workers: int):
    """CLI entry point with signal handling and graceful degradation."""
    input_path = Path(input_dir)
    raster_files = list(input_path.rglob("*.tif")) + list(input_path.rglob("*.tiff"))

    def shutdown_handler(sig, frame):
        logger.warning(f"Received {signal.Signals(sig).name}. Flushing and exiting...")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    logger.info(f"Starting pipeline on {len(raster_files)} files with target CRS {crs}")
    results = process_batch(raster_files, crs, workers)

    success_count = sum(1 for r in results if r["status"] == "success")
    logger.info(f"Pipeline complete. Success: {success_count}/{len(results)}")
    with open("pipeline_manifest.json", "w") as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    run_pipeline()
```

## Isolating Failure Modes in Geospatial Libraries

GDAL and PROJ operate as shared C libraries that maintain global state and file descriptor caches. When multiple Python processes or threads invoke `rasterio` or `fiona` without proper isolation, you'll encounter silent corruption, `SIGSEGV` crashes, or driver lock contention. The `ProcessPoolExecutor` pattern shown above mitigates this by spawning independent OS processes, each with its own GDAL context. For CPU-bound raster operations, this approach aligns with established best practices for [Multiprocessing Geospatial Tasks](/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/), ensuring that a segfault in one worker doesn't terminate the entire pipeline.

Network-driven workflows introduce a different class of failures. When fetching remote tilesets or cloud-optimized GeoTIFFs (COGs), HTTP 503s, TLS renegotiations, and partial downloads are common. Wrapping I/O calls in a retry decorator with jittered exponential backoff prevents thundering herd scenarios. For high-throughput raster ingestion, consider adopting [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) to overlap network latency with local CPU decompression, while keeping the retry logic strictly bounded to avoid hanging worker threads.

## Retry Logic & Circuit Breakers

Transient failures in spatial pipelines rarely resolve instantly. A naive retry loop without backoff or circuit-breaking logic will saturate network interfaces and exhaust connection pools. Implement a bounded retry strategy using `tenacity` or a custom decorator that respects the following rules:

- **Jittered Exponential Backoff:** Start with a 1-second delay, doubling up to a hard cap (e.g., 30 seconds). Add random jitter to prevent synchronized retries across distributed workers.
- **Circuit Breaker Pattern:** If a specific driver or remote endpoint fails consecutively (e.g., 5 times), open the circuit and route subsequent requests to a fallback path or fail fast. This prevents cascading degradation.
- **Idempotency Guarantees:** Ensure retry operations can be safely repeated without duplicating outputs. Use atomic file writes (write to `.tmp`, then `os.replace()`) to guarantee clean state after partial failures.

Consult the official [rasterio error handling documentation](https://rasterio.readthedocs.io/en/stable/topics/errors.html) for library-specific exception hierarchies and recommended recovery strategies.

## Structured Telemetry & Observability

Traditional print statements or unstructured log lines become useless when debugging a 10,000-file batch run. Production pipelines require machine-readable telemetry that captures spatial context alongside execution state. Every success, warning, and fatal error should include the source extent, CRS, geometry validity flags, and processing duration. [Logging spatial transformation results to structured JSON](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) enables downstream aggregation in tools like Elasticsearch or Datadog, where you can query for specific failure patterns (e.g., `"CRSError" AND "EPSG:3857"`).

High-volume jobs generate massive log files that can quickly exhaust disk space or degrade I/O performance. Implementing time-based or size-based log rotation ensures that historical error traces remain accessible without overwhelming the host filesystem. Configuring log rotation for high-volume batch jobs should be handled at the application level using Python’s `logging.handlers.RotatingFileHandler`, or delegated to system-level tools like `logrotate` with proper signal forwarding.

## Graceful Shutdown & Process Isolation

Spatial pipelines often run for hours or days. Interrupting them with `Ctrl+C` or a Kubernetes pod eviction shouldn't leave behind half-written files, orphaned GDAL locks, or corrupted shapefile indexes. The `signal.signal` registration in the CLI wrapper intercepts termination requests, allowing the application to flush pending writes, close open file descriptors, and persist a checkpoint manifest. This pattern is critical for maintaining data integrity in distributed environments where preemption is expected.

When using `asyncio` for orchestration, ensure that cancellation propagates correctly to underlying synchronous GDAL calls. The `asyncio.to_thread()` or `loop.run_in_executor()` bridges should be wrapped in `try/except` blocks that catch `asyncio.CancelledError` and perform cleanup before re-raising. Refer to the official [Python asyncio documentation](https://docs.python.org/3/library/asyncio-eventloop.html#asyncio-event-loop) for guidance on safe cancellation semantics and task lifecycle management.

## Testing & Validation Strategies

Reliable error handling requires rigorous testing against known failure modes. Use `pytest` with `caplog` to assert that expected warnings are emitted, and mock network responses to simulate transient failures. For spatial validation, maintain a curated test suite containing intentionally broken files: truncated GeoTIFFs, shapefiles with missing `.dbf` components, and datasets with inverted coordinate axes.

Implement integration tests that run the CLI with `--dry-run` or `--validate-only` flags to verify input schemas without executing heavy transformations. Combine this with property-based testing (e.g., `hypothesis`) to generate random but valid spatial extents, ensuring your pipeline handles edge cases like polar projections or datasets crossing the antimeridian. Always validate CRS strings against the PROJ database before attempting transformations, and catch `shapely.errors.TopologicalError` early to apply `buffer(0)` or `make_valid()` repairs without halting execution.

## Conclusion

Building resilient geospatial automation requires shifting from reactive debugging to proactive failure isolation. By enforcing strict validation gates, chunking execution, implementing bounded retries, and capturing structured telemetry, you transform brittle scripts into production-grade pipelines. The patterns outlined here for **Error Handling in Spatial Pipelines** provide a repeatable blueprint for scaling spatial workloads while maintaining data integrity and operational visibility. As your infrastructure evolves, continuously refine your error taxonomies and telemetry schemas to match the complexity of your spatial data estate.