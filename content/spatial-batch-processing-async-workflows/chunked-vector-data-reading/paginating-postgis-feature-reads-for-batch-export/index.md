---
title: "Paginating PostGIS Feature Reads for Batch Export"
description: "Export millions of PostGIS features in keyset-paginated chunks with pyogrio and a server-side cursor so a batch job never loads the whole table into memory."
slug: "paginating-postgis-feature-reads-for-batch-export"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Chunked Vector Data Reading for Spatial Pipelines"
    url: "/spatial-batch-processing-async-workflows/chunked-vector-data-reading/"
  - label: "Paginating PostGIS Feature Reads for Batch Export"
    url: "/spatial-batch-processing-async-workflows/chunked-vector-data-reading/paginating-postgis-feature-reads-for-batch-export/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Paginating PostGIS Feature Reads for Batch Export",
      "description": "Export millions of PostGIS features in keyset-paginated chunks with pyogrio and a server-side cursor so a batch job never loads the whole table into memory.",
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
        {"@type": "ListItem", "position": 3, "name": "Paginating PostGIS Feature Reads for Batch Export", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/paginating-postgis-feature-reads-for-batch-export/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Paginate PostGIS Feature Reads for Batch Export",
      "step": [
        {"@type": "HowToStep", "name": "Index the pagination key", "text": "Ensure a b-tree index on the gid primary key so each keyset seek is an index range scan rather than a full sort."},
        {"@type": "HowToStep", "name": "Read one keyset page", "text": "Issue an SQL query with WHERE gid greater than the last seen value ORDER BY gid LIMIT batch through pyogrio.read_dataframe."},
        {"@type": "HowToStep", "name": "Reproject the batch", "text": "Call GeoDataFrame.to_crs to convert each page to EPSG:4326 before writing."},
        {"@type": "HowToStep", "name": "Append to the output", "text": "Write each reprojected page to a GeoPackage layer with append mode so memory never holds the full table."},
        {"@type": "HowToStep", "name": "Advance the cursor", "text": "Set last_gid to the maximum gid of the page just written and loop until a page returns zero rows."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why is OFFSET pagination slow on large PostGIS tables?",
          "acceptedAnswer": {"@type": "Answer", "text": "OFFSET forces PostgreSQL to read and discard every row before the offset on each page, so scanning the whole table costs O(n squared) row visits. Keyset pagination uses WHERE gid greater than the last value against an index, making each page an O(log n) seek plus a bounded range scan that stays constant per page."}
        },
        {
          "@type": "Question",
          "name": "Do I need an index for keyset pagination to be fast?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes. The b-tree index on the ORDER BY column is what makes WHERE gid greater than last an index range scan instead of a sort of the whole table. A primary key on gid already provides this index; a non-unique key needs a composite tiebreaker to stay deterministic."}
        },
        {
          "@type": "Question",
          "name": "How do I keep memory flat while exporting millions of features?",
          "acceptedAnswer": {"@type": "Answer", "text": "Read a fixed batch size per iteration, reproject and write that page, then discard the GeoDataFrame before fetching the next one. Peak memory stays proportional to the batch size, not the table size, because only one page of geometries is ever resident."}
        },
        {
          "@type": "Question",
          "name": "When should I use a psycopg server-side cursor instead of pyogrio pages?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use a named server-side cursor with itersize when a single ordered scan is acceptable and you want the server to stream rows without a WHERE clause per page. Use pyogrio keyset pages when the job may pause, resume, or run across separate connections, since each page is an independent stateless query."}
        }
      ]
    }
  ]
}
</script>

# Paginating PostGIS Feature Reads for Batch Export

To read millions of PostGIS features without exhausting memory, page through the table by keyset: fetch a fixed batch with `WHERE gid > :last_gid ORDER BY gid LIMIT :batch`, reproject that page to `EPSG:4326`, append it to a GeoPackage, then advance `last_gid` and repeat. Peak memory stays proportional to one batch, never the whole table. This page is part of the [Chunked Vector Data Reading for Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) guide inside the broader [Spatial Batch Processing & Async Workflows](https://www.batch-processing.com/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install pyogrio geopandas psycopg[binary]`
- GDAL 3.4+ with the PostgreSQL and GPKG drivers (pyogrio ships GDAL wheels; a system `libgdal` also works)
- A PostGIS table with a primary key column (`gid` below) and a `geom` column with a declared SRID

For why streaming reads matter across the whole pipeline, the [Memory Management for Large GIS Datasets](https://www.batch-processing.com/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) section covers the failure modes that a single `read_dataframe` over a full table triggers.

## Why OFFSET Pagination Degrades

The naive approach pages with `LIMIT :batch OFFSET :n`. It looks correct and returns the right rows, but PostgreSQL has no way to jump to row `n`. It must walk the ordered result from the start and throw away the first `n` rows on every single page. Page 1 discards 0 rows, page 2 discards `batch`, page 500 discards `499 * batch`. Summed across the table, that is a quadratic O(n^2) number of row visits, so the export gets slower the deeper it goes and the last pages crawl.

Keyset (seek) pagination replaces the offset with a `WHERE gid > :last_gid` predicate. With a b-tree index on `gid`, PostgreSQL seeks directly to the first row past the last one you saw and reads exactly `batch` rows forward. Every page costs the same: one O(log n) index descent plus a bounded range scan. The export runs at constant speed from the first page to the last.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OFFSET pagination re-scans all prior rows on every page giving quadratic cost, while keyset pagination seeks the index directly for constant cost per page" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>OFFSET versus keyset pagination cost per page</title>
  <desc>Top row shows OFFSET pages each re-scanning all earlier rows, a growing shaded region, labelled O(n squared) total. Bottom row shows keyset pages each seeking the index to the last gid and reading a fixed window, labelled O(1) per page.</desc>
  <!-- OFFSET panel -->
  <text x="20" y="30" font-size="13" font-weight="600" fill="currentColor">OFFSET pagination — rescans grow each page</text>
  <!-- page 1 -->
  <rect x="20" y="46" width="60" height="34" rx="4" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="50" y="67" text-anchor="middle" font-size="10" fill="currentColor">page 1</text>
  <!-- page 2 -->
  <rect x="90" y="46" width="60" height="34" rx="4" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="120" y="67" text-anchor="middle" font-size="10" fill="currentColor">page 2</text>
  <!-- page 3 -->
  <rect x="160" y="46" width="130" height="34" rx="4" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="225" y="67" text-anchor="middle" font-size="10" fill="currentColor">page 3</text>
  <!-- page N -->
  <rect x="300" y="46" width="380" height="34" rx="4" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="490" y="67" text-anchor="middle" font-size="10" fill="currentColor">page N — discards every prior row first</text>
  <text x="20" y="104" font-size="11" fill="#c0392b" opacity="0.9">Total row visits grow as O(n squared)</text>
  <!-- divider -->
  <line x1="20" y1="128" x2="700" y2="128" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
  <!-- KEYSET panel -->
  <text x="20" y="158" font-size="13" font-weight="600" fill="currentColor">Keyset pagination — index seek to last gid, fixed window</text>
  <!-- index line -->
  <line x1="20" y1="212" x2="700" y2="212" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.4"/>
  <text x="20" y="230" font-size="10" fill="currentColor" opacity="0.7">b-tree index on gid</text>
  <!-- fixed windows -->
  <rect x="60" y="184" width="70" height="34" rx="4" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="95" y="205" text-anchor="middle" font-size="10" fill="currentColor">batch</text>
  <rect x="250" y="184" width="70" height="34" rx="4" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="285" y="205" text-anchor="middle" font-size="10" fill="currentColor">batch</text>
  <rect x="500" y="184" width="70" height="34" rx="4" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="535" y="205" text-anchor="middle" font-size="10" fill="currentColor">batch</text>
  <!-- seek arrows -->
  <line x1="95" y1="230" x2="95" y2="248" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2" marker-end="url(#kseek)"/>
  <text x="95" y="264" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">gid &gt; 0</text>
  <line x1="285" y1="230" x2="285" y2="248" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2" marker-end="url(#kseek)"/>
  <text x="285" y="264" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">gid &gt; last</text>
  <line x1="535" y1="230" x2="535" y2="248" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2" marker-end="url(#kseek)"/>
  <text x="535" y="264" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">gid &gt; last</text>
  <text x="20" y="296" font-size="11" fill="#15803d" opacity="0.95">Cost per page stays O(1) — constant regardless of depth</text>
  <defs>
    <marker id="kseek" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below exports an entire PostGIS layer to a GeoPackage in keyset-paginated chunks, reprojecting each page to `EPSG:4326` before it writes. Only one batch of geometries is ever in memory. Set the connection through `PGHOST`, `PGDATABASE`, and friends, or edit the DSN directly:

```python
#!/usr/bin/env python3
"""
Keyset-paginated export of a PostGIS layer to a GeoPackage.
Usage: python export_postgis.py parcels gid ./parcels_wgs84.gpkg --batch 50000
"""
import os
import sys
import argparse
import logging
from pathlib import Path

import pyogrio

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

# GDAL PostgreSQL connection string. Reads standard libpq env vars if set.
PG_DSN = os.environ.get(
    "PG_DSN",
    "PG:host=localhost dbname=gis user=gis password=gis",
)


def export_layer(table: str, key: str, dst: Path, batch: int, target_epsg: int) -> int:
    """Page through `table` by keyset on `key`, reproject, append to GeoPackage.

    Returns the total number of features written.
    """
    last_key = -1               # gid is a positive serial, so -1 precedes all rows
    written = 0
    layer_name = dst.stem

    while True:
        # Keyset page: seek past the last key, read a fixed window forward.
        # ORDER BY on the indexed key makes this an index range scan, not a sort.
        sql = (
            f"SELECT * FROM {table} "
            f"WHERE {key} > {last_key} "
            f"ORDER BY {key} "
            f"LIMIT {batch}"
        )
        page = pyogrio.read_dataframe(PG_DSN, sql=sql)

        if len(page) == 0:
            break               # empty page means the table is exhausted

        # Reproject the page to EPSG:4326 before writing. to_crs is vectorised
        # over the whole GeoSeries, so it costs one PROJ pipeline per batch.
        page = page.to_crs(epsg=target_epsg)

        # append=True after the first page keeps a single growing GPKG layer.
        pyogrio.write_dataframe(
            page,
            dst,
            layer=layer_name,
            driver="GPKG",
            append=written > 0,
        )

        last_key = int(page[key].max())   # advance the cursor to this page's max
        written += len(page)
        logging.info("wrote %d features (through %s=%d)", written, key, last_key)

    return written


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Keyset-paginated PostGIS to GeoPackage export"
    )
    parser.add_argument("table", help="Source table, e.g. public.parcels")
    parser.add_argument("key", help="Indexed pagination key column, e.g. gid")
    parser.add_argument("dst", type=Path, help="Output GeoPackage path")
    parser.add_argument("--batch", type=int, default=50000, help="Rows per page")
    parser.add_argument("--epsg", type=int, default=4326, help="Target EPSG code")
    args = parser.parse_args()

    if args.dst.exists():
        args.dst.unlink()       # start clean so append mode builds one layer

    total = export_layer(args.table, args.key, args.dst, args.batch, args.epsg)
    logging.info("done: %d features written to %s", total, args.dst)
    sys.exit(0 if total > 0 else 1)


if __name__ == "__main__":
    main()
```

For jobs where a single ordered scan is acceptable and you would rather let the server stream rows than issue one query per page, a psycopg server-side named cursor is the alternative. The named cursor keeps the result set on the server and pulls `itersize` rows per network round-trip:

```python
import psycopg
import geopandas as gpd

def export_with_named_cursor(dsn: str, table: str, dst, batch: int = 50000) -> int:
    written = 0
    with psycopg.connect(dsn) as conn:
        # A *named* cursor is server-side: rows are not all sent at once.
        with conn.cursor(name="feature_stream") as cur:
            cur.itersize = batch         # rows fetched per round-trip
            cur.execute(
                f"SELECT gid, ST_AsText(ST_Transform(geom, 4326)) AS wkt "
                f"FROM {table} ORDER BY gid"
            )
            rows = cur.fetchmany(batch)
            while rows:
                gdf = gpd.GeoDataFrame(
                    {"gid": [r[0] for r in rows]},
                    geometry=gpd.GeoSeries.from_wkt([r[1] for r in rows]),
                    crs="EPSG:4326",
                )
                gdf.to_file(dst, layer="features", driver="GPKG",
                            mode="a" if written else "w")
                written += len(rows)
                rows = cur.fetchmany(batch)
    return written
```

## Step Annotations

1. **`last_key = -1` seed** — A serial `gid` starts at 1, so `WHERE gid > -1` matches the first row without special-casing the initial page. If your key can be negative or zero, seed with a value strictly below the minimum instead.

2. **`WHERE gid > :last_gid ORDER BY gid LIMIT :batch`** — This is the keyset predicate. The `ORDER BY` must be on the same column as the `WHERE` and that column must be indexed; otherwise PostgreSQL sorts the whole table on every page and you lose the entire benefit.

3. **`pyogrio.read_dataframe(PG_DSN, sql=sql)`** — pyogrio hands the SQL straight to GDAL's PostgreSQL driver, so the filtering and ordering happen in the database. Only the `batch` rows of the page cross the wire into a `GeoDataFrame`.

4. **`page.to_crs(epsg=target_epsg)`** — Reprojection runs per page on a vectorised `GeoSeries`, so the PROJ transformation pipeline is built once per batch, not once per feature. Reprojecting after the read keeps the SQL simple and lets the database index do its job unencumbered.

5. **`append=written > 0`** — The first page creates the GeoPackage layer; every subsequent page appends. Passing `append=True` on the first write would fail because the layer does not exist yet.

6. **`last_key = int(page[key].max())`** — Advancing to the page maximum is what makes the next `WHERE gid >` clause skip everything already written. Casting to a plain `int` avoids passing a NumPy scalar into the interpolated SQL string.

7. **`fetchmany(batch)` with a named cursor** — In the psycopg variant, naming the cursor makes it server-side. Without a name, psycopg buffers the entire result set client-side and you are back to loading the whole table into memory.

## Named Gotcha: OFFSET Without a Deterministic ORDER BY

The failure that quietly corrupts exports is paging with `LIMIT/OFFSET` and either no `ORDER BY` or a non-unique one. PostgreSQL does not guarantee a stable row order between two queries unless you fully order the result. Under concurrent writes, autovacuum, or even plan changes, the same physical row can appear on two pages or be skipped entirely, so your export ends up with duplicates and holes that no row count will reveal until a downstream join breaks.

Keyset pagination on a unique, indexed key removes both problems at once: the order is deterministic because `gid` is unique, and there is no offset to re-scan. If your natural key is not unique (for example a timestamp), append the primary key as a tiebreaker — `ORDER BY captured_at, gid` with a matching `WHERE (captured_at, gid) > (:last_ts, :last_gid)` — so every page boundary is unambiguous.

A related trap applies to the server-side cursor variant: a named cursor lives inside a transaction, and PostgreSQL holds that snapshot open for the entire scan. On a table under heavy write load, keeping one cursor open for a multi-hour export can bloat the table with dead tuples that autovacuum cannot reclaim. For very long exports, prefer the stateless pyogrio keyset loop, which opens and closes a fresh short query per page.

## Verification

After the export finishes, confirm the GeoPackage feature count matches the source table and that the output is in `EPSG:4326`:

```bash
# Count features in the source PostGIS table
psql -d gis -tAc "SELECT count(*) FROM parcels"

# Count features in the exported GeoPackage
ogrinfo -so parcels_wgs84.gpkg parcels_wgs84 | grep "Feature Count"

# Confirm the output CRS is EPSG:4326
ogrinfo -so parcels_wgs84.gpkg parcels_wgs84 | grep -A1 "Layer SRS"
```

The two counts must be identical. A GeoPackage count lower than the `SELECT count(*)` means a page boundary dropped rows — almost always an OFFSET or non-deterministic order problem. A higher count means duplicated rows across pages. Both are caught immediately by this comparison, which is why the row-count check belongs in the job's exit criteria rather than a manual spot check.

## FAQ

<details class="faq-item">
<summary>Why is OFFSET pagination slow on large PostGIS tables?</summary>

`OFFSET` forces PostgreSQL to read and discard every row before the offset on each page, so scanning the whole table costs O(n^2) row visits. Keyset pagination uses `WHERE gid > :last_gid` against an index, making each page an O(log n) seek plus a bounded range scan that stays constant per page.
</details>

<details class="faq-item">
<summary>Do I need an index for keyset pagination to be fast?</summary>

Yes. The b-tree index on the `ORDER BY` column is what makes `WHERE gid > :last_gid` an index range scan instead of a sort of the whole table. A primary key on `gid` already provides this index; a non-unique key needs a composite tiebreaker to stay deterministic.
</details>

<details class="faq-item">
<summary>How do I keep memory flat while exporting millions of features?</summary>

Read a fixed batch size per iteration, reproject and write that page, then discard the `GeoDataFrame` before fetching the next one. Peak memory stays proportional to the batch size, not the table size, because only one page of geometries is ever resident.
</details>

<details class="faq-item">
<summary>When should I use a psycopg server-side cursor instead of pyogrio pages?</summary>

Use a named server-side cursor with `itersize` when a single ordered scan is acceptable and you want the server to stream rows without a `WHERE` clause per page. Use pyogrio keyset pages when the job may pause, resume, or run across separate connections, since each page is an independent stateless query.
</details>

---

## Related

- [Chunked Vector Data Reading for Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) — parent guide covering batched vector I/O patterns for memory-bounded spatial pipelines
- [Reading Large GeoJSON in Chunks with pyogrio](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/reading-large-geojson-in-chunks-with-pyogrio/) — the file-based counterpart to database pagination, streaming features from a single large GeoJSON
