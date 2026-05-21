# Logging spatial transformation results to structured JSON

**Logging spatial transformation results to structured JSON** requires capturing transformation metadata, success/failure states, and geometry statistics in a machine-readable format. By configuring a custom Python `logging.Formatter` that serializes log records into JSON objects, you can attach spatial context (input/output CRS, geometry counts, bounding boxes, processing time, and error traces) directly to each log event. Piping this logger into your CLI or batch workflow ensures every spatial operation emits a deterministic, parseable record that downstream systems can ingest without regex parsing or log-shipping overhead.

## Why Structured Logs Matter for GIS Workflows

Traditional line-based logs fracture under batch spatial processing. When reprojecting thousands of vector files, clipping against administrative boundaries, or validating topology, you need queryable output. Structured JSON logs route cleanly to observability stacks like Elasticsearch, Loki, or Datadog, and provide a clear audit trail for [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/). Distinguishing between a missing CRS, an invalid geometry, and a GDAL driver timeout dictates whether a job retries, skips, or fails fast.

The implementation relies on three tightly coupled components:
1. **`JSONSpatialFormatter`**: Extracts spatial context from `LogRecord.extra` and safely serializes non-standard GIS types.
2. **Transformation Wrapper**: Computes pre/post metrics and injects them into the logger via the `extra` parameter.
3. **CLI/Workflow Router**: Routes logs to `stdout` or a file while preserving machine readability and separating operational telemetry from user-facing CLI output.

## Complete Python Implementation

The following code provides a production-ready formatter, a spatial operation wrapper, and a `click`-based CLI entry point. It handles `pathlib.Path`, `pyproj.CRS`, `shapely` geometries, and `datetime` objects without raising `TypeError` during JSON serialization.

```python
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import click
import geopandas as gpd
from pyproj import CRS, Transformer
from shapely.geometry import box
from shapely.validation import make_valid

# Custom JSON encoder for GIS-specific types
class SpatialJSONEncoder(json.JSONEncoder):
    def default(self, obj: Any) -> Any:
        if isinstance(obj, (Path, CRS)):
            return str(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        if hasattr(obj, "__geo_interface__"):
            return obj.__geo_interface__
        return super().default(obj)

class JSONSpatialFormatter(logging.Formatter):
    """Formats log records into structured JSON with spatial metadata."""
    def format(self, record: logging.LogRecord) -> str:
        log_obj: Dict[str, Any] = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }
        # Safely extract spatial extras
        spatial_keys = (
            "input_crs", "output_crs", "feature_count", "bbox",
            "processing_time_ms", "error_type", "stack_trace", "exc_text"
        )
        for key in spatial_keys:
            if hasattr(record, key):
                val = getattr(record, key)
                # Keep primitives intact; serialize complex objects via encoder
                if isinstance(val, (str, int, float, bool, list, dict, type(None))):
                    log_obj[key] = val
                else:
                    log_obj[key] = str(val)
        return json.dumps(log_obj, cls=SpatialJSONEncoder)

def setup_json_logger(name: str = "spatial_transform", log_file: Optional[Path] = None) -> logging.Logger:
    """Configure a logger with JSON formatting and optional file routing."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # Prevent duplicate handlers on repeated calls

    logger.setLevel(logging.INFO)
    formatter = JSONSpatialFormatter(datefmt="%Y-%m-%dT%H:%M:%S")

    # Console handler (stderr to avoid mixing with stdout data)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)

    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger

def transform_with_metrics(
    gdf: gpd.GeoDataFrame,
    target_crs: str,
    logger: logging.Logger
) -> gpd.GeoDataFrame:
    """Execute transformation while logging spatial metrics and errors."""
    start = time.perf_counter()
    input_crs = gdf.crs
    feature_count = len(gdf)
    bbox = gdf.total_bounds.tolist() if not gdf.empty else None

    try:
        # Validate geometries before projection
        gdf.geometry = gdf.geometry.apply(make_valid)
        gdf = gdf.to_crs(target_crs)
        processing_time = (time.perf_counter() - start) * 1000

        logger.info(
            "Transformation complete",
            extra={
                "input_crs": input_crs,
                "output_crs": target_crs,
                "feature_count": feature_count,
                "bbox": bbox,
                "processing_time_ms": round(processing_time, 2),
            }
        )
        return gdf
    except Exception as e:
        processing_time = (time.perf_counter() - start) * 1000
        logger.error(
            "Transformation failed",
            extra={
                "input_crs": input_crs,
                "output_crs": target_crs,
                "feature_count": feature_count,
                "processing_time_ms": round(processing_time, 2),
                "error_type": type(e).__name__,
                "exc_text": str(e),
            },
            exc_info=True
        )
        raise
```

## Integrating with CLI & Batch Pipelines

Wire the formatter into your command-line interface using `click`. Separating telemetry from standard output prevents log pollution when piping results to downstream tools.

```python
@click.command()
@click.argument("input_file", type=click.Path(exists=True, path_type=Path))
@click.option("--output-crs", default="EPSG:4326", help="Target coordinate reference system")
@click.option("--log-file", type=click.Path(path_type=Path), default=None)
def cli(input_file: Path, output_crs: str, log_file: Optional[Path]):
    logger = setup_json_logger(log_file=log_file)
    logger.info("Starting spatial transformation pipeline")

    try:
        gdf = gpd.read_file(input_file)
        result = transform_with_metrics(gdf, output_crs, logger)
        
        # Write result to stdout or a designated output path
        output_path = input_file.with_name(f"{input_file.stem}_transformed.parquet")
        result.to_parquet(output_path)
        click.echo(f"Saved to {output_path}")
    except Exception as e:
        logger.critical("Pipeline aborted", extra={"error_type": type(e).__name__}, exc_info=True)
        raise click.ClickException(str(e))

if __name__ == "__main__":
    cli()
```

## Performance & Serialization Notes

When scaling this pattern across distributed workers or async queues, keep these constraints in mind:

* **Avoid Blocking I/O**: File handlers block the main thread during high-throughput jobs. Use `logging.handlers.QueueHandler` paired with a background `QueueListener` to offload serialization and disk writes. See the official [Python logging cookbook](https://docs.python.org/3/howto/logging-cookbook.html#logging-to-a-single-file-from-multiple-processes) for async-safe patterns.
* **Schema Consistency**: Downstream parsers expect stable keys. Always pass the same `extra` dictionary shape, even when values are `None`. Missing keys break JSON schema validation in tools like OpenTelemetry or Fluent Bit.
* **Geometry Serialization**: Bounding boxes and WKT strings serialize cheaply. Avoid dumping full GeoJSON geometries into logs; they inflate payload size and trigger rate limits in log aggregators. Store geometry hashes or validity flags instead.
* **CRS Normalization**: `pyproj.CRS` objects can stringify to verbose PROJ strings. Normalize to EPSG codes or short-form strings before injection to keep log lines compact.

For teams building resilient geospatial infrastructure, this logging pattern integrates seamlessly into broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/). By standardizing how transformations report state, you eliminate guesswork during incident response and enable automated retry logic based on structured error codes rather than fragile string matching.