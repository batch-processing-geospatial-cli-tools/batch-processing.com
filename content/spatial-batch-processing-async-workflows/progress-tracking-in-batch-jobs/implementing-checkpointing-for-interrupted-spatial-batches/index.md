---
title: "Checkpointing for Interrupted Spatial Batch Jobs"
description: "Persist atomic checkpoints for Python spatial batch jobs — resume GeoPackage, Shapefile, and raster pipelines where they stopped after OOM kills or SIGTERM."
slug: "implementing-checkpointing-for-interrupted-spatial-batches"
type: "article"
breadcrumb: "Checkpointing Interrupted Spatial Batches"
datePublished: "2024-11-20"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Implementing Checkpointing for Interrupted Spatial Batches",
      "description": "How to persist atomic checkpoint state for spatial batch jobs in Python — resume GeoPackage, Shapefile, and raster pipelines exactly where they stopped after OOM kills, SIGTERM, or network drops.",
      "datePublished": "2024-11-20",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Spatial Batch Processing & Async Workflows", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Progress Tracking in Batch Jobs", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/"},
        {"@type": "ListItem", "position": 4, "name": "Checkpointing Interrupted Spatial Batches", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Implement Checkpointing for Interrupted Spatial Batches",
      "description": "Persist an atomic JSON state file that maps each spatial asset to a completion flag, wrap the processing loop in signal handlers, and resume from the exact offset on restart.",
      "step": [
        {"@type": "HowToStep", "name": "Build the SpatialCheckpoint class", "text": "Create a class that loads existing state from JSON, registers SIGINT/SIGTERM handlers, and exposes mark_complete() and get_pending() methods."},
        {"@type": "HowToStep", "name": "Use atomic file replacement", "text": "Write checkpoint state to a .tmp file then call os.replace() to swap it in — this prevents half-written JSON if the process crashes mid-flush."},
        {"@type": "HowToStep", "name": "Apply format-specific write guards", "text": "Wrap GeoPackage writes in explicit SQLite transactions and write Shapefiles to a temp directory before moving the complete sidecar set to the target path."},
        {"@type": "HowToStep", "name": "Mark assets complete after commit", "text": "Call checkpoint.mark_complete(asset_id) only after a successful write or COMMIT — never before, to prevent false positives that skip re-processing after a partial write."},
        {"@type": "HowToStep", "name": "Verify resumption with a dry-run count", "text": "On restart, log len(pending) vs len(all_assets) and assert that the difference equals the number of completed entries in the checkpoint file."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why use os.replace() instead of directly writing the checkpoint JSON?",
          "acceptedAnswer": {"@type": "Answer", "text": "os.replace() is an atomic POSIX rename. If the process crashes while writing the .tmp file, the original checkpoint remains intact. A direct open('checkpoint.json', 'w') write can leave a truncated or partially flushed file that is unreadable on restart."}
        },
        {
          "@type": "Question",
          "name": "How should I checkpoint a GeoPackage write that inserts thousands of features per asset?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use an explicit SQLite transaction: BEGIN, insert all features, COMMIT, then call mark_complete(). If the process dies between BEGIN and COMMIT, SQLite rolls back the transaction and the asset stays in the pending list, so it will be retried cleanly on restart."}
        },
        {
          "@type": "Question",
          "name": "Can I use this pattern with multiprocessing workers?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes, but the checkpoint file becomes a shared resource. Replace the local JSON file with a SQLite database (using INSERT OR IGNORE) or a Redis SET. Each worker calls SETNX or INSERT ... ON CONFLICT DO NOTHING to claim an asset before starting, then writes a completion record only after the format-specific commit succeeds."}
        },
        {
          "@type": "Question",
          "name": "What stable identifier should I use as the asset key?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use absolute paths (str(Path(asset).resolve())), tile coordinates (zoom/x/y tuples), or content-addressable hashes (SHA-256 of the source file). Avoid relative paths, database row cursors, or OS-assigned inode numbers — all of these can change between runs."}
        }
      ]
    }
  ]
}
</script>

To implement checkpointing for interrupted spatial batches, persist a lightweight atomic state file that maps each spatial asset — file path, feature ID, or tile coordinate — to a completion flag. Wrap the processing loop in a `SIGINT`/`SIGTERM` handler that flushes state before exit, and on restart deserialize the file, filter out completed items, and resume from the exact offset. This eliminates redundant I/O and prevents partial writes in formats like GeoPackage and Shapefile.

This page is part of the [Progress Tracking in Batch Jobs](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) guide, which sits inside the broader [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

| Requirement | Detail |
|---|---|
| Python | 3.9+ (`os.replace` atomicity; `signal` module stable) |
| Standard library only | `json`, `os`, `signal`, `pathlib`, `logging` — no extra pip installs |
| Spatial I/O (optional) | `pyogrio` or `rasterio` for the actual processing steps; `pip install pyogrio rasterio` |
| POSIX OS | `os.replace` atomic rename is guaranteed on Linux/macOS; on Windows it is also atomic since Python 3.3 |

For the async variant of this pattern — processing GeoJSON concurrently while checkpointing — see [Processing 100k GeoJSON Files with Python asyncio](https://www.batch-processing.com/spatial-batch-processing-async-workflows/async-io-for-raster-processing/processing-100k-geojson-files-with-python-asyncio/).

## Checkpoint Lifecycle

The diagram below shows the three states each spatial asset moves through — and the two points where a crash can occur — to illustrate why the checkpoint write must happen *after* the format-specific commit.

<svg viewBox="0 0 740 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Spatial asset checkpoint lifecycle: pending, processing (crash zone), committed, then checkpoint written" style="width:100%;max-width:740px;display:block;margin:1.5rem auto">
  <title>Spatial asset checkpoint lifecycle</title>
  <desc>A spatial asset starts as Pending. It moves to Processing (write/commit in progress), which is the crash zone where interruption can occur. On successful format commit the asset reaches Committed. Only then is the checkpoint state flushed to disk, marking the asset Done. If a crash occurs during Processing the asset remains Pending for the next run.</desc>
  <defs>
    <marker id="ck-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- State: Pending -->
  <rect x="20" y="70" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
  <text x="85" y="97" text-anchor="middle" font-size="13" font-weight="600" font-family="inherit" fill="currentColor">Pending</text>
  <text x="85" y="115" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.65">not in state file</text>
  <!-- Arrow: Pending → Processing -->
  <line x1="152" y1="100" x2="208" y2="100" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#ck-arrow)"/>
  <text x="180" y="93" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">start</text>
  <!-- State: Processing (crash zone) -->
  <rect x="210" y="55" width="155" height="90" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.45"/>
  <text x="287" y="83" text-anchor="middle" font-size="13" font-weight="600" font-family="inherit" fill="currentColor">Processing</text>
  <text x="287" y="100" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.65">write / COMMIT</text>
  <text x="287" y="116" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.5">⚠ crash zone</text>
  <text x="287" y="132" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.45">(no checkpoint yet)</text>
  <!-- Arrow: crash → back to Pending -->
  <path d="M287,55 Q287,20 85,20 Q85,55 85,68" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.35" marker-end="url(#ck-arrow)"/>
  <text x="186" y="14" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.45">crash → retry next run</text>
  <!-- Arrow: Processing → Committed -->
  <line x1="367" y1="100" x2="423" y2="100" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#ck-arrow)"/>
  <text x="395" y="93" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">commit</text>
  <!-- State: Committed -->
  <rect x="425" y="70" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
  <text x="490" y="97" text-anchor="middle" font-size="13" font-weight="600" font-family="inherit" fill="currentColor">Committed</text>
  <text x="490" y="115" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.65">format write OK</text>
  <!-- Arrow: Committed → Done -->
  <line x1="557" y1="100" x2="613" y2="100" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#ck-arrow)"/>
  <text x="585" y="93" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">flush</text>
  <!-- State: Done -->
  <rect x="615" y="70" width="110" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
  <text x="670" y="97" text-anchor="middle" font-size="13" font-weight="600" font-family="inherit" fill="currentColor">Done</text>
  <text x="670" y="115" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.65">state[id] = true</text>
</svg>

## Complete Working Implementation

The script below is self-contained. It processes a directory of GeoPackage files in EPSG:4326 using `pyogrio`, checkpoints each completed file to `spatial_batch_state.json`, and resumes cleanly on restart. Replace the `process_one_asset` function body with your actual transformation logic.

```python
#!/usr/bin/env python3
"""
Spatial batch processor with atomic checkpointing.

Usage:
    python checkpoint_batch.py /data/raw_gpkg /data/output_gpkg
    # Kill with Ctrl-C, then re-run — it resumes from the last completed file.

Requirements:
    pip install pyogrio
"""
import json
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Optional

import pyogrio
import geopandas as gpd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

CHECKPOINT_FILE = "spatial_batch_state.json"
TARGET_CRS = "EPSG:4326"


class SpatialCheckpoint:
    """Atomic, signal-aware checkpoint for spatial batch jobs."""

    def __init__(self, path: str = CHECKPOINT_FILE) -> None:
        self.path = Path(path)
        self.state: dict[str, bool] = self._load()
        self.interrupted = False
        # Flush on Ctrl-C (SIGINT) and orchestrator shutdown (SIGTERM)
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _load(self) -> dict[str, bool]:
        if not self.path.exists():
            return {}
        try:
            with open(self.path) as fh:
                return json.load(fh)
        except json.JSONDecodeError:
            # Truncated write from a previous crash — start fresh rather than
            # silently reprocessing all assets with wrong state
            log.warning("Checkpoint file corrupt; starting fresh: %s", self.path)
            return {}

    def _save(self) -> None:
        # Write to .tmp then os.replace() — atomic on POSIX and Windows 3.3+
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w") as fh:
            json.dump(self.state, fh, indent=2)
        os.replace(str(tmp), str(self.path))   # ← crash-safe atomic rename

    def _handle_signal(self, signum: int, frame: object) -> None:
        log.info("Signal %d received — flushing checkpoint before exit.", signum)
        self.interrupted = True
        self._save()
        # Do NOT sys.exit() here; let the loop's `if checkpoint.interrupted` branch
        # exit cleanly so in-flight writes can finish their current iteration.

    def mark_complete(self, asset_id: str) -> None:
        """Call this AFTER the format-specific commit succeeds — never before."""
        self.state[asset_id] = True
        self._save()

    def get_pending(self, all_assets: list[str]) -> list[str]:
        """Return only assets that have not yet been successfully processed."""
        return [a for a in all_assets if not self.state.get(a, False)]

    @property
    def completed_count(self) -> int:
        return sum(1 for v in self.state.values() if v)


def process_one_asset(src_path: Path, dst_dir: Path) -> None:
    """
    Read a GeoPackage with pyogrio, reproject to EPSG:4326, write output.

    pyogrio is preferred over fiona for vector I/O: it uses Arrow-backed
    columnar reads that are ~5–10x faster on large feature sets.
    """
    gdf: gpd.GeoDataFrame = pyogrio.read_dataframe(
        str(src_path),
        use_arrow=True,    # Arrow-backed read; requires pyogrio >= 0.6
    )

    if gdf.crs is None:
        raise ValueError(f"No CRS on {src_path.name} — cannot reproject to {TARGET_CRS}")

    if str(gdf.crs) != TARGET_CRS:
        gdf = gdf.to_crs(TARGET_CRS)   # explicit EPSG:4326 coercion

    dst_path = dst_dir / src_path.name
    # pyogrio.write_dataframe wraps the underlying GPKG write in a single
    # transaction; on completion the SQLite COMMIT is issued before returning.
    pyogrio.write_dataframe(gdf, str(dst_path), driver="GPKG")


def process_spatial_batch(src_dir: Path, dst_dir: Path) -> int:
    dst_dir.mkdir(parents=True, exist_ok=True)

    all_assets = sorted(str(p) for p in src_dir.glob("*.gpkg"))
    if not all_assets:
        log.error("No .gpkg files found under %s", src_dir)
        return 2   # POSIX exit 2 = bad arguments / no input

    checkpoint = SpatialCheckpoint()
    pending = checkpoint.get_pending(all_assets)

    log.info(
        "Batch: %d total, %d already done, %d pending.",
        len(all_assets),
        checkpoint.completed_count,
        len(pending),
    )

    for asset in pending:
        if checkpoint.interrupted:
            log.info("Graceful shutdown — stopping before %s.", Path(asset).name)
            return 1   # POSIX exit 1 = interrupted / non-fatal error

        src_path = Path(asset)
        try:
            log.info("Processing %s", src_path.name)
            process_one_asset(src_path, dst_dir)
            # mark_complete AFTER the write transaction commits
            checkpoint.mark_complete(asset)
            log.info("Done: %s", src_path.name)
        except Exception as exc:
            # Isolate failures: one bad file does not abort the batch
            log.error("Failed %s: %s", src_path.name, exc)
            # Asset stays pending; it will be retried on the next run

    log.info("Batch finished. %d/%d assets processed.", checkpoint.completed_count, len(all_assets))
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Resumable spatial batch processor")
    parser.add_argument("src_dir", type=Path, help="Directory of source .gpkg files")
    parser.add_argument("dst_dir", type=Path, help="Destination directory for output .gpkg files")
    args = parser.parse_args()

    sys.exit(process_spatial_batch(args.src_dir, args.dst_dir))
```

## Step Annotations

1. **`os.replace(str(tmp), str(self.path))` — crash-safe state flush.**
   `os.replace` performs an atomic rename at the OS level. If the process crashes while writing to the `.tmp` file, the original `spatial_batch_state.json` is untouched. A plain `open(path, "w")` write can leave a zero-byte or truncated JSON file that raises `json.JSONDecodeError` on the next run. The `_load` method's `JSONDecodeError` catch is a last-resort safety net, not a substitute for atomicity.

2. **`signal.signal(signal.SIGINT, self._handle_signal)` — graceful `Ctrl-C` handling.**
   The handler sets `self.interrupted = True` and calls `_save()` but does *not* call `sys.exit()`. This lets the current iteration of the loop finish its `process_one_asset` call (including the SQLite COMMIT) before the loop's `if checkpoint.interrupted` check exits cleanly. Forcing an immediate exit from inside a signal handler risks leaving a half-written GeoPackage on disk.

3. **`pyogrio.read_dataframe(..., use_arrow=True)` — columnar I/O for large feature sets.**
   Arrow-backed reads via `pyogrio` load feature attribute tables directly into columnar memory without the row-by-row Python overhead of `fiona`. For files with hundreds of thousands of features and wide attribute schemas — common in parcel or building footprint datasets — this is 5–10x faster than `fiona.open`. The [Chunked Vector Data Reading](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) guide covers how to extend this pattern for datasets that exceed available RAM.

4. **`gdf.to_crs(TARGET_CRS)` — explicit EPSG:4326 coercion before write.**
   Spatial format corruption frequently originates from silent CRS mismatches: a source file in EPSG:32632 (UTM zone 32N) written to a GeoPackage without reprojection, then consumed by a downstream tool that assumes EPSG:4326. Checking `gdf.crs is None` and reprojecting explicitly eliminates this class of corruption. See [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) for a structured approach to logging CRS mismatches across a batch.

5. **`checkpoint.mark_complete(asset)` placed *after* `process_one_asset` returns.**
   `pyogrio.write_dataframe` issues its SQLite COMMIT before returning. So by the time `mark_complete` is called, the on-disk GeoPackage is in a consistent state. If you use a lower-level `sqlite3` connection directly, call `con.commit()` explicitly before `mark_complete` — never inside a `finally` block that also calls `mark_complete`, as a failed COMMIT would then incorrectly mark the asset as done.

6. **`return 1` on `checkpoint.interrupted`, `return 2` on no input, `return 0` on success.**
   These follow the POSIX convention used throughout [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/): exit 0 = success, 1 = runtime interruption or non-fatal error, 2 = bad arguments or missing input. Orchestrators (Airflow, Prefect, shell scripts) can test `$?` to distinguish a clean resume-ready stop from a configuration problem.

## Named Gotcha: Shapefiles and Orphaned Sidecars

GeoPackage (SQLite-backed) is transactional; if a write is interrupted, SQLite rolls back cleanly and the file is undamaged. **Shapefiles are not transactional.** An interrupted write leaves behind partial `.shp`, `.shx`, `.dbf`, and `.cpg` files. On the next run, `pyogrio.read_dataframe` on the orphaned set raises either `pyogrio.errors.DataSourceError` or returns a `GeoDataFrame` with zero features, neither of which is obviously the cause of the downstream failure.

**Fix:** write Shapefiles to a temporary staging path, validate geometry count, then move the complete sidecar set atomically:

```python
import shutil
import tempfile
from pathlib import Path
import pyogrio
import geopandas as gpd

def write_shapefile_safe(gdf: gpd.GeoDataFrame, dst_path: Path) -> None:
    """
    Write a Shapefile via a staging directory to avoid orphaned sidecars.
    dst_path should be the .shp file; all sidecars share the same stem.
    """
    stem = dst_path.stem
    with tempfile.TemporaryDirectory() as staging:
        staging_path = Path(staging) / f"{stem}.shp"
        pyogrio.write_dataframe(gdf, str(staging_path), driver="ESRI Shapefile")

        # Verify the staged output before moving
        staged_gdf = pyogrio.read_dataframe(str(staging_path))
        if len(staged_gdf) != len(gdf):
            raise RuntimeError(
                f"Staged shapefile feature count mismatch: "
                f"expected {len(gdf)}, got {len(staged_gdf)}"
            )

        # Move all sidecars (.shp, .shx, .dbf, .cpg, .prj) atomically
        for sidecar in Path(staging).glob(f"{stem}.*"):
            shutil.move(str(sidecar), str(dst_path.parent / sidecar.name))
```

Only call `checkpoint.mark_complete(asset)` after `write_shapefile_safe` returns without raising.

## Verification

After an interrupted run and a resumed run, confirm the checkpoint state is consistent:

```bash
# Inspect the checkpoint file — all completed assets should show true
python3 - <<'EOF'
import json, pathlib, sys

cp = pathlib.Path("spatial_batch_state.json")
if not cp.exists():
    print("No checkpoint file found.")
    sys.exit(0)

state = json.loads(cp.read_text())
done  = [k for k, v in state.items() if v]
total = len(state)
print(f"Checkpoint: {len(done)}/{total} assets marked complete")
for path in done:
    p = pathlib.Path(path)
    if not p.exists():
        print(f"  WARNING: checkpoint entry exists but file missing: {p.name}")
EOF

# Cross-check: count output files vs checkpoint entries
python3 - <<'EOF'
import json, pathlib, sys

state   = json.loads(pathlib.Path("spatial_batch_state.json").read_text())
done    = {k for k, v in state.items() if v}
outputs = set(str(p) for p in pathlib.Path("/data/output_gpkg").glob("*.gpkg"))

missing_outputs = done - outputs
extra_outputs   = outputs - done

if missing_outputs:
    print("Checkpoint says done but output file absent:")
    for p in sorted(missing_outputs):
        print(f"  {p}")
if extra_outputs:
    print("Output file exists but not in checkpoint (may be from a previous run):")
    for p in sorted(extra_outputs):
        print(f"  {p}")
if not missing_outputs and not extra_outputs:
    print("Checkpoint and output directory are in sync.")
EOF
```

## FAQ

<details class="faq-item">
<summary>How often should I flush the checkpoint — after every asset, or in batches?</summary>

Flushing after every asset gives zero-rework guarantees: a crash between two consecutive flushes costs at most one asset. The overhead of an atomic JSON write (a small file rename) is negligible compared to a GDAL or pyogrio write. For high-throughput pipelines processing thousands of small tiles per second, batch the checkpoint flush every N items (e.g. `if processed_count % 50 == 0: checkpoint._save()`) and accept up to N assets of rework on crash.

</details>

<details class="faq-item">
<summary>Can I run two workers against the same checkpoint file?</summary>

Not safely with a plain JSON file — concurrent writes will corrupt it. For multi-worker resumable batches, replace the JSON file with a SQLite database and use `INSERT OR IGNORE INTO completed (asset_id) VALUES (?)` as the mark-complete operation. SQLite's WAL mode supports multiple concurrent readers and one writer without lock contention for this workload. For distributed workers across machines, use Redis `SETNX` or PostgreSQL `INSERT ... ON CONFLICT DO NOTHING`.

</details>

<details class="faq-item">
<summary>What should I use as the asset ID — absolute path or relative path?</summary>

Always use absolute paths (`str(Path(asset).resolve())`). Relative paths break when the script is invoked from a different working directory or when the source directory is moved between runs. If assets can be re-named (e.g. ingested from an object-store URI), use a stable content hash instead: `hashlib.sha256(Path(asset).read_bytes()).hexdigest()[:16]`.

</details>

<details class="faq-item">
<summary>How do I handle assets that should be skipped permanently (not retried)?</summary>

Add a separate `failed` key to the state dict alongside the `completed` key, or use a tri-value state (`"pending"`, `"done"`, `"failed"`). Update `get_pending` to filter out both `"done"` and `"failed"` entries. Log failures to a structured JSON error log (see [Logging Spatial Transformation Results to Structured JSON](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/)) so they can be audited separately from the checkpoint state.

</details>

---

## Related

- [Progress Tracking in Batch Jobs](https://www.batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) — the parent guide covering thread-safe counters, Rich progress dashboards, and async-compatible renderers for the pipelines this checkpointing pattern protects
- [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — structured logging, retry strategies, and exit-code conventions that complement checkpoint-based resumption
- [Chunked Vector Data Reading](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — how to stream large vector datasets in fixed-size batches, a natural companion to per-chunk checkpointing
