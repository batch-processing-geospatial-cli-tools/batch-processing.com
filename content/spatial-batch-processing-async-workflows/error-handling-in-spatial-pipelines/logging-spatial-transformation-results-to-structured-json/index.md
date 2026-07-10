---
title: "Logging Spatial Transformations to Structured JSON"
description: "Configure JSONSpatialFormatter to capture CRS, geometry counts, bounding boxes, and error traces as machine-readable JSON for Click CLIs and async batch pipelines."
slug: "logging-spatial-transformation-results-to-structured-json"
type: "article"
breadcrumb: "Spatial Batch Processing > Error Handling in Spatial Pipelines > Logging to Structured JSON"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Logging Spatial Transformation Results to Structured JSON",
      "description": "Configure a Python JSONSpatialFormatter that captures CRS, geometry counts, bounding boxes, and error traces as machine-readable JSON — and wire it into a Click CLI or async batch pipeline.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Spatial Batch Processing & Async Workflows", "item": "/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 2, "name": "Error Handling in Spatial Pipelines", "item": "/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/"},
        {"@type": "ListItem", "position": 3, "name": "Logging Spatial Transformation Results to Structured JSON", "item": "/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Log spatial transformation results to structured JSON in Python",
      "step": [
        {"@type": "HowToStep", "name": "Install dependencies", "text": "pip install geopandas pyproj shapely click pyogrio"},
        {"@type": "HowToStep", "name": "Implement SpatialJSONEncoder", "text": "Subclass json.JSONEncoder to handle Path, CRS, datetime, and geometry objects."},
        {"@type": "HowToStep", "name": "Implement JSONSpatialFormatter", "text": "Subclass logging.Formatter to embed spatial extras into every log record as a JSON object."},
        {"@type": "HowToStep", "name": "Write transform_with_metrics", "text": "Wrap gdf.to_crs() in a try/except, measure elapsed time, and emit structured log events for both success and failure."},
        {"@type": "HowToStep", "name": "Wire into CLI", "text": "Route logs to stderr with a Click command so structured telemetry never pollutes piped stdout output."},
        {"@type": "HowToStep", "name": "Verify output", "text": "Run python -c 'import json, subprocess; ...' or pipe output through jq to assert all expected keys are present."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why route JSON logs to stderr instead of stdout?",
          "acceptedAnswer": {"@type": "Answer", "text": "Stdout is the data channel in UNIX pipelines. If you mix JSON log lines with GeoJSON or WKT output, downstream tools that expect clean data — jq, ogr2ogr, or your own scripts — will fail to parse the stream. Routing logs to stderr keeps the data channel clean."}
        },
        {
          "@type": "Question",
          "name": "Will logging full geometries in JSON flood my log aggregator?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes. A single MultiPolygon can exceed 500 KB of GeoJSON. Log only the bounding box (total_bounds), feature count, and a validity flag. Store the geometry reference separately if you need it for debugging."}
        },
        {
          "@type": "Question",
          "name": "How do I use QueueHandler for async batch jobs?",
          "acceptedAnswer": {"@type": "Answer", "text": "Replace the direct StreamHandler with a logging.handlers.QueueHandler feeding a QueueListener that owns the StreamHandler. The listener runs on a background thread so coroutines in your asyncio loop never block on disk I/O during log writes."}
        },
        {
          "@type": "Question",
          "name": "What CRS representation is safest for JSON logs?",
          "acceptedAnswer": {"@type": "Answer", "text": "EPSG short codes (e.g. 'EPSG:4326') are the safest — they are compact, human-readable, and round-trip cleanly through pyproj. The SpatialJSONEncoder shown here calls crs.to_epsg() first and falls back to crs.to_string() when no EPSG authority code exists."}
        }
      ]
    }
  ]
}
</script>

Configuring a custom `logging.Formatter` that serializes Python `logging.LogRecord` objects to JSON — and injecting spatial context via the `extra` parameter — gives every CRS transformation, geometry validation step, or clipping operation a deterministic, machine-readable audit trail. This is part of the [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) guide.

## Prerequisites

```
pip install geopandas pyproj shapely click pyogrio
```

- Python 3.10+, GDAL 3.4+
- Familiarity with the `logging` module's `Logger → Handler → Formatter` chain
- Basic [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) experience — event loop lifecycle, `asyncio` task scheduling

No third-party JSON logging library is required. The implementation below uses only the standard library plus your geospatial stack.

## Why Structured Logs Matter for GIS Workflows

Traditional line-based logs fracture under batch spatial processing. When reprojecting thousands of vector files, clipping against administrative boundaries, or validating topology, you need queryable output. Structured JSON logs route cleanly to observability stacks — Elasticsearch, Loki, Datadog — and provide a clear audit trail that distinguishes a missing CRS from an invalid geometry or a GDAL driver timeout. That distinction determines whether a job should retry, skip, or fail fast.

The data flow below shows how a single transformation event moves from your Python call site through the formatter and into a log sink:

<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Structured JSON logging data-flow diagram" style="width:100%;max-width:640px;display:block;margin:1.5rem auto;">
  <title>Structured JSON logging data-flow</title>
  <desc>A transformation call passes spatial extras to a Logger, which sends them to a JSONSpatialFormatter, then to a Handler that writes to stderr or a log file.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Boxes -->
  <rect x="10" y="80" width="130" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="75" y="106" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">transform_with</text>
  <text x="75" y="122" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">_metrics()</text>
  <rect x="200" y="80" width="110" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="255" y="106" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Logger +</text>
  <text x="255" y="122" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">extra={…}</text>
  <rect x="370" y="80" width="130" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="435" y="106" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">JSONSpatial</text>
  <text x="435" y="122" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit">Formatter</text>
  <!-- Sinks -->
  <rect x="540" y="40" width="90" height="40" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
  <text x="585" y="65" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit">stderr</text>
  <rect x="540" y="140" width="90" height="40" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
  <text x="585" y="165" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit">log file</text>
  <!-- Arrows between main boxes -->
  <line x1="140" y1="110" x2="196" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <line x1="310" y1="110" x2="366" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <!-- Fork to sinks -->
  <line x1="500" y1="100" x2="520" y2="100" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="520" y1="100" x2="520" y2="60" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="520" y1="60" x2="538" y2="60" stroke="currentColor" stroke-width="1.2" marker-end="url(#arr)" opacity="0.5"/>
  <line x1="520" y1="100" x2="520" y2="160" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="520" y1="160" x2="538" y2="160" stroke="currentColor" stroke-width="1.2" marker-end="url(#arr)" opacity="0.5"/>
  <!-- Labels on arrows -->
  <text x="168" y="104" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">logger.info/error</text>
  <text x="338" y="104" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">LogRecord</text>
  <text x="530" y="90" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">JSON line</text>
</svg>

## Complete Working Implementation

The following module is self-contained. Copy it, point `input_file` at any Shapefile or GeoPackage, and run it directly. It handles `pathlib.Path`, `pyproj.CRS`, `shapely` geometries, and `datetime` objects without raising `TypeError` during serialization.

```python
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import click
import geopandas as gpd
from pyproj import CRS
from shapely.validation import make_valid


# ── 1. Custom JSON encoder for GIS-specific types ────────────────────────────
class SpatialJSONEncoder(json.JSONEncoder):
    def default(self, obj: Any) -> Any:
        if isinstance(obj, Path):
            return str(obj)
        if isinstance(obj, CRS):
            # Prefer short EPSG form; fall back to PROJ string
            epsg = obj.to_epsg()
            return f"EPSG:{epsg}" if epsg else obj.to_string()
        if isinstance(obj, datetime):
            return obj.isoformat()
        if hasattr(obj, "__geo_interface__"):
            # Geometries: log only the type, never the full coordinate ring
            return {"type": obj.__geo_interface__["type"]}
        return super().default(obj)


# ── 2. Formatter that injects spatial extras into every log line ──────────────
class JSONSpatialFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects with spatial metadata."""

    _SPATIAL_KEYS = (
        "input_crs", "output_crs", "feature_count",
        "bbox", "processing_time_ms", "error_type", "exc_text",
    )

    def format(self, record: logging.LogRecord) -> str:
        log_obj: dict[str, Any] = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level":     record.levelname,
            "message":   record.getMessage(),
            "module":    record.module,
            "function":  record.funcName,
            "line":      record.lineno,
        }
        for key in self._SPATIAL_KEYS:
            if hasattr(record, key):
                val = getattr(record, key)
                # Pass JSON-native types through; coerce everything else
                if isinstance(val, (str, int, float, bool, list, dict, type(None))):
                    log_obj[key] = val
                else:
                    log_obj[key] = str(val)
        return json.dumps(log_obj, cls=SpatialJSONEncoder)


# ── 3. Logger factory ─────────────────────────────────────────────────────────
def setup_json_logger(
    name: str = "spatial_transform",
    log_file: Optional[Path] = None,
) -> logging.Logger:
    """Return a logger with JSON formatting; routes to stderr + optional file."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # Prevent duplicate handlers on repeated calls

    logger.setLevel(logging.INFO)
    fmt = JSONSpatialFormatter(datefmt="%Y-%m-%dT%H:%M:%S")

    # Console handler targets stderr — keeps stdout clean for piped data output
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    logger.addHandler(console)

    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setFormatter(fmt)
        logger.addHandler(fh)

    return logger


# ── 4. Transformation wrapper with metrics emission ───────────────────────────
def transform_with_metrics(
    gdf: gpd.GeoDataFrame,
    target_crs: str,
    logger: logging.Logger,
) -> gpd.GeoDataFrame:
    """
    Reproject *gdf* to *target_crs*.

    Emits an INFO record on success and an ERROR record on failure.
    Both records carry input_crs, output_crs, feature_count, bbox, and
    processing_time_ms so downstream log aggregators can query them directly.
    """
    start = time.perf_counter()
    input_crs = gdf.crs
    feature_count = len(gdf)
    # total_bounds returns [minx, miny, maxx, maxy] as a numpy array
    bbox = gdf.total_bounds.tolist() if not gdf.empty else None

    try:
        gdf = gdf.copy()
        # make_valid repairs self-intersections before projection to avoid GEOS errors
        gdf.geometry = gdf.geometry.apply(make_valid)
        gdf = gdf.to_crs(target_crs)
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)

        logger.info(
            "Transformation complete",
            extra={
                "input_crs":          input_crs,
                "output_crs":         target_crs,
                "feature_count":      feature_count,
                "bbox":               bbox,
                "processing_time_ms": elapsed_ms,
            },
        )
        return gdf

    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        logger.error(
            "Transformation failed",
            extra={
                "input_crs":          input_crs,
                "output_crs":         target_crs,
                "feature_count":      feature_count,
                "processing_time_ms": elapsed_ms,
                "error_type":         type(exc).__name__,
                "exc_text":           str(exc),
            },
            exc_info=True,
        )
        raise


# ── 5. Click CLI entry point ──────────────────────────────────────────────────
@click.command()
@click.argument("input_file", type=click.Path(exists=True, path_type=Path))
@click.option("--output-crs",  default="EPSG:4326", show_default=True,
              help="Target coordinate reference system (EPSG code).")
@click.option("--log-file",    type=click.Path(path_type=Path), default=None,
              help="Optional path for the JSON log file.")
def cli(input_file: Path, output_crs: str, log_file: Optional[Path]) -> None:
    """Reproject INPUT_FILE to OUTPUT_CRS and emit structured JSON telemetry."""
    logger = setup_json_logger(log_file=log_file)
    logger.info("Pipeline start", extra={"input_file": input_file})

    try:
        # pyogrio is the default engine in geopandas >= 0.14; faster than fiona
        gdf = gpd.read_file(input_file, engine="pyogrio")
        result = transform_with_metrics(gdf, output_crs, logger)

        out_path = input_file.with_name(f"{input_file.stem}_transformed.parquet")
        result.to_parquet(out_path)
        click.echo(str(out_path))          # stdout: clean path for downstream tools

    except Exception as exc:
        logger.critical(
            "Pipeline aborted",
            extra={"error_type": type(exc).__name__},
            exc_info=True,
        )
        raise click.ClickException(str(exc))


if __name__ == "__main__":
    cli()
```

## Step Annotations

**1 — `SpatialJSONEncoder.default`**
`json.JSONEncoder.default` is only called for types the encoder does not natively handle. Routing `Path` to `str`, `CRS` to an EPSG short code, and `datetime` to ISO 8601 prevents `TypeError` without wrapping every value before passing it to `logger.info`. The geometry branch deliberately discards coordinate data; only the geometry type is logged to keep line sizes under 1 KB.

**2 — `JSONSpatialFormatter._SPATIAL_KEYS` whitelist**
Iterating only the declared keys prevents accidental serialization of large objects that could be attached to `extra`. If a downstream consumer adds a key not in the whitelist, it is silently dropped rather than blowing up the formatter.

**3 — `gdf.total_bounds.tolist()`**
`total_bounds` returns a NumPy `ndarray`. The standard `json` module cannot serialize NumPy types; `.tolist()` converts it to a plain Python list of four floats before it reaches the encoder.

**4 — `make_valid` before `to_crs`**
GEOS raises `TopologyException` for self-intersecting rings during projection. Calling `make_valid` on every geometry before `to_crs` eliminates this class of failure. The cost is roughly 0.1 ms per feature for well-formed polygons and is worth paying unconditionally.

**5 — `engine="pyogrio"` in `gpd.read_file`**
`pyogrio` vectorises I/O at the C layer and is 3–10× faster than `fiona` for large files. It is the default engine in geopandas ≥ 0.14. Passing it explicitly documents the dependency and makes the choice auditable. For [async I/O for raster processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/), the equivalent is `rasterio.open` with a `CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE=YES` environment variable rather than blocking file handles.

**6 — `stderr` for logs, `stdout` for the output path**
`click.echo(str(out_path))` goes to stdout. Every `logger.*` call goes to stderr. A downstream shell pipeline like `python reproject.py input.gpkg | xargs ogr2ogr ...` works correctly because the tool the pipeline feeds receives only the clean file path, not JSON log lines interspersed with it.

## Named Gotcha: `TypeError` on `numpy.float64` in `bbox`

The most common failure when first running this pattern is a `TypeError: Object of type float64 is not JSON serializable` raised inside the formatter's `json.dumps` call. This happens when `gdf.total_bounds` returns a NumPy array and you pass it directly without `.tolist()`.

**Fix:** Always call `.tolist()` on any NumPy array before it enters `extra`:

```python
bbox = gdf.total_bounds.tolist() if not gdf.empty else None
```

If you are already hit by this error in a running pipeline, set `PYTHONFAULTHANDLER=1` and re-run — the full traceback will show which key triggered it. A `SpatialJSONEncoder` catch-all that calls `float(obj)` for `numpy.floating` subtypes is a valid belt-and-suspenders addition:

```python
import numpy as np

class SpatialJSONEncoder(json.JSONEncoder):
    def default(self, obj: Any) -> Any:
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        # … rest of the encoder
```

## Verification

After running the CLI, assert that every JSON line contains the required keys and that CRS values are well-formed EPSG strings:

```python
import json
import subprocess
from pathlib import Path

result = subprocess.run(
    ["python", "reproject.py", "tests/fixtures/sample.gpkg", "--output-crs", "EPSG:3857"],
    capture_output=True,
    text=True,
    check=True,
)

# Stderr carries the JSON log lines
log_lines = [json.loads(line) for line in result.stderr.splitlines() if line.strip()]

# Verify the success record is present and structurally correct
success = next(l for l in log_lines if l["message"] == "Transformation complete")
assert success["level"] == "INFO"
assert success["output_crs"] == "EPSG:3857"
assert isinstance(success["feature_count"], int)
assert isinstance(success["processing_time_ms"], float)
assert len(success["bbox"]) == 4, "bbox must be [minx, miny, maxx, maxy]"
```

You can also pipe stderr through `jq` interactively to inspect a single field across hundreds of log lines:

```bash
python reproject.py data/counties.gpkg --output-crs EPSG:3857 2>&1 >/dev/null \
    | jq -r '[.timestamp, .level, .feature_count, .processing_time_ms] | @tsv'
```

## Performance Notes for High-Volume Pipelines

When scaling this pattern across distributed workers or [async batch workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/), the `StreamHandler` and `FileHandler` both perform synchronous I/O on the calling thread. At high event rates — thousands of features per second across many concurrent workers — this creates measurable contention.

Replace the direct handlers with a `QueueHandler` / `QueueListener` pair to offload serialization and disk writes to a background thread:

```python
import logging
import logging.handlers
import queue

def setup_async_json_logger(name: str = "spatial_transform") -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    log_queue: queue.Queue = queue.Queue(maxsize=-1)  # unbounded
    fmt = JSONSpatialFormatter(datefmt="%Y-%m-%dT%H:%M:%S")

    # The QueueHandler is non-blocking; the listener owns the real StreamHandler
    queue_handler = logging.handlers.QueueHandler(log_queue)
    logger.addHandler(queue_handler)
    logger.setLevel(logging.INFO)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)

    listener = logging.handlers.QueueListener(log_queue, stream_handler, respect_handler_level=True)
    listener.start()

    # Store a reference so the caller can call listener.stop() at shutdown
    logger._listener = listener  # type: ignore[attr-defined]
    return logger
```

Call `logger._listener.stop()` in your cleanup / `atexit` handler to drain the queue before the process exits.

## FAQ

<details class="faq-item">
<summary>Why route JSON logs to stderr instead of stdout?</summary>

Stdout is the data channel in UNIX pipelines. If you mix JSON log lines with GeoJSON or WKT output, downstream tools that expect clean data — `jq`, `ogr2ogr`, or your own scripts — will fail to parse the stream. Routing logs to stderr keeps the data channel clean regardless of whether the process is run interactively or in a pipeline.

</details>

<details class="faq-item">
<summary>Will logging full geometries in JSON flood my log aggregator?</summary>

Yes. A single `MultiPolygon` can exceed 500 KB of GeoJSON text. Log only the bounding box (`total_bounds`), feature count, and a validity flag. Store a geometry hash or a reference path if you need the actual geometry for post-mortem debugging.

</details>

<details class="faq-item">
<summary>How do I integrate this with OpenTelemetry?</summary>

Add an `OTLPLogExporter` alongside your `StreamHandler`. Use the same `extra` keys as OTel attribute names (lowercase, dot-separated). The `JSONSpatialFormatter` is independent of the export target — its output is a plain dict that maps directly onto OTel `LogRecord` attributes. Set `OTEL_PYTHON_LOG_CORRELATION=true` to auto-inject `trace_id` and `span_id` into every log record.

</details>

<details class="faq-item">
<summary>What CRS representation is safest for JSON logs?</summary>

EPSG short codes (`EPSG:4326`) are compact, human-readable, and round-trip cleanly through `pyproj`. The `SpatialJSONEncoder` above calls `crs.to_epsg()` first and falls back to `crs.to_string()` when no EPSG authority code exists (e.g. for custom projections). Avoid logging full WKT2 strings in hot paths — they can be 2 KB per record.

</details>

---

## Related

- [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — the parent guide covering retry logic, exit codes, and fault-tolerant pipeline architecture
- [Processing 100k GeoJSON Files with Python asyncio](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/processing-100k-geojson-files-with-python-asyncio/) — applies the same structured logging pattern inside a bounded-concurrency asyncio pipeline
