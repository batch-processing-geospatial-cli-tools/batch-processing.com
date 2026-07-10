---
title: "pyogrio vs Fiona for Large Vector Datasets"
description: "Benchmark pyogrio against Fiona for reading large Shapefiles and GeoPackages, and choose based on Arrow throughput, memory, and per-feature access needs."
slug: "pyogrio-vs-fiona-for-large-vector-datasets"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Chunked Vector Data Reading for Spatial Pipelines"
    url: "/spatial-batch-processing-async-workflows/chunked-vector-data-reading/"
  - label: "pyogrio vs Fiona for Large Vector Datasets"
    url: "/spatial-batch-processing-async-workflows/chunked-vector-data-reading/pyogrio-vs-fiona-for-large-vector-datasets/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "pyogrio vs Fiona for Large Vector Datasets",
      "description": "Benchmark pyogrio against Fiona for reading large Shapefiles and GeoPackages, and choose based on Arrow throughput, memory, and per-feature access needs.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Chunked Vector Data Reading for Spatial Pipelines", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/"},
        {"@type": "ListItem", "position": 3, "name": "pyogrio vs Fiona for Large Vector Datasets", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/pyogrio-vs-fiona-for-large-vector-datasets/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Choose between pyogrio and Fiona for large vector datasets",
      "step": [
        {"@type": "HowToStep", "name": "Read the layer in bulk with pyogrio", "text": "Call pyogrio.read_dataframe() to load the whole layer into a GeoDataFrame in one Arrow-backed pass."},
        {"@type": "HowToStep", "name": "Stream the same layer with Fiona", "text": "Open the source with fiona.open() and iterate feature by feature to keep peak memory constant."},
        {"@type": "HowToStep", "name": "Reproject both outputs to EPSG:4326", "text": "Apply a pyproj Transformer or GeoDataFrame.to_crs so both readers produce identical coordinates."},
        {"@type": "HowToStep", "name": "Time both readers on the same file", "text": "Wrap each read in time.perf_counter and record elapsed seconds and feature counts."},
        {"@type": "HowToStep", "name": "Pick the reader from the decision matrix", "text": "Choose pyogrio for bulk analytics throughput and Fiona for bounded-memory per-feature streaming."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is pyogrio always faster than Fiona?",
          "acceptedAnswer": {"@type": "Answer", "text": "For bulk reads of a full layer into a GeoDataFrame, pyogrio is typically 5 to 20 times faster because it moves columns through GDAL's Arrow interface instead of building one Python dict per feature. For genuine record-by-record streaming where you never materialise the whole layer, the throughput gap narrows and Fiona's constant memory becomes the deciding factor."}
        },
        {
          "@type": "Question",
          "name": "Does pyogrio load the entire file into memory?",
          "acceptedAnswer": {"@type": "Answer", "text": "By default pyogrio.read_dataframe reads the whole layer into a single in-memory GeoDataFrame, so peak memory scales with layer size. To bound it, pass skip_features and max_features to read fixed-size windows, or use pyogrio.open_arrow with a batch_size to pull record batches without materialising everything at once."}
        },
        {
          "@type": "Question",
          "name": "When should I still choose Fiona?",
          "acceptedAnswer": {"@type": "Answer", "text": "Choose Fiona when you need true streaming over a layer larger than RAM, when you process one feature at a time and discard it, or when you depend on its stable per-feature GeoJSON-like mapping for schema introspection. Fiona is slower per feature but holds memory constant regardless of layer size."}
        },
        {
          "@type": "Question",
          "name": "Do pyogrio and Fiona return the same feature count and geometry?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes, both wrap the same GDAL/OGR drivers, so a correctly written read returns identical feature counts and identical geometries for the same source layer. Verify by comparing len(gdf) against the Fiona iteration count and by reprojecting both to EPSG:4326 before comparison."}
        }
      ]
    }
  ]
}
</script>

# pyogrio vs Fiona for Large Vector Datasets

For reading large Shapefiles and GeoPackages, choose **pyogrio** when you want the whole layer as a `GeoDataFrame` fast — it moves data through GDAL's Arrow interface and is commonly 5–20x quicker than Fiona. Choose **Fiona** when you need true record-by-record streaming at constant memory. This page is part of the [Chunked Vector Data Reading for Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) guide inside the broader [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install pyogrio fiona geopandas pyproj shapely`
- A GDAL 3.6+ build; pyogrio's fastest path needs GDAL compiled with the Arrow (columnar) read API

Both libraries wrap the same GDAL/OGR drivers, so they read identical formats — the difference is entirely in how each hands features back to Python. For memory strategy across the whole pipeline, read [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/); for a windowed streaming pattern in depth, see [Reading Large GeoJSON in Chunks with pyogrio](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/reading-large-geojson-in-chunks-with-pyogrio/).

## How the Two Readers Differ

pyogrio reads a layer **columnarly**: GDAL fills Arrow record batches (one contiguous buffer per attribute column plus a WKB geometry column), and pyogrio hands those directly to geopandas with almost no per-feature Python overhead. Fiona reads **row-wise**: for every feature it constructs a Python dictionary shaped like GeoJSON (`{"geometry": ..., "properties": ...}`). That dict is convenient and stable, but allocating millions of them dominates runtime and creates garbage-collector pressure.

The consequence is a throughput-versus-memory trade. pyogrio wins throughput but, by default, holds the entire layer resident. Fiona holds one feature at a time, so its peak memory is flat no matter how large the source grows.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision matrix comparing pyogrio bulk columnar reads against Fiona record-by-record streaming across throughput, memory, and access needs" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>pyogrio vs Fiona decision matrix</title>
  <desc>A decision flow on the left routes a reading need to pyogrio or Fiona, and a comparison matrix on the right contrasts the two on throughput, peak memory, streaming, and dependency footprint.</desc>
  <!-- Decision column -->
  <text x="150" y="30" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">Which reader?</text>
  <rect x="40" y="46" width="220" height="40" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="150" y="70" text-anchor="middle" font-size="11" fill="currentColor">Need every feature at once?</text>
  <!-- Yes branch -->
  <line x1="90" y1="86" x2="90" y2="128" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#pv)"/>
  <text x="72" y="112" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">yes</text>
  <rect x="30" y="130" width="120" height="46" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="90" y="150" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">pyogrio</text>
  <text x="90" y="165" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">bulk GeoDataFrame</text>
  <!-- No branch -->
  <line x1="210" y1="86" x2="210" y2="128" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#pv)"/>
  <text x="228" y="112" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">no</text>
  <rect x="150" y="130" width="130" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="215" y="150" text-anchor="middle" font-size="11" fill="currentColor">Layer larger than RAM?</text>
  <text x="215" y="165" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">stream one at a time</text>
  <line x1="180" y1="176" x2="120" y2="216" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#pv)"/>
  <text x="128" y="200" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">yes</text>
  <rect x="40" y="218" width="130" height="46" rx="6" fill="#15803d" fill-opacity="0.1" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="105" y="238" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Fiona</text>
  <text x="105" y="253" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">constant memory</text>
  <line x1="235" y1="176" x2="235" y2="216" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#pv)"/>
  <text x="253" y="200" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">no</text>
  <rect x="180" y="218" width="120" height="46" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="240" y="238" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">pyogrio</text>
  <text x="240" y="253" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">skip/max window</text>
  <!-- Matrix column -->
  <text x="530" y="30" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">Comparison matrix</text>
  <line x1="360" y1="44" x2="700" y2="44" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"/>
  <text x="372" y="72" font-size="10.5" fill="currentColor" opacity="0.7">Throughput</text>
  <text x="560" y="72" font-size="10.5" fill="#6366f1">pyogrio</text>
  <text x="648" y="72" font-size="10.5" fill="currentColor" opacity="0.6">Fiona</text>
  <line x1="360" y1="86" x2="700" y2="86" stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>
  <text x="372" y="110" font-size="10.5" fill="currentColor" opacity="0.7">Peak memory</text>
  <text x="560" y="110" font-size="10.5" fill="currentColor" opacity="0.6">high</text>
  <text x="648" y="110" font-size="10.5" fill="#15803d">flat</text>
  <line x1="360" y1="124" x2="700" y2="124" stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>
  <text x="372" y="148" font-size="10.5" fill="currentColor" opacity="0.7">True streaming</text>
  <text x="560" y="148" font-size="10.5" fill="currentColor" opacity="0.6">windowed</text>
  <text x="648" y="148" font-size="10.5" fill="#15803d">native</text>
  <line x1="360" y1="162" x2="700" y2="162" stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>
  <text x="372" y="186" font-size="10.5" fill="currentColor" opacity="0.7">Output shape</text>
  <text x="520" y="186" font-size="10.5" fill="currentColor" opacity="0.6">GeoDataFrame</text>
  <text x="648" y="186" font-size="10.5" fill="currentColor" opacity="0.6">dict</text>
  <line x1="360" y1="200" x2="700" y2="200" stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>
  <text x="372" y="224" font-size="10.5" fill="currentColor" opacity="0.7">Dependency</text>
  <text x="520" y="224" font-size="10.5" fill="currentColor" opacity="0.6">Arrow + GDAL</text>
  <text x="648" y="224" font-size="10.5" fill="currentColor" opacity="0.6">GDAL</text>
  <line x1="360" y1="238" x2="700" y2="238" stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>
  <text x="372" y="290" font-size="10" fill="currentColor" opacity="0.6">Rule of thumb: pyogrio for analytics-scale</text>
  <text x="372" y="306" font-size="10" fill="currentColor" opacity="0.6">bulk loads; Fiona for unbounded, one-at-</text>
  <text x="372" y="322" font-size="10" fill="currentColor" opacity="0.6">a-time streaming pipelines.</text>
  <defs>
    <marker id="pv" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below reads the **same** GeoPackage layer twice — once in bulk with pyogrio, once record-by-record with Fiona — reprojects both results to `EPSG:4326`, and prints a timing and feature-count comparison so the trade-off is measurable on your own data:

```python
#!/usr/bin/env python3
"""
Benchmark pyogrio (bulk Arrow read) against Fiona (record streaming) on one layer.
Usage: python compare_readers.py ./data/parcels.gpkg --layer parcels
"""
import sys
import time
import argparse
from pathlib import Path

import pyogrio
import fiona
from fiona.transform import transform_geom
from pyproj import CRS

TARGET_CRS = CRS.from_epsg(4326)   # canonical WGS84 lon/lat


def read_with_pyogrio(path: Path, layer: str) -> tuple[int, float]:
    """Bulk read the whole layer into a GeoDataFrame, then reproject.

    read_dataframe pulls Arrow record batches from GDAL and builds one
    columnar GeoDataFrame. This is the fast path but holds the full layer
    in memory, so peak RSS scales with the source size.
    """
    start = time.perf_counter()
    gdf = pyogrio.read_dataframe(path, layer=layer)
    if gdf.crs is not None and gdf.crs != TARGET_CRS:
        gdf = gdf.to_crs(TARGET_CRS)          # vectorised reprojection
    count = len(gdf)
    elapsed = time.perf_counter() - start
    return count, elapsed


def read_with_fiona(path: Path, layer: str) -> tuple[int, float]:
    """Stream the layer one feature at a time, reprojecting each geometry.

    fiona.open yields a GeoJSON-like dict per feature. Nothing is
    materialised for the whole layer, so peak memory stays flat regardless
    of feature count — at the cost of one Python dict allocation per record.
    """
    start = time.perf_counter()
    count = 0
    with fiona.open(path, layer=layer) as src:
        src_crs = CRS.from_user_input(src.crs) if src.crs else None  # e.g. EPSG:25832
        needs_reproj = src_crs is not None and src_crs != TARGET_CRS
        for feature in src:                   # constant-memory iterator
            geom = feature["geometry"]
            if needs_reproj:
                geom = transform_geom(
                    src_crs.to_string(), "EPSG:4326", geom, precision=7,
                )
            _ = geom                          # hand off to downstream consumer
            count += 1
    elapsed = time.perf_counter() - start
    return count, elapsed


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare pyogrio bulk reads against Fiona streaming"
    )
    parser.add_argument("source", type=Path, help="Path to a Shapefile or GeoPackage")
    parser.add_argument("--layer", default=None, help="Layer name (GeoPackage only)")
    args = parser.parse_args()

    if not args.source.exists():
        print(f"source not found: {args.source}", file=sys.stderr)
        sys.exit(2)                            # usage/argument error

    layer = args.layer or pyogrio.list_layers(args.source)[0][0]

    p_count, p_time = read_with_pyogrio(args.source, layer)
    f_count, f_time = read_with_fiona(args.source, layer)

    print(f"pyogrio: {p_count:>8,} features in {p_time:6.3f}s")
    print(f"fiona:   {f_count:>8,} features in {f_time:6.3f}s")
    print(f"speedup: {f_time / p_time:5.1f}x  (pyogrio vs fiona)")

    if p_count != f_count:
        print("MISMATCH: feature counts differ", file=sys.stderr)
        sys.exit(1)                            # runtime error
    print("counts match — readers agree")
    sys.exit(0)


if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`pyogrio.read_dataframe(path, layer=layer)`** — the single call that does all the work. GDAL fills Arrow batches and pyogrio assembles them into a `GeoDataFrame` in one pass, skipping the per-feature Python dict that dominates Fiona's runtime.

2. **`gdf.to_crs(TARGET_CRS)`** — reprojection happens on the whole geometry column at once through pyproj, so N features cost one vectorised transform rather than N individual calls. Guarding on `gdf.crs != TARGET_CRS` avoids a needless no-op transform.

3. **`with fiona.open(path, layer=layer) as src`** — Fiona's iterator yields exactly one feature dict at a time. The layer is never fully resident, which is what keeps peak memory flat; this is the property to reach for when the source is larger than RAM.

4. **`transform_geom(src_crs, "EPSG:4326", geom, precision=7)`** — reprojects each geometry individually since there is no column to batch. `precision=7` caps coordinate decimals at roughly centimetre resolution for `EPSG:4326`, keeping downstream output stable.

5. **`pyogrio.list_layers(...)[0][0]`** — Shapefiles have a single implicit layer; GeoPackages can carry many. Defaulting to the first layer name lets the same script handle both formats without a required `--layer` flag.

6. **Exit codes** — the script returns `2` for a missing source (usage error), `1` when the two readers disagree on feature count (runtime error), and `0` on success, matching the domain convention used across [the batch pipeline error-handling patterns](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/).

## Named Gotcha: pyogrio Loads the Whole Layer by Default

`pyogrio.read_dataframe()` reads the **entire** layer into one `GeoDataFrame`. On a 5 GB GeoPackage this can push peak resident memory past available RAM and trigger an OOM kill long before your reprojection runs — the exact opposite of the constant-memory behaviour people assume they get from a "chunked" reader.

The fix is to read bounded windows instead of the whole layer. Pass `skip_features` and `max_features` to slide a fixed-size window across the source, or use `pyogrio.open_arrow(..., batch_size=...)` to pull record batches without materialising everything:

```python
import pyogrio

CHUNK = 100_000
info = pyogrio.read_info("./data/parcels.gpkg", layer="parcels")
total = info["features"]

for offset in range(0, total, CHUNK):
    gdf = pyogrio.read_dataframe(
        "./data/parcels.gpkg",
        layer="parcels",
        skip_features=offset,     # window start
        max_features=CHUNK,       # window size — bounds peak memory
    ).to_crs("EPSG:4326")
    # process this window, then let it fall out of scope before the next
```

This gives pyogrio's throughput with Fiona-like bounded memory. If you cannot know the record count cheaply or need strict one-at-a-time semantics, Fiona remains the simpler correct choice — it is slower per feature but its memory ceiling never moves.

## Verification

Confirm the two readers agree and see the timing gap on your own file:

```bash
python compare_readers.py ./data/parcels.gpkg --layer parcels
# pyogrio:  1,204,318 features in  1.812s
# fiona:    1,204,318 features in 24.905s
# speedup:  13.7x  (pyogrio vs fiona)
# counts match — readers agree
echo "exit: $?"   # 0 means both readers returned the same feature count
```

A matching feature count and a printed speedup confirm both paths read the same layer correctly. If the counts differ, the most common cause is passing the wrong `--layer` to one reader — verify layer names with `pyogrio.list_layers(path)` and `fiona.listlayers(path)`.

## Performance Notes

pyogrio's advantage scales with attribute width: the more columns a layer carries, the more the columnar Arrow transfer beats building a dict per feature. On a narrow, geometry-only layer the gap shrinks. Fiona's cost is dominated by Python object allocation, so pushing filtering into the OGR layer with `fiona.open(..., where="...")` or a bounding-box `bbox=` reduces the number of dicts it ever builds. For pipelines that read many files, combine either reader with the strategies in [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) to keep aggregate RSS bounded.

## FAQ

<details class="faq-item">
<summary>Is pyogrio always faster than Fiona?</summary>

For bulk reads of a full layer into a `GeoDataFrame`, pyogrio is typically 5 to 20 times faster because it moves columns through GDAL's Arrow interface instead of building one Python dict per feature. For genuine record-by-record streaming where you never materialise the whole layer, the throughput gap narrows and Fiona's constant memory becomes the deciding factor.
</details>

<details class="faq-item">
<summary>Does pyogrio load the entire file into memory?</summary>

By default `pyogrio.read_dataframe` reads the whole layer into a single in-memory `GeoDataFrame`, so peak memory scales with layer size. To bound it, pass `skip_features` and `max_features` to read fixed-size windows, or use `pyogrio.open_arrow` with a `batch_size` to pull record batches without materialising everything at once.
</details>

<details class="faq-item">
<summary>When should I still choose Fiona?</summary>

Choose Fiona when you need true streaming over a layer larger than RAM, when you process one feature at a time and discard it, or when you depend on its stable per-feature GeoJSON-like mapping for schema introspection. Fiona is slower per feature but holds memory constant regardless of layer size.
</details>

<details class="faq-item">
<summary>Do pyogrio and Fiona return the same feature count and geometry?</summary>

Yes, both wrap the same GDAL/OGR drivers, so a correctly written read returns identical feature counts and identical geometries for the same source layer. Verify by comparing `len(gdf)` against the Fiona iteration count and by reprojecting both to `EPSG:4326` before comparison.
</details>

---

## Related

- [Chunked Vector Data Reading for Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — parent guide covering windowed reads, layer filtering, and bounded-memory vector ingestion
- [Reading Large GeoJSON in Chunks with pyogrio](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/reading-large-geojson-in-chunks-with-pyogrio/) — the windowed pyogrio pattern applied to oversized GeoJSON sources
