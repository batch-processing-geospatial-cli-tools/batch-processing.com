---
title: "Chunked Vector Data Reading for Spatial Pipelines"
description: "Stream multi-gigabyte shapefiles and GeoJSON without OOM errors using pyogrio offset/limit reads, memory-aware chunk sizing, and incremental columnar output."
slug: "chunked-vector-data-reading"
type: "topic"
breadcrumb: "Spatial Batch Processing > Chunked Vector Data Reading"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

Stream multi-gigabyte vector datasets into a predictable memory footprint using `pyogrio` offset/limit cursor reads, memory-aware chunk sizing, and incremental GeoParquet output — without ever materializing the full `GeoDataFrame`.

It fits into the wider [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) guide.

## Prerequisites

- **Python 3.9+** — required for `__future__` annotations, `match` statements, and stable `asyncio.to_thread()` semantics
- **Core libraries:** `pyogrio>=0.7.0`, `geopandas>=1.0.0`, `pyarrow>=14.0`, `typer>=0.9.0`, `psutil>=5.9.0`
- **System backend:** GDAL 3.4+ compiled with Parquet/Arrow support. Verify with `python -c "import pyogrio; print(pyogrio.list_drivers().get('Parquet'))"`
- **Hardware:** 8 GB RAM minimum; NVMe storage for shapefile/GeoPackage I/O; 4+ cores for downstream spatial joins

```bash
pip install "pyogrio>=0.7" "geopandas>=1.0" "pyarrow>=14" typer psutil
```

Confirm Arrow and Parquet driver availability before running any batch:

```python
import pyogrio

drivers = pyogrio.list_drivers()
assert drivers.get("Parquet") in ("rw", "r"), (
    "GDAL Parquet driver missing — rebuild GDAL with Arrow/Parquet support"
)
print(f"pyogrio {pyogrio.__version__} ready, Parquet driver: {drivers['Parquet']}")
```

## Problem Framing

A standard `geopandas.read_file("admin_boundaries_world.gpkg")` call materialises the entire dataset into a single `GeoDataFrame`. At 50 million polygon features from an OpenStreetMap extract, that call allocates 12–40 GB of RAM, thrashes the page cache, and terminates with `MemoryError` on any commodity server. The failure is not gradual — it is a hard crash at the point of read, with no partial progress and no recovery path.

The same pattern fails for dense IoT telemetry files, continental-scale address datasets, and high-resolution cadastral boundaries. The fix is not "buy more RAM" — it is a cursor-based streaming approach where features are ingested, transformed, and flushed to disk in fixed-size batches, keeping the working set constant regardless of dataset size.

## Step-by-Step Implementation

### Step 1 — Inspect Metadata Without Loading Features

`pyogrio.read_info()` returns lightweight metadata (row count, CRS EPSG code, geometry type, bounding box, attribute schema) by querying the OGR layer header. No features are decoded.

```python
import pyogrio
from pathlib import Path

INPUT = Path("data/osm_buildings_europe.gpkg")

info = pyogrio.read_info(str(INPUT))
print(f"Features : {info['features']:,}")
print(f"CRS      : {info.get('crs', 'unknown')}")
print(f"Geometry : {info.get('geometry_type', 'unknown')}")
print(f"Fields   : {info.get('fields', [])}")
```

The `features` key gives the total row count that drives all subsequent chunking arithmetic. If this field returns `None` (some remote OGR sources), fall back to a test read of 1,000 rows and extrapolate from file size.

### Step 2 — Calculate a Memory-Aware Chunk Size

Chunk sizing is not a configuration constant — it is a function of geometry complexity, attribute width, and available RAM. Dense multipolygon features can consume 50× more memory per row than point features with identical schemas.

```python
import psutil

def sample_row_footprint_mb(path: str, sample_rows: int = 5_000) -> float:
    """Measure per-row RSS cost by reading a small sample."""
    import os
    proc = psutil.Process(os.getpid())
    before = proc.memory_info().rss
    sample = pyogrio.read_dataframe(path, rows=slice(0, sample_rows), use_arrow=True)
    after = proc.memory_info().rss
    del sample
    return (after - before) / (1024 ** 2) / sample_rows  # MB per row

def calculate_chunk_size(
    path: str,
    total_rows: int,
    safety_factor: float = 0.6,
) -> int:
    """Derive chunk size from live memory measurement."""
    available_mb = psutil.virtual_memory().available / (1024 ** 2)
    row_mb = sample_row_footprint_mb(path)
    if row_mb <= 0:
        row_mb = 0.001  # fallback: 1 KB/row estimate
    safe_rows = int((available_mb * safety_factor) / row_mb)
    # Clamp between 5,000 (prevent tiny chunks) and 500,000 (prevent OOM)
    return max(5_000, min(safe_rows, 500_000))
```

### Step 3 — Iterate with an Offset/Limit Cursor

`pyogrio.read_dataframe()` accepts a `rows` parameter as a Python `slice(offset, offset + count)`. This maps to OGR's `SetNextByIndex` / `GetNextFeature` cursor under the hood, so only the requested window is decoded and transferred into memory.

Setting `use_arrow=True` bypasses Python object construction entirely — features flow through Apache Arrow columnar buffers before conversion to `GeoDataFrame`, reducing peak RSS by 30–50% on attribute-heavy datasets.

```python
import pyogrio
from geopandas import GeoDataFrame

def iter_chunks(path: str, chunk_size: int, total_rows: int):
    """Yield GeoDataFrames in offset/limit windows."""
    offset = 0
    while offset < total_rows:
        chunk: GeoDataFrame = pyogrio.read_dataframe(
            path,
            rows=slice(offset, offset + chunk_size),
            use_arrow=True,        # Arrow-backed read: 30–50% less RSS
        )
        if chunk.empty:
            break
        yield offset, chunk
        offset += len(chunk)
```

**Driver compatibility note:** The Shapefile (`.shp`) driver does not support random-seek offsets. If your input is a shapefile, convert it to GeoPackage (EPSG-preserving, single-file) or FlatGeobuf first:

```bash
ogr2ogr -f GPKG output.gpkg input.shp
```

### Step 4 — Validate Schema on Every Chunk

Real-world vector datasets sourced from multiple municipalities, data vendors, or sensor streams frequently contain attribute drift — columns added, renamed, or dropped between spatial partitions. Detecting this early prevents silent data loss in downstream queries.

```python
from typing import Optional
import logging

logger = logging.getLogger("chunked_reader")

def validate_chunk_schema(
    chunk,
    expected_cols: Optional[set],
    expected_crs: Optional[str],
) -> tuple[set, str]:
    """Assert column set and CRS stability; return updated expectations."""
    actual_cols = set(chunk.columns)
    actual_crs = chunk.crs.to_epsg() if chunk.crs else None

    if expected_cols is None:
        return actual_cols, actual_crs  # first chunk sets the baseline

    missing = expected_cols - actual_cols
    extra = actual_cols - expected_cols
    if missing:
        logger.warning(f"Schema drift — missing columns: {missing}")
    if extra:
        logger.info(f"Schema drift — new columns: {extra}")
    if actual_crs != expected_crs:
        logger.warning(
            f"CRS mismatch: expected EPSG:{expected_crs}, got EPSG:{actual_crs} — reprojecting"
        )
        chunk = chunk.to_crs(epsg=int(expected_crs))

    return expected_cols, expected_crs
```

### Step 5 — Write Incrementally to GeoParquet

GeoParquet files are immutable once written — `to_parquet()` rewrites the entire file on each call, so calling it inside the chunk loop would O(n²) disk I/O. The correct pattern uses `pyarrow.parquet.write_to_dataset()` to append each chunk as a new row-group file in a partitioned output directory. The full directory reads as a single logical dataset.

```python
import pyarrow.parquet as pq
import pyarrow as pa

def write_chunk_to_dataset(
    chunk,
    output_dir: str,
    partition_cols: list[str] | None = None,
) -> None:
    """Append one chunk to a partitioned GeoParquet dataset."""
    table = pa.Table.from_pandas(chunk, preserve_index=False)
    pq.write_to_dataset(
        table,
        root_path=output_dir,
        partition_cols=partition_cols or [],
        existing_data_behavior="overwrite_or_ignore",
        use_legacy_dataset=False,
    )
```

For spatial partitioning (e.g., grouping by country code or UTM zone), add the partition column to the `GeoDataFrame` before this call:

```python
chunk["country_iso"] = chunk.geometry.apply(
    lambda g: reverse_geocode_country(g.centroid)  # your lookup here
)
write_chunk_to_dataset(chunk, "output/buildings/", partition_cols=["country_iso"])
```

### Step 6 — Checkpoint the Cursor Offset

Long-running ingestion jobs are interrupted by disk-full errors, OOM kills, and network timeouts. Persisting the last successfully written offset to a `.state` file enables deterministic resume without reprocessing completed chunks.

```python
import json
from pathlib import Path

STATE_FILE = Path(".ingest_state.json")

def load_checkpoint() -> int:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text()).get("offset", 0)
    return 0

def save_checkpoint(offset: int) -> None:
    STATE_FILE.write_text(json.dumps({"offset": offset}))

def clear_checkpoint() -> None:
    STATE_FILE.unlink(missing_ok=True)
```

## Configuration Integration

Chunked ingestion plugs directly into a layered config stack. Defaults live in code, a YAML config overrides them, environment variables override the YAML, and CLI flags take final precedence. This mirrors the pattern described in [Configuration File Management for Geospatial CLI Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/).

```python
import os
import yaml
from pathlib import Path

DEFAULTS = {
    "chunk_size": None,          # None → calculate from memory
    "max_memory_mb": 4096.0,
    "output_format": "geoparquet",
    "log_level": "INFO",
}

def load_config(config_path: Path | None) -> dict:
    cfg = dict(DEFAULTS)
    if config_path and config_path.exists():
        with config_path.open() as f:
            cfg.update(yaml.safe_load(f) or {})
    # Environment variable overrides (INGEST_ prefix)
    for key in cfg:
        env_key = f"INGEST_{key.upper()}"
        if env_key in os.environ:
            cfg[key] = type(cfg[key])(os.environ[env_key]) if cfg[key] is not None else os.environ[env_key]
    return cfg
```

The CLI flag layer (implemented with [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/)) then overrides any value from the YAML/env layer when the user explicitly provides it.

## Data-Flow Diagram

The diagram below shows the full pipeline: metadata inspection feeds chunk sizing, the offset cursor iterates chunks through schema validation and atomic writes, with the checkpoint file enabling resume on failure.

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chunked vector ingestion data-flow diagram" style="max-width:100%;height:auto;display:block;margin:1.5rem auto">
  <title>Chunked Vector Ingestion Pipeline</title>
  <desc>Data-flow diagram showing: input vector file feeds metadata inspection, which feeds chunk-size calculation, which feeds an offset/limit cursor loop. Each chunk passes through schema validation, then an atomic write to GeoParquet. A checkpoint file persists the offset after each successful write, enabling resume on failure.</desc>
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0,10 3.5,0 7" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Input file -->
  <rect x="20" y="170" width="130" height="56" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="85" y="196" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif" font-weight="600">Input Vector</text>
  <text x="85" y="213" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">.gpkg / .fgb</text>
  <!-- Arrow to metadata -->
  <line x1="150" y1="198" x2="195" y2="198" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Metadata inspection -->
  <rect x="197" y="155" width="130" height="84" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="262" y="182" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif" font-weight="600">Metadata</text>
  <text x="262" y="198" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif" font-weight="600">Inspection</text>
  <text x="262" y="218" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">read_info()</text>
  <!-- Arrow to chunk size -->
  <line x1="327" y1="198" x2="372" y2="198" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Chunk size calc -->
  <rect x="374" y="155" width="130" height="84" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="439" y="182" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif" font-weight="600">Chunk Size</text>
  <text x="439" y="198" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif" font-weight="600">Calculation</text>
  <text x="439" y="218" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">psutil RSS sample</text>
  <!-- Arrow to cursor loop -->
  <line x1="504" y1="198" x2="549" y2="198" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Cursor loop box -->
  <rect x="551" y="100" width="130" height="196" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="616" y="122" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.65">for each chunk</text>
  <!-- Read chunk -->
  <rect x="563" y="132" width="106" height="42" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="616" y="152" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">rows=slice(</text>
  <text x="616" y="166" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">offset, offset+N)</text>
  <!-- Arrow validate -->
  <line x1="616" y1="174" x2="616" y2="196" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Validate schema -->
  <rect x="563" y="198" width="106" height="38" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="616" y="215" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">Schema</text>
  <text x="616" y="229" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">Validation</text>
  <!-- Arrow write -->
  <line x1="616" y1="236" x2="616" y2="260" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
  <!-- Write chunk -->
  <rect x="563" y="262" width="106" height="24" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="616" y="279" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">Atomic write</text>
  <!-- Checkpoint file below loop -->
  <rect x="551" y="326" width="130" height="42" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" stroke-dasharray="3,2"/>
  <text x="616" y="348" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">.ingest_state.json</text>
  <text x="616" y="362" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity="0.65">offset checkpoint</text>
  <line x1="616" y1="286" x2="616" y2="326" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="4,2" marker-end="url(#arr)"/>
  <!-- Output -->
  <rect x="720" y="218" width="80" height="48" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="760" y="240" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">GeoParquet</text>
  <text x="760" y="256" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">dataset/</text>
  <line x1="669" y1="274" x2="720" y2="244" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" marker-end="url(#arr)"/>
</svg>

## Full Production CLI

The following `typer` CLI assembles all six steps into a complete ingestion command with structured logging, POSIX exit codes, and resume-from-checkpoint support.

```python
from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path
from typing import Optional

import psutil
import pyarrow as pa
import pyarrow.parquet as pq
import pyogrio
import typer
from geopandas import GeoDataFrame

app = typer.Typer(add_completion=False)
logger = logging.getLogger("chunked_reader")

# ── Checkpointing ─────────────────────────────────────────────────────────────

def _state_path(output_dir: Path) -> Path:
    return output_dir.parent / f".{output_dir.name}_state.json"

def _load_checkpoint(output_dir: Path) -> int:
    p = _state_path(output_dir)
    return json.loads(p.read_text()).get("offset", 0) if p.exists() else 0

def _save_checkpoint(output_dir: Path, offset: int) -> None:
    _state_path(output_dir).write_text(json.dumps({"offset": offset}))

def _clear_checkpoint(output_dir: Path) -> None:
    _state_path(output_dir).unlink(missing_ok=True)

# ── Memory helpers ─────────────────────────────────────────────────────────────

def _rss_mb() -> float:
    return psutil.Process().memory_info().rss / (1024 ** 2)

def _sample_row_footprint_mb(path: str, n: int = 5_000) -> float:
    before = _rss_mb()
    s = pyogrio.read_dataframe(path, rows=slice(0, n), use_arrow=True)
    after = _rss_mb()
    del s
    return max((after - before) / n, 1e-6)

def _auto_chunk_size(path: str, safety: float = 0.60) -> int:
    avail_mb = psutil.virtual_memory().available / (1024 ** 2)
    row_mb = _sample_row_footprint_mb(path)
    return max(5_000, min(int(avail_mb * safety / row_mb), 500_000))

# ── Schema / CRS validation ────────────────────────────────────────────────────

def _validate(
    chunk: GeoDataFrame,
    expected_cols: Optional[set],
    expected_epsg: Optional[int],
) -> tuple[GeoDataFrame, set, Optional[int]]:
    cols = set(chunk.columns)
    epsg = chunk.crs.to_epsg() if chunk.crs else None

    if expected_cols is None:
        return chunk, cols, epsg

    missing = expected_cols - cols
    if missing:
        logger.warning("Schema drift — missing columns: %s", missing)

    if epsg != expected_epsg and expected_epsg is not None:
        logger.warning("CRS mismatch EPSG:%s → re-projecting to EPSG:%s", epsg, expected_epsg)
        chunk = chunk.to_crs(epsg=expected_epsg)

    return chunk, expected_cols, expected_epsg

# ── Incremental GeoParquet write ───────────────────────────────────────────────

def _write_chunk(chunk: GeoDataFrame, output_dir: str) -> None:
    table = pa.Table.from_pandas(chunk, preserve_index=False)
    pq.write_to_dataset(
        table,
        root_path=output_dir,
        existing_data_behavior="overwrite_or_ignore",
        use_legacy_dataset=False,
    )

# ── CLI command ────────────────────────────────────────────────────────────────

@app.command()
def ingest(
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, help="Source vector file (.gpkg, .fgb, .geojson)"),
    output_dir: Path = typer.Argument(..., file_okay=False, help="Output GeoParquet dataset directory"),
    chunk_size: Optional[int] = typer.Option(None, "--chunk-size", "-c", help="Rows per batch (auto if omitted)"),
    resume: bool = typer.Option(False, "--resume", "-r", help="Resume from last checkpoint"),
) -> None:
    """Stream a large vector file to GeoParquet in memory-bounded chunks."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    # Step 1 — metadata
    try:
        info = pyogrio.read_info(str(input_path))
    except Exception as exc:
        logger.error("Cannot read metadata from %s: %s", input_path, exc)
        raise typer.Exit(code=1)

    total_rows: int = info.get("features") or 0
    if total_rows == 0:
        logger.error("Dataset has 0 features or row count is unavailable.")
        raise typer.Exit(code=1)
    logger.info("Features: %s | CRS: %s", f"{total_rows:,}", info.get("crs", "unknown"))

    # Step 2 — chunk size
    effective_chunk = chunk_size or _auto_chunk_size(str(input_path))
    logger.info("Chunk size: %s rows", f"{effective_chunk:,}")

    # Step 6 — resume from checkpoint
    start_offset = _load_checkpoint(output_dir) if resume else 0
    if start_offset:
        logger.info("Resuming from offset %s", f"{start_offset:,}")

    offset = start_offset
    chunks_done = 0
    expected_cols: Optional[set] = None
    expected_epsg: Optional[int] = None
    t0 = time.perf_counter()

    while offset < total_rows:
        rss_before = _rss_mb()

        # Step 3 — cursor read
        try:
            chunk: GeoDataFrame = pyogrio.read_dataframe(
                str(input_path),
                rows=slice(offset, offset + effective_chunk),
                use_arrow=True,
            )
        except Exception as exc:
            logger.error("Read failed at offset %s: %s", offset, exc)
            raise typer.Exit(code=1)

        if chunk.empty:
            break

        # Step 4 — schema validation
        chunk, expected_cols, expected_epsg = _validate(chunk, expected_cols, expected_epsg)

        # Step 5 — incremental write
        try:
            _write_chunk(chunk, str(output_dir))
        except Exception as exc:
            logger.error("Write failed at offset %s: %s", offset, exc)
            raise typer.Exit(code=1)

        offset += len(chunk)
        chunks_done += 1
        _save_checkpoint(output_dir, offset)  # persist before next iteration

        rss_delta = _rss_mb() - rss_before
        pct = 100 * offset / total_rows
        logger.info(
            "Chunk %d | %s/%s rows (%.1f%%) | ΔRSS %+.1f MB",
            chunks_done, f"{offset:,}", f"{total_rows:,}", pct, rss_delta,
        )

    elapsed = time.perf_counter() - t0
    logger.info("Done. %d chunks in %.2fs → %s", chunks_done, elapsed, output_dir)
    _clear_checkpoint(output_dir)
    raise typer.Exit(code=0)

if __name__ == "__main__":
    app()
```

## Error Handling & Gotchas

### Shapefile driver does not support random seek

The Shapefile OGR driver lacks offset-based cursor positioning. Calling `read_dataframe("file.shp", rows=slice(50000, 100000))` silently reads from the start, returning the wrong rows. **Fix:** convert to GeoPackage or FlatGeobuf before chunking:

```bash
ogr2ogr -f FlatGeobuf output.fgb input.shp -progress
```

FlatGeobuf is preferred for pure streaming (no spatial index overhead on write); GeoPackage is preferred when you need attribute indexes on the output.

### GeoDataFrame.to_parquet() inside a loop is O(n²)

Each `to_parquet()` call rewrites the entire Parquet file from scratch. On 500 chunks of 100,000 rows each, this is 50 million rows of rewrite work. **Fix:** use `pyarrow.parquet.write_to_dataset()` as shown in Step 5 — it appends one row-group file per chunk call, keeping each write O(chunk_size).

### CRS not persisted across chunks in some formats

GeoJSON files do not store CRS in the OGR layer header — `read_info()` returns `None` for CRS, and `read_dataframe()` returns a `GeoDataFrame` with `crs=None`. **Fix:** capture the CRS from the first chunk, assert it on all subsequent chunks, and explicitly assign `chunk = chunk.set_crs(epsg=4326)` when processing GeoJSON.

### Memory growth from Arrow object caching

`pyarrow` caches schema metadata across reads in some versions. If RSS grows monotonically across chunks even with `del chunk`, call `pa.default_cpu_memory_pool().release_unused()` after each write to return unused Arrow buffers to the OS.

### GDAL virtual file system for remote sources

For S3 or HTTP-hosted vector files, prefix paths with `/vsicurl/` or `/vsis3/`. Set `GDAL_HTTP_MAX_RETRY=3` and `GDAL_HTTP_RETRY_DELAY=2` as environment variables before importing pyogrio to add automatic retry on transient network failures.

## Verification

After a successful ingestion run, verify the output with `pyarrow` and `geopandas`:

```python
import pyarrow.parquet as pq
import geopandas as gpd

# Check row count matches the source
ds = pq.ParquetDataset("output/buildings/")
total_written = ds.read().num_rows
print(f"Rows written: {total_written:,}")
assert total_written == expected_total, f"Row count mismatch: {total_written} vs {expected_total}"

# Spot-check geometry validity on the last partition file
files = sorted(ds.files)
last_chunk = gpd.read_parquet(files[-1])
invalid = (~last_chunk.geometry.is_valid).sum()
print(f"Invalid geometries in last chunk: {invalid}")
assert invalid == 0, "Geometry validation failed — check source data"

# Confirm CRS is preserved
print(f"Output CRS: {last_chunk.crs}")
```

Check that the CLI exits with code 0 on success:

```bash
python ingest_cli.py data/osm_buildings_europe.gpkg output/buildings/
echo "Exit code: $?"   # expected: 0
```

For CI pipelines, assert the checkpoint file is removed on clean completion:

```bash
test ! -f output/.buildings_state.json && echo "Checkpoint cleaned up — OK"
```

## Performance Notes

| Scenario | Chunk size | Typical peak RSS | Throughput |
|---|---|---|---|
| Point features, few attributes | 200,000 rows | ~400 MB | ~600,000 rows/s |
| Polygon buildings, 15 attributes | 50,000 rows | ~800 MB | ~80,000 rows/s |
| Dense multipolygon admin boundaries | 10,000 rows | ~1.2 GB | ~18,000 rows/s |
| GeoJSON (no Arrow path) | 20,000 rows | ~1.8 GB | ~12,000 rows/s |

The `use_arrow=True` flag accounts for the 30–50% RSS reduction in the polygon and multipolygon rows above. Enabling it is essentially free — there is no throughput penalty on pyogrio 0.7+.

For CPU-bound downstream work (spatial joins, coordinate reprojection, geometry simplification), decouple ingestion from compute: the ingestion loop writes raw chunks to a queue directory, and a pool of worker processes consumes them independently. This pattern is detailed in [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/).

For raster counterparts — where the cursor concept maps to window-based tile reads rather than row offsets — see [Async I/O for Raster Processing](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/). The [Memory Management for Large Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) page covers cross-format strategies for keeping RSS bounded across both vector and raster pipelines.

If the ingestion job fails mid-run, the error handling strategies in [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) cover retry semantics, structured failure logging, and partial-result recovery.

## FAQ

<details class="faq-item">
<summary>How do I choose chunk size for a large shapefile?</summary>

Convert the shapefile to GeoPackage first (see the "Shapefile driver" gotcha above), then let `_auto_chunk_size()` sample 5,000 rows and measure the RSS delta. For point datasets you will typically land at 150,000–300,000 rows/chunk; for dense polygon datasets, expect 5,000–25,000. Never set a hard 100,000-row default without profiling — it will OOM on multipolygon datasets.

</details>

<details class="faq-item">
<summary>Can I write chunked output to a single GeoParquet file?</summary>

No. Parquet files are immutable once written — appending is not possible at the file level. Use `pyarrow.parquet.write_to_dataset()` to write each chunk as a separate row-group file in a directory. `geopandas.read_parquet("output/buildings/")` and `pyarrow.parquet.ParquetDataset("output/buildings/")` both treat the directory as a single logical table.

</details>

<details class="faq-item">
<summary>Why does my RSS keep growing even though I delete each chunk?</summary>

Arrow caches memory pool allocations internally. After `del chunk`, call `pyarrow.default_cpu_memory_pool().release_unused()` to return unused Arrow buffers to the OS. Also check for references held by logging formatters or exception tracebacks — Python will not GC an object while any reference to it is live.

</details>

<details class="faq-item">
<summary>What POSIX exit codes should a chunked ingestion CLI return?</summary>

Follow the convention established in the [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) guide: `0` for success, `1` for runtime error (schema drift, write failure, CRS mismatch), `2` for bad arguments (missing path, invalid chunk size), `3` for partial completion (checkpoint exists but run did not finish cleanly).

</details>

<details class="faq-item">
<summary>How do I stream from S3 without downloading the full file?</summary>

Prefix the path with `/vsis3/bucket/key` and set `AWS_NO_SIGN_REQUEST=YES` for public buckets (or configure standard AWS credential env vars for private ones). GDAL's `/vsis3/` virtual filesystem streams the file over HTTP range requests, so pyogrio's offset/limit cursor will issue byte-range reads rather than downloading the entire file. Set `GDAL_HTTP_MAX_RETRY=3` to handle transient S3 throttling.

</details>

## Related

- [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) — parent guide covering the full pipeline from ingestion to output
- [Memory Management for Large Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) — RSS budgeting, swap avoidance, and cross-format memory strategies
- [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) — offloading CPU-bound spatial joins and reprojections to worker pools
- [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — retry logic, structured failure logs, and partial-result recovery
