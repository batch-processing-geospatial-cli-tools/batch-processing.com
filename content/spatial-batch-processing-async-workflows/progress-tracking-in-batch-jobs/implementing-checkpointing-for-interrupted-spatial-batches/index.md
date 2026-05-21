# Implementing checkpointing for interrupted spatial batches

To implement checkpointing for interrupted spatial batches, persist a lightweight, atomic state file that maps each spatial asset (file path, feature ID, or tile coordinate) to a completion flag, and wrap your processing loop in a signal-aware `try/except` block that flushes the state after every successful chunk. On restart, deserialize the state, filter out completed items, and resume from the exact offset. This eliminates redundant I/O, prevents partial writes in spatial formats like GeoPackage or Shapefile, and integrates cleanly with CLI toolchains.

Spatial workloads are inherently I/O heavy and frequently interrupted by OOM kills, network drops, or manual `SIGINT`. Without a deterministic resume mechanism, you waste compute cycles and risk corrupting spatial indexes or leaving orphaned `.cpg`/`.shx` sidecars. Effective checkpointing sits at the core of [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) and becomes production-ready when paired with structured [Progress Tracking in Batch Jobs](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/). Below is a battle-tested pattern for Python GIS CLI tools.

## Core Implementation Pattern

The following implementation uses JSON for human-readable state inspection, atomic file replacement to prevent corruption on crash, and POSIX signal handlers for graceful interruption. It assumes a directory of GeoPackage files but adapts trivially to raster tiles, vector features, or database cursors.

```python
import json
import os
import sys
import signal
import logging
from pathlib import Path
from typing import Dict, List, Set

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

CHECKPOINT_FILE = "spatial_batch_state.json"

class SpatialCheckpoint:
    def __init__(self, path: str = CHECKPOINT_FILE):
        self.path = Path(path)
        self.state: Dict[str, bool] = self._load()
        self.interrupted = False
        # Register graceful shutdown handlers
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _load(self) -> Dict[str, bool]:
        if not self.path.exists():
            return {}
        try:
            with open(self.path, "r") as f:
                return json.load(f)
        except json.JSONDecodeError:
            logger.warning("Corrupted checkpoint file. Starting fresh.")
            return {}

    def _save(self) -> None:
        # Atomic write: write to .tmp then replace to prevent partial JSON on crash
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w") as f:
            json.dump(self.state, f, indent=2)
        # os.replace guarantees atomicity across POSIX and Windows
        os.replace(str(tmp), str(self.path))

    def _handle_signal(self, signum: int, frame) -> None:
        logger.info(f"Signal {signum} received. Flushing checkpoint...")
        self.interrupted = True
        self._save()

    def mark_complete(self, asset_id: str) -> None:
        self.state[asset_id] = True
        # Flush immediately for safety; batch flushing is an option for high-throughput loops
        self._save()

    def get_pending(self, all_assets: List[str]) -> List[str]:
        """Filter out already-processed assets."""
        return [a for a in all_assets if not self.state.get(a, False)]
```

### Why This Works
- **Atomic Persistence**: Writing to a `.tmp` file and calling `os.replace()` prevents half-written JSON if the process crashes mid-flush. See Python’s [os.replace documentation](https://docs.python.org/3/library/os.html#os.replace) for cross-platform guarantees.
- **Signal Awareness**: Registering `SIGINT` and `SIGTERM` allows `Ctrl+C` or orchestrator shutdowns to trigger a clean flush before exit.
- **Idempotent State**: The `Dict[str, bool]` structure is append-only. Re-processing a completed asset is a no-op, making the system safe for retries.

## Integrating with the Processing Loop

The checkpoint class is only useful when tightly coupled to your execution loop. Below is a minimal, production-ready pattern that resumes exactly where it left off.

```python
def process_spatial_batch(asset_paths: List[str]) -> None:
    checkpoint = SpatialCheckpoint()
    pending = checkpoint.get_pending(asset_paths)
    logger.info(f"Resuming batch: {len(pending)} assets remaining out of {len(asset_paths)}")

    for asset in pending:
        if checkpoint.interrupted:
            logger.info("Graceful shutdown requested. Exiting loop.")
            break

        try:
            # Replace with your actual spatial processing logic (e.g., GDAL, GeoPandas, rasterio)
            # _process_geopackage(asset)
            logger.info(f"Processing: {asset}")
            
            # Mark complete only after successful execution
            checkpoint.mark_complete(asset)
        except Exception as e:
            logger.error(f"Failed {asset}: {e}")
            # Optional: move to a dead-letter queue or skip
            continue

    if not checkpoint.interrupted:
        logger.info("Batch completed successfully.")
```

### Key Design Decisions
1. **Flush Frequency**: Flushing after every asset guarantees zero rework on crash but adds I/O overhead. For high-throughput pipelines, batch flushes every `N` items or use a write-ahead log (WAL) pattern.
2. **Asset Identification**: Use stable identifiers (absolute paths, UUIDs, or tile coordinates). Avoid relative paths or ephemeral database cursors.
3. **Error Isolation**: Catch exceptions per asset. A single malformed GeoPackage shouldn't abort the entire batch.

## Spatial Format & Corruption Safeguards

Spatial file formats behave differently under interruption, and checkpointing must account for their internal structures:

- **GeoPackage (SQLite-backed)**: Supports explicit transactions. Wrap your write logic in `BEGIN TRANSACTION` / `COMMIT` to ensure atomic feature insertion. If interrupted mid-transaction, SQLite rolls back cleanly, but your checkpoint must only mark the asset complete after `COMMIT` succeeds. Refer to the [GDAL GeoPackage driver documentation](https://gdal.org/drivers/vector/gpkg.html#transactions) for transaction best practices.
- **Shapefiles**: Not transactional. Interrupted writes leave orphaned `.shp`, `.shx`, or `.dbf` sidecars. Always write to a temporary directory, validate geometry, then move the complete trio to the target path before marking the checkpoint.
- **Cloud-Optimized Formats (GeoParquet, Zarr, Cloud-Optimized GeoTIFF)**: Designed for append/partial reads. Checkpoint at the chunk or tile level rather than the file level to maximize parallelism.

## Production Hardening & Async Integration

When scaling beyond single-node CLI tools, adapt the pattern for distributed environments:

- **State Storage**: Replace local JSON with Redis, DynamoDB, or PostgreSQL. Use `SETNX` or `INSERT ... ON CONFLICT DO NOTHING` to prevent race conditions across workers.
- **Lease-Based Locking**: Assign a time-bound lease per asset to prevent duplicate processing if a worker crashes after claiming a task but before updating state.
- **Async/Queue Integration**: Pair this checkpoint pattern with Celery, RQ, or AWS Step Functions. The checkpoint file becomes your source of truth for job reconciliation, while the queue handles scheduling and retries.

For teams building resilient pipelines, this deterministic resume logic forms the foundation of reliable [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/). When combined with structured metrics (duration per chunk, error rates, bytes processed), it enables accurate [Progress Tracking in Batch Jobs](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) without sacrificing throughput or risking data corruption.

### Quick Validation Checklist
- [ ] State file uses atomic replacement (`os.replace`)
- [ ] Signal handlers flush state before exit
- [ ] Checkpoint marks assets complete *after* successful write/commit
- [ ] Pending filter uses stable, absolute identifiers
- [ ] Spatial format transactions or temp-directory patterns are applied
- [ ] Error handling isolates failures to individual assets

Implementing checkpointing for interrupted spatial batches transforms fragile, all-or-nothing scripts into resilient, production-grade data pipelines. Start with the atomic JSON pattern above, validate against your target format’s transaction model, and scale to distributed state stores as your workload grows.