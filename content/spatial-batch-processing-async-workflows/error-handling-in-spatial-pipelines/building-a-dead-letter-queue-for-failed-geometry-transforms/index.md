---
title: "Building a Dead-Letter Queue for Failed Geometry Transforms"
description: "Quarantine invalid geometries and CRS mismatches into a JSON dead-letter file so a batch pipeline finishes clean features and you can replay failures later."
slug: "building-a-dead-letter-queue-for-failed-geometry-transforms"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Error Handling in Spatial Pipelines"
    url: "/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/"
  - label: "Building a Dead-Letter Queue for Failed Geometry Transforms"
    url: "/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/building-a-dead-letter-queue-for-failed-geometry-transforms/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Building a Dead-Letter Queue for Failed Geometry Transforms",
      "description": "Quarantine invalid geometries and CRS mismatches into a JSON dead-letter file so a batch pipeline finishes clean features and you can replay failures later.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Error Handling in Spatial Pipelines", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/"},
        {"@type": "ListItem", "position": 3, "name": "Building a Dead-Letter Queue for Failed Geometry Transforms", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/building-a-dead-letter-queue-for-failed-geometry-transforms/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a Dead-Letter Queue for Failed Geometry Transforms",
      "step": [
        {"@type": "HowToStep", "name": "Iterate features individually", "text": "Loop over each row of the GeoDataFrame so one bad geometry cannot abort the whole batch."},
        {"@type": "HowToStep", "name": "Validate and repair geometry", "text": "Use explain_validity to detect self-intersections and make_valid to repair them before reprojection."},
        {"@type": "HowToStep", "name": "Reproject per feature", "text": "Call to_crs on the single-feature frame and catch CRS mismatch and topology errors."},
        {"@type": "HowToStep", "name": "Quarantine failures atomically", "text": "Write each failure with feature id, error_class, and original WKT to a JSON dead-letter file using an atomic temp-then-rename write."},
        {"@type": "HowToStep", "name": "Signal partial failure", "text": "Return exit code 12 when the dead-letter file is non-empty so schedulers can flag the run."},
        {"@type": "HowToStep", "name": "Replay quarantined features", "text": "Re-read the dead-letter file and re-run only the failed features once the root cause is fixed."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does a self-intersecting polygon load fine but fail on to_crs?",
          "acceptedAnswer": {"@type": "Answer", "text": "Reading a feature only parses coordinates; it never checks topology. Shapely raises on self-intersections only when an operation such as reprojection, buffering, or an overlay walks the ring. Call explain_validity to see the reason and make_valid to repair the geometry before the transform runs."}
        },
        {
          "@type": "Question",
          "name": "Should the dead-letter file be JSON or a shapefile?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use JSON. A failed geometry may be structurally invalid, which many vector drivers refuse to write, and you also want to store the error_class and a traceback alongside the WKT. Plain JSON with a WKT string per record survives invalid geometries and stays diff-friendly for replay."}
        },
        {
          "@type": "Question",
          "name": "Why write the dead-letter file atomically?",
          "acceptedAnswer": {"@type": "Answer", "text": "A batch that is killed mid-write leaves a truncated JSON file that breaks the replay step. Writing to a temporary file in the same directory and calling os.replace makes the swap atomic on POSIX filesystems, so readers always see either the old file or the complete new one."}
        },
        {
          "@type": "Question",
          "name": "What exit code should a partial batch failure return?",
          "acceptedAnswer": {"@type": "Answer", "text": "Return exit code 12 for partial batch failure: some features were written cleanly and some were quarantined. Reserve 0 for a fully clean run and 10 for a CRS mismatch that stops the whole job. This lets a scheduler distinguish a recoverable partial run from a hard failure."}
        }
      ]
    }
  ]
}
</script>

# Building a Dead-Letter Queue for Failed Geometry Transforms

To keep a batch running when some geometries fail to transform, process the GeoDataFrame one feature at a time, wrap each `to_crs` call in a try/except, and route any feature that raises into a JSON dead-letter file recording its id, `error_class`, and original geometry as WKT. Clean features flow straight to the output; the run finishes and returns exit code `12` to signal a partial failure you can replay later. This page is part of the [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) guide inside the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install geopandas shapely pyproj pyogrio`
- GDAL 3.4+ available to pyogrio (installed automatically by the geopandas wheels on most platforms)

The dead-letter pattern borrows the same idea message queues use: a message that cannot be processed is set aside rather than blocking the queue. For the full failure-capture picture, read the [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) overview, and pair this page with [Logging Spatial Transformations to Structured JSON](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) so every quarantined feature also lands in your run log.

## How a Feature Is Routed

Each feature takes exactly one path: it is repaired and reprojected into the clean output, or it is captured with its error class and original coordinates into the dead-letter file. The batch never stops on a single failure.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision flow routing each feature: validity check, reprojection, then either the clean output or the JSON dead-letter file, with the counts reconciled at the end" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Per-feature routing into clean output or dead-letter file</title>
  <desc>A flow starts at a source GeoDataFrame, splits per feature through a validity repair and a reprojection attempt, sends successes to a clean output and failures to a JSON dead-letter file, and reconciles clean count plus dead-letter count against the total.</desc>
  <!-- Source -->
  <rect x="20" y="130" width="120" height="56" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="80" y="154" text-anchor="middle" font-size="12" fill="currentColor">GeoDataFrame</text>
  <text x="80" y="171" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">N features</text>
  <!-- Arrow to loop -->
  <line x1="140" y1="158" x2="188" y2="158" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#dlq-arr)"/>
  <!-- Per-feature loop box -->
  <rect x="190" y="120" width="130" height="76" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="255" y="145" text-anchor="middle" font-size="11" fill="currentColor">per feature</text>
  <text x="255" y="162" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">explain_validity</text>
  <text x="255" y="178" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">make_valid + to_crs</text>
  <!-- Arrow to decision -->
  <line x1="320" y1="158" x2="368" y2="158" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#dlq-arr)"/>
  <!-- Decision diamond -->
  <polygon points="430,120 486,158 430,196 374,158" fill="#a78bfa" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="430" y="154" text-anchor="middle" font-size="10.5" fill="currentColor">raised?</text>
  <text x="430" y="169" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">try/except</text>
  <!-- No branch up to clean -->
  <line x1="430" y1="120" x2="430" y2="80" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.4" marker-end="url(#dlq-arr)"/>
  <text x="452" y="104" text-anchor="middle" font-size="9.5" fill="#15803d" opacity="0.9">no</text>
  <rect x="540" y="52" width="150" height="56" rx="6" fill="#27ae60" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="615" y="76" text-anchor="middle" font-size="11" fill="currentColor">clean output</text>
  <text x="615" y="93" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">clean_count</text>
  <line x1="486" y1="140" x2="540" y2="98" stroke="#15803d" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#dlq-arr)"/>
  <!-- Yes branch down to dead-letter -->
  <line x1="430" y1="196" x2="430" y2="236" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.4" marker-end="url(#dlq-arr)"/>
  <text x="452" y="220" text-anchor="middle" font-size="9.5" fill="#c0392b" opacity="0.9">yes</text>
  <rect x="540" y="208" width="150" height="70" rx="6" fill="#c0392b" fill-opacity="0.07" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="615" y="232" text-anchor="middle" font-size="11" fill="currentColor">dead-letter.json</text>
  <text x="615" y="249" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">id, error_class, wkt</text>
  <text x="615" y="264" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">dead_letter_count</text>
  <line x1="486" y1="176" x2="540" y2="238" stroke="#c0392b" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#dlq-arr)"/>
  <!-- Reconciliation -->
  <text x="360" y="300" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">clean_count + dead_letter_count == N   →   exit 12 if any quarantined</text>
  <defs>
    <marker id="dlq-arr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below reads a vector layer with pyogrio, reprojects each feature to a target CRS, repairs invalid geometry where it can, and quarantines whatever still fails. Copy it, adjust the paths and `--target-crs`, and run it directly. Every failure is captured with enough context to replay it:

```python
#!/usr/bin/env python3
"""
Reproject a vector layer feature-by-feature with a JSON dead-letter queue.

Usage:
    python dlq_transform.py input.gpkg clean.gpkg dead_letter.json \
        --target-crs EPSG:3857
    python dlq_transform.py --replay dead_letter.json replayed.gpkg \
        --target-crs EPSG:3857
"""
import os
import sys
import json
import argparse
import tempfile
from pathlib import Path

import geopandas as gpd
from shapely import wkt
from shapely.validation import explain_validity, make_valid
from shapely.errors import GEOSException
from pyproj.exceptions import CRSError

EXIT_OK = 0
EXIT_CRS_MISMATCH = 10
EXIT_PARTIAL_FAILURE = 12


def atomic_write_json(records: list[dict], path: Path) -> None:
    """Write the dead-letter records so readers never see a half-written file.

    A batch killed mid-write must not corrupt the queue. Write to a temp file
    in the SAME directory (so os.replace stays on one filesystem) then swap.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(records, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())      # force bytes to disk before rename
        os.replace(tmp_name, path)         # atomic on POSIX filesystems
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def repair_geometry(geom):
    """Return a valid geometry, repairing self-intersections when needed.

    explain_validity() reports WHY a geometry is invalid without raising;
    make_valid() rebuilds it into a valid equivalent. Doing this before
    to_crs() stops a topology error from aborting the feature.
    """
    reason = explain_validity(geom)
    if reason == "Valid Geometry":
        return geom
    return make_valid(geom)


def transform_features(
    gdf: gpd.GeoDataFrame, target_crs: str, id_field: str
) -> tuple[gpd.GeoDataFrame, list[dict]]:
    """Reproject each feature; quarantine any that fail.

    Returns the clean subset plus a list of dead-letter records. One bad
    feature never stops the loop — that is the whole point of the queue.
    """
    if gdf.crs is None:
        # No source CRS means to_crs cannot even start: fail the whole run.
        raise CRSError("source layer has no CRS; cannot reproject")

    clean_rows = []
    dead_letters: list[dict] = []

    for position, row in gdf.iterrows():
        feature_id = row.get(id_field, position)
        geom = row.geometry
        if geom is None or geom.is_empty:
            dead_letters.append(_dead_record(feature_id, "EmptyGeometry", geom))
            continue
        try:
            repaired = repair_geometry(geom)
            single = gpd.GeoDataFrame(
                [row.drop(labels="geometry")],
                geometry=[repaired],
                crs=gdf.crs,
            )
            reprojected = single.to_crs(target_crs)   # per-feature transform
            out_row = reprojected.iloc[0]
            clean_rows.append(out_row)
        except (GEOSException, CRSError, ValueError) as exc:
            dead_letters.append(
                _dead_record(feature_id, type(exc).__name__, geom, str(exc))
            )

    clean = gpd.GeoDataFrame(clean_rows, crs=target_crs) if clean_rows \
        else gpd.GeoDataFrame(geometry=[], crs=target_crs)
    return clean, dead_letters


def _dead_record(feature_id, error_class, geom, detail: str = "") -> dict:
    """Serialise one failure. Store the ORIGINAL geometry as WKT so replay
    starts from the untouched input, not a partially repaired version."""
    return {
        "feature_id": feature_id if isinstance(feature_id, (int, str)) else str(feature_id),
        "error_class": error_class,
        "detail": detail,
        "geometry_wkt": geom.wkt if geom is not None else None,
    }


def run(src: Path, clean_out: Path, dlq_out: Path, target_crs: str, id_field: str) -> int:
    gdf = gpd.read_file(src, engine="pyogrio")
    total = len(gdf)

    clean, dead_letters = transform_features(gdf, target_crs, id_field)

    if len(clean) > 0:
        clean.to_file(clean_out, engine="pyogrio")
    atomic_write_json(dead_letters, dlq_out)

    clean_count = len(clean)
    dead_letter_count = len(dead_letters)
    assert clean_count + dead_letter_count == total, "feature count mismatch"
    print(f"total={total} clean={clean_count} dead_letter={dead_letter_count}")

    return EXIT_PARTIAL_FAILURE if dead_letter_count else EXIT_OK


def replay(dlq_in: Path, out: Path, target_crs: str) -> int:
    """Re-read the dead-letter file and retry only the failed features.

    Once the root cause is fixed (bad source data patched, CRS corrected),
    this rebuilds a GeoDataFrame from the stored WKT and runs the transform
    again — clean successes go to `out`, still-failing rows are reported.
    """
    records = json.loads(dlq_in.read_text(encoding="utf-8"))
    geoms, ids = [], []
    for rec in records:
        if rec["geometry_wkt"] is None:
            continue
        geoms.append(wkt.loads(rec["geometry_wkt"]))
        ids.append(rec["feature_id"])

    # WKT carries no CRS, so re-attach the ORIGINAL source CRS here.
    replay_gdf = gpd.GeoDataFrame(
        {"feature_id": ids}, geometry=geoms, crs="EPSG:4326"
    )
    clean, still_failing = transform_features(replay_gdf, target_crs, "feature_id")
    if len(clean) > 0:
        clean.to_file(out, engine="pyogrio")
    print(f"replayed={len(records)} recovered={len(clean)} still_failing={len(still_failing)}")
    return EXIT_OK if not still_failing else EXIT_PARTIAL_FAILURE


def main() -> None:
    parser = argparse.ArgumentParser(description="Feature-level transform with a dead-letter queue")
    parser.add_argument("--replay", action="store_true", help="Replay a dead-letter file")
    parser.add_argument("--target-crs", default="EPSG:3857", help="Target CRS (default EPSG:3857)")
    parser.add_argument("--id-field", default="id", help="Attribute used as the feature id")
    parser.add_argument("paths", nargs="+", type=Path, help="input clean_out dlq_out | dlq_in out")
    args = parser.parse_args()

    try:
        if args.replay:
            dlq_in, out = args.paths
            sys.exit(replay(dlq_in, out, args.target_crs))
        src, clean_out, dlq_out = args.paths
        sys.exit(run(src, clean_out, dlq_out, args.target_crs, args.id_field))
    except CRSError as exc:
        print(f"CRS error: {exc}", file=sys.stderr)
        sys.exit(EXIT_CRS_MISMATCH)


if __name__ == "__main__":
    main()
```

## Step Annotations

1. **Per-feature `iterrows()` loop** — Reprojecting the whole frame in one `to_crs` call means a single invalid geometry aborts the entire batch. Iterating lets the try/except isolate each feature so failures are quarantined, not fatal.

2. **`explain_validity()` before `make_valid()`** — `explain_validity` returns a human-readable reason (`"Self-intersection[12.0 4.5]"`) without raising, so you can log why the geometry was suspect. `make_valid` then rebuilds it into a valid equivalent that survives reprojection.

3. **Single-feature `GeoDataFrame` for `to_crs`** — Wrapping one row keeps pyproj's transformation pipeline and the row's attributes together, and any CRS mismatch or topology fault is raised for that feature alone.

4. **Original geometry stored as WKT** — `_dead_record` serialises `geom.wkt` from the untouched input, not the repaired version. Replay should start from exactly what failed so you never bake a lossy repair into the retry.

5. **Atomic write with `mkstemp` + `os.replace`** — The temp file is created in the destination directory so `os.replace` stays on one filesystem and is atomic. `os.fsync` forces the bytes to disk before the swap, so a crash cannot leave a truncated dead-letter file.

6. **Exit code `12` on partial failure** — A non-empty dead-letter file means some features were written and some quarantined. Returning `12` (partial batch failure) lets a scheduler distinguish a recoverable run from a clean `0` or a hard CRS failure at `10`.

## Named Gotcha: Self-Intersecting Polygons Raise Only on Operations

The most common surprise is that a bad polygon loads without complaint. `gpd.read_file` and pyogrio only parse coordinates into a geometry object; they never walk the ring to check topology. A self-intersecting or bowtie polygon sits in the GeoDataFrame looking perfectly normal, and `len(gdf)` counts it like any other feature.

The failure surfaces later, when an operation actually traverses the geometry: `to_crs`, `buffer`, an overlay, or an area calculation. At that point Shapely's GEOS backend raises a `GEOSException` such as `TopologyException: Input geom 0 is invalid`. If you only guard the read step, these features slip through and blow up mid-transform.

The fix is to check validity explicitly before the operation. `explain_validity(geom)` tells you the reason without raising, and `make_valid(geom)` repairs it — splitting a bowtie into a valid MultiPolygon, for example. The implementation above runs both inside `repair_geometry` so a self-intersection is repaired rather than quarantined, and only geometries that even `make_valid` cannot rescue land in the dead-letter file.

## Verification

Confirm no feature was silently dropped: the clean count plus the dead-letter count must equal the source total. The script asserts this internally, but verify it from the outside too:

```bash
# Source feature count
python3 -c "import geopandas as gpd; print(len(gpd.read_file('input.gpkg')))"

# Clean output count
python3 -c "import geopandas as gpd; print(len(gpd.read_file('clean.gpkg')))"

# Dead-letter count and error classes
python3 - <<'EOF'
import json
records = json.load(open("dead_letter.json"))
print("dead_letter_count:", len(records))
from collections import Counter
print(Counter(r["error_class"] for r in records))
EOF

echo "exit code was: $?"   # 12 means partial failure with a populated queue
```

If clean plus dead-letter equals the source total and the exit code is `12`, the queue captured every failure and the clean layer is safe to hand downstream. Pair this with [structured JSON logging of each transformation result](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) so the same counts appear in your run log.

## FAQ

<details class="faq-item">
<summary><span>Why does a self-intersecting polygon load fine but fail on <code>to_crs</code>?</span></summary>

Reading a feature only parses coordinates; it never checks topology. Shapely raises on self-intersections only when an operation such as reprojection, buffering, or an overlay walks the ring. Call `explain_validity` to see the reason and `make_valid` to repair the geometry before the transform runs.
</details>

<details class="faq-item">
<summary>Should the dead-letter file be JSON or a shapefile?</summary>

Use JSON. A failed geometry may be structurally invalid, which many vector drivers refuse to write, and you also want to store the `error_class` and a traceback alongside the WKT. Plain JSON with a WKT string per record survives invalid geometries and stays diff-friendly for replay.
</details>

<details class="faq-item">
<summary>Why write the dead-letter file atomically?</summary>

A batch that is killed mid-write leaves a truncated JSON file that breaks the replay step. Writing to a temporary file in the same directory and calling `os.replace` makes the swap atomic on POSIX filesystems, so readers always see either the old file or the complete new one.
</details>

<details class="faq-item">
<summary>What exit code should a partial batch failure return?</summary>

Return exit code `12` for partial batch failure: some features were written cleanly and some were quarantined. Reserve `0` for a fully clean run and `10` for a CRS mismatch that stops the whole job. This lets a scheduler distinguish a recoverable partial run from a hard failure.
</details>

---

## Related

- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — parent guide covering failure capture, retries, and structured error reporting for batch vector and raster workflows
- [Logging Spatial Transformations to Structured JSON](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/logging-spatial-transformation-results-to-structured-json/) — record every per-feature outcome, including dead-letter entries, in a machine-readable run log
