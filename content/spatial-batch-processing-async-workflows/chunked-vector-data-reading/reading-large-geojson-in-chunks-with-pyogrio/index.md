---
title: "Reading Large GeoJSON in Chunks with pyogrio"
description: "Stream a multi-gigabyte GeoJSON in bounded feature batches using pyogrio skip/max_features so memory stays flat regardless of file size."
slug: "reading-large-geojson-in-chunks-with-pyogrio"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Chunked Vector Data Reading for Spatial Pipelines"
    url: "/spatial-batch-processing-async-workflows/chunked-vector-data-reading/"
  - label: "Reading Large GeoJSON in Chunks with pyogrio"
    url: "/spatial-batch-processing-async-workflows/chunked-vector-data-reading/reading-large-geojson-in-chunks-with-pyogrio/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Reading Large GeoJSON in Chunks with pyogrio

To read a multi-gigabyte GeoJSON without loading it all into RAM, drive `pyogrio.read_dataframe(path, skip_features=offset, max_features=batch_size)` in a loop, advancing `offset` by `batch_size` each pass until a read returns fewer than `batch_size` features. Each batch arrives as a small `GeoDataFrame` you reproject, process, and release, so peak memory tracks one batch instead of the file. This walks through one pattern from the [Chunked Vector Data Reading for Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) guide, part of the [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install pyogrio geopandas pyproj` (pyogrio 0.7+ ships GDAL wheels, so no separate system GDAL is required; a conda GDAL 3.4+ also works)
- A large GeoJSON to test against — any FeatureCollection with hundreds of thousands of features

For the memory model behind why one batch must be released before the next is read, pair this with [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/). For the wider batch-processing context, start from the [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) overview.

## How Windowed Reads Bound Memory

A naive `geopandas.read_file(path)` parses the entire FeatureCollection into one `GeoDataFrame`, so resident memory scales with file size and a 4 GB GeoJSON can push a worker past 12 GB after geometry and index overhead. The windowed approach instead pulls a fixed slice per iteration. The parser reads only `batch_size` features into Python objects at a time; the previous batch is freed once it leaves scope. Memory stays flat, but note the trade-off spelled out in the gotcha below: GeoJSON is a plain text stream with no index, so each `skip_features` seek re-parses everything before the offset.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Windowed reading of a large GeoJSON: a sliding batch of features is read, reprojected to EPSG 4326, processed, and released while resident memory stays flat" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Windowed GeoJSON reading keeps memory flat</title>
  <desc>A long horizontal bar represents a multi-gigabyte GeoJSON file. A highlighted window slides across it in three positions. Each window feeds a small pipeline that reprojects to EPSG 4326, processes, and releases the batch. A memory gauge below stays flat across all three positions.</desc>
  <!-- File bar -->
  <text x="360" y="28" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">large.geojson (4 GB, no spatial index)</text>
  <rect x="30" y="42" width="660" height="40" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.2"/>
  <!-- Window slices -->
  <rect x="30" y="42" width="200" height="40" rx="5" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.6"/>
  <text x="130" y="66" text-anchor="middle" font-size="10.5" fill="currentColor">skip=0</text>
  <rect x="250" y="42" width="200" height="40" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2" stroke-dasharray="4 3"/>
  <text x="350" y="66" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">skip=batch</text>
  <rect x="470" y="42" width="200" height="40" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2" stroke-dasharray="4 3"/>
  <text x="570" y="66" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">skip=2*batch</text>
  <!-- Arrow down to pipeline -->
  <line x1="130" y1="82" x2="130" y2="122" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrDown)"/>
  <!-- Pipeline boxes -->
  <rect x="40" y="122" width="150" height="42" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="115" y="140" text-anchor="middle" font-size="10.5" fill="currentColor">read_dataframe</text>
  <text x="115" y="155" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">max_features batch</text>
  <line x1="190" y1="143" x2="240" y2="143" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrRight)"/>
  <rect x="240" y="122" width="150" height="42" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#818cf8" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="315" y="140" text-anchor="middle" font-size="10.5" fill="currentColor">to_crs</text>
  <text x="315" y="155" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">EPSG:4326</text>
  <line x1="390" y1="143" x2="440" y2="143" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrRight)"/>
  <rect x="440" y="122" width="150" height="42" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="515" y="140" text-anchor="middle" font-size="10.5" fill="currentColor">process</text>
  <text x="515" y="155" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">consumer callback</text>
  <line x1="590" y1="143" x2="618" y2="143" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#arrRight)"/>
  <rect x="620" y="122" width="70" height="42" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="655" y="140" text-anchor="middle" font-size="10.5" fill="currentColor">release</text>
  <text x="655" y="155" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">gc</text>
  <!-- Memory gauge -->
  <text x="360" y="212" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" opacity="0.9">resident memory (RSS) across the loop</text>
  <rect x="30" y="228" width="660" height="70" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.2"/>
  <!-- flat memory line -->
  <line x1="45" y1="270" x2="675" y2="270" stroke="#15803d" stroke-opacity="0.8" stroke-width="2"/>
  <text x="360" y="290" text-anchor="middle" font-size="10.5" fill="#15803d" opacity="0.9">flat: one batch plus parser buffer, independent of file size</text>
  <text x="60" y="248" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">batch 1</text>
  <text x="360" y="248" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">batch 2</text>
  <text x="640" y="248" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">batch 3</text>
  <defs>
    <marker id="arrDown" markerWidth="7" markerHeight="7" refX="3.5" refY="6" orient="auto">
      <path d="M0,0 L7,0 L3.5,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
    <marker id="arrRight" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The module below exposes `iter_geojson_batches`, a generator that yields reprojected `GeoDataFrame` chunks, and a `main` that drives it over a file path. Copy it, point it at your GeoJSON, and run. Nothing accumulates across iterations, so it runs the same on a 40 MB file and a 40 GB one:

```python
#!/usr/bin/env python3
"""
Stream a large GeoJSON in bounded batches with pyogrio.
Usage: python chunk_geojson.py ./data/large.geojson --batch 50000
"""
import sys
import argparse
import logging
from pathlib import Path
from typing import Iterator

import pyogrio
import geopandas as gpd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

TARGET_CRS = "EPSG:4326"

def iter_geojson_batches(
    path: Path,
    batch_size: int = 50_000,
    target_crs: str = TARGET_CRS,
) -> Iterator[gpd.GeoDataFrame]:
    """Yield fixed-size GeoDataFrame batches from a large GeoJSON.

    Each batch is a windowed read via pyogrio.read_dataframe using
    skip_features (the offset) and max_features (the window length).
    The generator holds at most one batch in memory at a time; the
    caller must fully consume each batch before requesting the next.
    """
    # read_info parses only the header/metadata, not the geometries,
    # so it is cheap even on a multi-gigabyte file.
    info = pyogrio.read_info(path)
    total = info["features"]
    logging.info("Total features: %d (source CRS: %s)", total, info["crs"])

    offset = 0
    while offset < total:
        batch = pyogrio.read_dataframe(
            path,
            skip_features=offset,       # start of this window
            max_features=batch_size,    # window length
        )
        if len(batch) == 0:
            break

        # Reproject the small batch now, while it is cheap to transform.
        # to_crs is a no-op if the source already matches the target.
        if batch.crs is not None and batch.crs.to_string() != target_crs:
            batch = batch.to_crs(target_crs)

        yield batch

        offset += len(batch)
        # A short batch means we reached the end of the file.
        if len(batch) < batch_size:
            break

def process_batch(batch: gpd.GeoDataFrame) -> int:
    """Replace with real work: write to a sink, aggregate, filter, etc.

    Returns the number of features handled so the driver can total them.
    Keeping the batch local means it is released as soon as this returns.
    """
    # Example: keep only features whose geometry is valid, then count.
    valid = batch[batch.geometry.is_valid]
    return len(valid)

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stream a large GeoJSON in bounded pyogrio batches"
    )
    parser.add_argument("path", type=Path, help="Path to the source GeoJSON")
    parser.add_argument(
        "--batch", type=int, default=50_000,
        help="Features per batch (default: 50000)",
    )
    args = parser.parse_args()

    if not args.path.exists():
        logging.error("File not found: %s", args.path)
        sys.exit(2)  # usage/argument error

    handled = 0
    n_batches = 0
    for batch in iter_geojson_batches(args.path, batch_size=args.batch):
        handled += process_batch(batch)
        n_batches += 1
        logging.info("batch %d: %d features (running total %d)",
                     n_batches, len(batch), handled)
        # `batch` is rebound on the next iteration; the old one is freed.

    logging.info("Done. %d batches, %d features processed.", n_batches, handled)
    sys.exit(0)

if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`pyogrio.read_info(path)`** — parses only the layer header (feature count, CRS, geometry type, field schema), not the geometries. It gives the loop a definite `total` to stop at without a full scan. On a headerless or streamed source where the count is unknown, drop this and rely solely on the short-batch break.

2. **`skip_features=offset`, `max_features=batch_size`** — this is the windowing pair. `skip_features` is the number of features to discard from the start; `max_features` caps how many are returned. Together they select the half-open window `[offset, offset + batch_size)`. Both are passed straight through to GDAL's OGR layer reader.

3. **`if len(batch) == 0: break`** — guards the case where the file has exactly `total` features and the final offset lands past the end. An empty read is the unambiguous end signal even when the counted `total` was stale.

4. **`batch.to_crs(target_crs)` inside the loop** — reprojection happens per batch, not once at the end, because there is no end state holding the whole dataset. Guarding on `batch.crs.to_string()` skips the transform when the source is already `EPSG:4326`, avoiding a wasted pyproj pipeline build per batch.

5. **`offset += len(batch)`** — advance by the count actually returned, not by `batch_size`. If a batch comes back short because of a filter at the driver level, using the real length keeps the window aligned and avoids skipping features.

6. **`len(batch) < batch_size: break`** — the primary end-of-file signal. A read that returns fewer features than requested means the file is exhausted, so the loop exits without a final wasted `read_dataframe` call that would re-parse the entire file only to return nothing.

## Named Gotcha: GeoJSON Has No Index, So skip_features Re-Parses From the Top

GeoJSON is a single JSON document with no spatial index and no feature offset table. To honour `skip_features=1_000_000`, GDAL's GeoJSON driver must parse and discard the first one million features before it can return anything. Do this for every batch and the total parsing work grows with the square of the feature count — reading a file in `k` batches re-parses the prefix `k` times, which is O(n squared) in the number of features. On a 4 GB file this can turn a two-minute read into an hour, even though memory stays perfectly flat.

The fix is to stop paying the tax on repeated reads: convert the GeoJSON to an indexed format once, then chunk that. FlatGeobuf and GeoPackage both support constant-time offset seeks, so `skip_features` becomes O(1):

```python
import pyogrio

# One full pass to convert; afterwards every skip_features seek is O(1).
gdf = pyogrio.read_dataframe("./data/large.geojson")
pyogrio.write_dataframe(gdf, "./data/large.fgb", driver="FlatGeobuf")
```

If the source itself is too large to load for the conversion, stream the conversion batch-by-batch with the same windowed loop (paying the O(n squared) cost once), writing each batch to the FlatGeobuf output with `append=True`. After that, all downstream chunked reads run against the indexed `.fgb`. For the deeper comparison of driver behaviour under large reads, see [pyogrio vs Fiona for Large Vector Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/pyogrio-vs-fiona-for-large-vector-datasets/).

## Verification

The point of chunking is flat memory, so verify that directly: sample the process's resident set size (RSS) while it runs and confirm it does not climb with the number of batches.

```bash
# Run the chunker in the background and sample its RSS once a second.
python3 chunk_geojson.py ./data/large.geojson --batch 50000 &
PID=$!
while kill -0 "$PID" 2>/dev/null; do
    # RSS in MB for the process; should hover around one-batch size.
    ps -o rss= -p "$PID" | awk '{printf "RSS: %.1f MB\n", $1/1024}'
    sleep 1
done
```

A correct run shows RSS rising once to a plateau as the first batch loads, then staying flat for the whole file. If RSS climbs batch after batch, a reference to an old batch is being retained — check that `process_batch` is not appending each `GeoDataFrame` to a module-level list. Confirm the exit code is `0`:

```bash
echo $?   # 0 == every batch processed; 2 == file-not-found usage error
```

## Performance Note

Batch size trades peak memory against re-parse cost. On an indexed FlatGeobuf, larger batches only raise memory, so pick the largest batch that fits your RSS budget. On raw GeoJSON the calculus flips: because every seek re-parses the prefix, fewer, larger batches parse the file fewer times overall, so raise `--batch` as high as memory allows to minimise the O(n squared) penalty — or better, convert once and stop fighting the format.

## FAQ

<details class="faq-item">
<summary>Does skip_features make GeoJSON reads slower as the offset grows?</summary>

Yes. GeoJSON has no spatial or feature index, so pyogrio must re-parse the file from the top to reach a given `skip_features` offset. Reading the whole file in batches therefore costs O(n squared) parsing time. Convert to FlatGeobuf or GeoPackage for large repeated reads, where offset seeks are constant time.
</details>

<details class="faq-item">
<summary>How do I keep memory flat while chunking a huge GeoJSON?</summary>

Read a fixed `max_features` per iteration, process each batch fully, and let the `GeoDataFrame` go out of scope before the next read so its memory is reclaimed. Peak resident memory then tracks one batch plus the parser buffer, not the whole file. Watch RSS with a memory sampler to confirm it stays flat.
</details>

<details class="faq-item">
<summary>Why reproject inside the batch loop instead of once at the end?</summary>

Because you never hold the full dataset in memory, there is no end state to reproject. Reprojecting each batch to `EPSG:4326` as it is read keeps every chunk in a consistent CRS for the downstream consumer while the batch is still small and cheap to transform.
</details>

<details class="faq-item">
<summary>What is a good batch size for chunked GeoJSON reading?</summary>

Start at `50000` features and tune from measured RSS. Larger batches amortise the O(n squared) re-parse cost of GeoJSON but raise peak memory; smaller batches keep memory low but re-parse the file prefix more times. For truly large files, convert to FlatGeobuf so batch size only affects memory, not parse cost.
</details>

---

## Related

- [Chunked Vector Data Reading for Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — parent guide covering windowed reads, driver choice, and streaming strategies for large vector data
- [pyogrio vs Fiona for Large Vector Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/pyogrio-vs-fiona-for-large-vector-datasets/) — how the two readers differ on throughput and memory for multi-gigabyte vector files
