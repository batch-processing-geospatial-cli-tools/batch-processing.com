---
title: "How to Build a Typer CLI for Shapefile Conversion"
description: "Build a Typer CLI that batch-converts Shapefiles to GeoJSON, GeoPackage, FlatGeobuf, or Parquet using pyogrio, with CRS handling and deterministic exit codes."
slug: "how-to-build-a-typer-cli-for-shapefile-conversion"
type: "long_tail"
breadcrumb: "CLI Architecture > Argument Parsing with Typer > How to Build a Typer CLI for Shapefile Conversion"
datePublished: "2024-11-14"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "How to Build a Typer CLI for Shapefile Conversion",
      "description": "Step-by-step guide to building a production-grade Typer CLI that batch-converts ESRI Shapefiles to GeoJSON, GeoPackage, FlatGeobuf, or Parquet using pyogrio, with CRS handling and deterministic exit codes.",
      "datePublished": "2024-11-14",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 2, "name": "Argument Parsing with Typer", "item": "https://batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/"},
        {"@type": "ListItem", "position": 3, "name": "How to Build a Typer CLI for Shapefile Conversion", "item": "https://batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/how-to-build-a-typer-cli-for-shapefile-conversion/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a Typer CLI for Shapefile Conversion",
      "description": "Build a batch shapefile converter CLI using Typer and pyogrio with CRS handling, progress tracking, and deterministic exit codes.",
      "step": [
        {"@type": "HowToStep", "name": "Install dependencies", "text": "pip install typer[all] geopandas pyogrio"},
        {"@type": "HowToStep", "name": "Define the Typer app and format registry", "text": "Create a Typer app instance, declare SUPPORTED_FORMATS and DRIVER_MAP constants."},
        {"@type": "HowToStep", "name": "Implement resolve_targets()", "text": "Normalize a single .shp path, directory, or glob pattern into a deterministic list of Path objects."},
        {"@type": "HowToStep", "name": "Implement the convert command", "text": "Use @app.command() with typed arguments, validate format early, iterate with Rich progress, and emit exit codes 0/1/2/3."},
        {"@type": "HowToStep", "name": "Verify output", "text": "Use ogrinfo or geopandas to confirm CRS, row count, and geometry validity of the converted file."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why use pyogrio instead of fiona for shapefile I/O?",
          "acceptedAnswer": {"@type": "Answer", "text": "pyogrio is a zero-copy C extension that calls GDAL/OGR directly without Python-level feature iteration. For batch shapefile conversion, pyogrio is 3–8x faster than fiona and is the default engine in GeoPandas ≥1.0."}
        },
        {
          "@type": "Question",
          "name": "How do I handle CRS mismatches silently causing wrong coordinates?",
          "acceptedAnswer": {"@type": "Answer", "text": "Always pass target_crs explicitly. Use pyproj.CRS.from_user_input() to validate the CRS string before processing any files, then call gdf.to_crs() during conversion."}
        },
        {
          "@type": "Question",
          "name": "What is the difference between exit code 2 and exit code 3?",
          "acceptedAnswer": {"@type": "Answer", "text": "Exit code 2 means no .shp files matched the input path — nothing was attempted. Exit code 3 means at least one file was attempted but failed; some outputs may exist. CI systems should treat both as errors but with different remediation paths."}
        }
      ]
    }
  ]
}
</script>

# How to Build a Typer CLI for Shapefile Conversion

Combine [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) with `geopandas` (backed by `pyogrio`) to batch-convert ESRI Shapefiles to GeoJSON, GeoPackage, FlatGeobuf, or Parquet. Declare a single `@app.command()` function, resolve globs or directories into an explicit file list before any I/O begins, stream progress via Rich, and return deterministic exit codes that CI/CD pipelines can act on without parsing log text.

## Prerequisites

```bash
pip install "typer[all]" geopandas pyogrio
```

GeoPandas ≥ 1.0 defaults to `pyogrio` for all vector I/O, replacing the older `fiona` bindings with a faster, thread-safe C extension built directly on GDAL/OGR. For broader context on structuring spatial command-line tools, this page is part of the [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) guide.

## Data-flow overview

The converter moves through three sequential phases. Understanding where each failure mode lives helps you add the right guard at the right point.

<svg viewBox="0 0 680 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Shapefile conversion CLI data flow: Resolution → Validation → Execution → Output" style="width:100%;max-width:680px;display:block;margin:1.5rem auto;">
  <title>Shapefile conversion CLI data flow</title>
  <desc>Three-phase pipeline: Resolution (input path → .shp list), Validation (format check, CRS parse), Execution (pyogrio read → reproject → write), with error exits at each phase.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- boxes -->
  <rect x="10"  y="40" width="130" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="185" y="40" width="130" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="360" y="40" width="150" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="555" y="40" width="110" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <!-- labels inside boxes -->
  <text x="75"  y="61" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Resolution</text>
  <text x="75"  y="78" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">path/dir/glob</text>
  <text x="75"  y="90" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">→ [Path, …]</text>
  <text x="250" y="61" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Validation</text>
  <text x="250" y="78" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">format + CRS</text>
  <text x="250" y="90" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">check (exit 1)</text>
  <text x="435" y="61" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Execution</text>
  <text x="435" y="78" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">pyogrio read →</text>
  <text x="435" y="90" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">reproject → write</text>
  <text x="610" y="61" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Output</text>
  <text x="610" y="78" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">converted/</text>
  <text x="610" y="90" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">exit 0 or 3</text>
  <!-- arrows -->
  <line x1="140" y1="66" x2="181" y2="66" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <line x1="315" y1="66" x2="356" y2="66" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <line x1="510" y1="66" x2="551" y2="66" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <!-- exit 2 drop-off below Resolution -->
  <line x1="75" y1="92" x2="75" y2="118" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.5"/>
  <text x="78" y="131" font-size="10" font-family="inherit" fill="currentColor" opacity="0.6">exit 2 (no files)</text>
</svg>

## Complete working implementation

```python
#!/usr/bin/env python3
"""shapefile_converter.py — batch-convert ESRI Shapefiles to modern vector formats."""
from pathlib import Path
from typing import List, Optional

import typer
from rich.progress import track
import geopandas as gpd
from pyproj import CRS
from pyproj.exceptions import CRSError

app = typer.Typer(
    help="Batch-convert ESRI Shapefiles to GeoJSON, GeoPackage, FlatGeobuf, or Parquet.",
    add_completion=True,
)

SUPPORTED_FORMATS = {"geojson", "gpkg", "fgb", "parquet"}
DRIVER_MAP = {
    "geojson":  "GeoJSON",
    "gpkg":     "GPKG",
    "fgb":      "FlatGeobuf",
    "parquet":  "Parquet",        # written via gdf.to_parquet(), driver key unused
}


def resolve_targets(input_path: Path) -> List[Path]:
    """Normalise a single .shp file, directory, or glob into an explicit file list."""
    if input_path.is_file() and input_path.suffix.lower() == ".shp":
        return [input_path]
    if input_path.is_dir():
        return sorted(input_path.glob("*.shp"))
    # Treat the string as a glob relative to cwd
    resolved = sorted(Path.cwd().glob(str(input_path)))
    return [p for p in resolved if p.suffix.lower() == ".shp"]


def _validate_crs(crs_string: str) -> None:
    """Exit with code 1 if the CRS string is not accepted by pyproj."""
    try:
        CRS.from_user_input(crs_string)
    except CRSError as exc:
        typer.echo(f"Invalid CRS '{crs_string}': {exc}", err=True)
        raise typer.Exit(code=1)


@app.command()
def convert(
    input_path: Path = typer.Argument(..., help="Path to .shp file, directory, or glob"),
    output_format: str = typer.Option(
        "gpkg", "--output-format", "-f",
        help=f"Target format: {', '.join(sorted(SUPPORTED_FORMATS))}",
    ),
    target_crs: Optional[str] = typer.Option(
        None, "--target-crs",
        help="Reproject to this CRS before writing (e.g. EPSG:4326).",
    ),
    output_dir: Path = typer.Option(Path("converted"), "--output-dir", "-o"),
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Suppress Rich progress bar."),
) -> None:
    # --- 1. Validate format early, before touching the filesystem ---
    fmt = output_format.lower()
    if fmt not in SUPPORTED_FORMATS:
        typer.echo(f"Unsupported format '{fmt}'. Choose from: {', '.join(sorted(SUPPORTED_FORMATS))}", err=True)
        raise typer.Exit(code=1)

    # --- 2. Validate CRS string before any file I/O ---
    if target_crs:
        _validate_crs(target_crs)

    # --- 3. Resolve input to an explicit list of .shp paths ---
    files = resolve_targets(input_path)
    if not files:
        typer.echo(f"No .shp files found matching: {input_path}", err=True)
        raise typer.Exit(code=2)

    output_dir.mkdir(parents=True, exist_ok=True)
    success_count = 0
    fail_count = 0

    iterator = files if quiet else track(files, description="Converting")

    for src in iterator:
        try:
            # --- 4. Read with pyogrio (thread-safe, zero-copy C layer over GDAL) ---
            gdf = gpd.read_file(src, engine="pyogrio")

            # --- 5. Reproject if requested (pyproj handles authority validation) ---
            if target_crs:
                gdf = gdf.to_crs(target_crs)

            out_path = output_dir / f"{src.stem}.{fmt}"

            # --- 6. Write: Parquet uses a dedicated method; all others use to_file() ---
            if fmt == "parquet":
                gdf.to_parquet(out_path)
            else:
                gdf.to_file(out_path, driver=DRIVER_MAP[fmt], engine="pyogrio")

            success_count += 1
        except Exception as exc:
            typer.echo(f"  FAILED {src.name}: {exc}", err=True)
            fail_count += 1

    typer.echo(f"\nDone — {success_count} converted, {fail_count} failed.")
    if fail_count > 0:
        raise typer.Exit(code=3)


if __name__ == "__main__":
    app()
```

## Step annotations

**Step 1 — format validation before I/O.** Checking `fmt not in SUPPORTED_FORMATS` before `resolve_targets()` means a typo in `--output-format` fails instantly, without scanning the filesystem or opening any files. Fail-fast at the cheapest possible boundary.

**Step 2 — CRS pre-flight via pyproj.** `CRS.from_user_input()` accepts EPSG codes (`EPSG:4326`), PROJ strings, and WKT. Calling it before the loop means an invalid CRS string exits with code `1` before writing any output files that would then need to be cleaned up.

**Step 3 — resolve_targets() contract.** The function normalises three different user inputs (single file, directory, glob) into one type: `List[Path]`. Every path in that list is guaranteed to have `.suffix == ".shp"`. The conversion loop never needs to re-check this.

**Step 4 — pyogrio engine.** Passing `engine="pyogrio"` to `read_file()` bypasses the fiona Python feature-iteration layer. pyogrio calls GDAL's C-level `OGR_L_GetNextFeature` in a tight loop and returns an Arrow table, which GeoPandas wraps without copying. For files >500 MB, this difference is measurable.

**Step 5 — CRS coercion inside the loop.** `gdf.to_crs(target_crs)` delegates to pyproj's `Transformer`. The authority code is already validated at step 2, so inside the loop this call is guaranteed to succeed unless the source file lacks a defined CRS — which triggers the `except` block and increments `fail_count`.

**Step 6 — Parquet write path.** `gdf.to_file(driver="Parquet", engine="pyogrio")` is not supported in pyogrio's current stable API. Writing GeoParquet requires `gdf.to_parquet(path)` directly. The `if fmt == "parquet"` branch prevents a silent runtime error that only surfaces on the first Parquet write attempt.

## The one gotcha: source shapefile has no `.prj` file

ESRI Shapefiles store CRS metadata in a sidecar `.prj` file. When `.prj` is absent or empty, `gdf.crs` is `None`. If you then call `gdf.to_crs("EPSG:4326")`, GeoPandas raises `ValueError: Cannot transform naive geometries`.

Fix this with an explicit guard before reprojection:

```python
if target_crs:
    if gdf.crs is None:
        typer.echo(
            f"  WARN {src.name}: no CRS defined — assuming EPSG:4326 before reprojection.",
            err=True,
        )
        gdf = gdf.set_crs("EPSG:4326")
    gdf = gdf.to_crs(target_crs)
```

Choose the assumption carefully. If the source data is genuinely unknown, log a warning and skip the file rather than silently injecting a wrong CRS.

## Verification

After a conversion run, confirm the output geometry, row count, and CRS match expectations:

```bash
# Quick check with ogrinfo (ships with GDAL)
ogrinfo -al -so converted/admin_boundaries.gpkg

# Programmatic check — row count and CRS authority code
python - <<'EOF'
import geopandas as gpd
gdf = gpd.read_file("converted/admin_boundaries.gpkg", engine="pyogrio")
assert len(gdf) > 0, "Output is empty"
assert gdf.crs is not None, "CRS is missing"
print(f"rows={len(gdf)}  crs={gdf.crs.to_epsg()}  geom={gdf.geom_type.unique()}")
EOF
```

Expected output for a correctly converted file with `--target-crs EPSG:4326`:

```
rows=3247  crs=4326  geom=['MultiPolygon']
```

## Exit code reference

| Code | Meaning | CI action |
|------|---------|-----------|
| `0` | All files converted successfully | Pass |
| `1` | Invalid argument (bad format or CRS string) | Fail — fix the command |
| `2` | No `.shp` files matched the input path | Fail — check glob or directory |
| `3` | Partial failure — at least one file errored | Fail — inspect stderr for named failures |

Use `--quiet` in automated pipelines to suppress Rich progress bars, which emit ANSI escape sequences that corrupt log parsers expecting plain text. For more on structuring Rich output to stay pipeline-friendly, see [Rich Console Output and Progress Bars](/cli-architecture-design-patterns/rich-console-output-progress-bars/).

## FAQ

<details class="faq-item">
<summary>Why prefer pyogrio over fiona for batch shapefile reads?</summary>

pyogrio is a zero-copy C extension that calls GDAL/OGR directly, bypassing the Python-level feature-by-feature iteration that fiona uses. For batch shapefile conversion, pyogrio is typically 3–8x faster and is the default `engine` in GeoPandas ≥ 1.0. fiona remains useful for streaming reads of very large single files where you want manual control over feature batches.

</details>

<details class="faq-item">
<summary>Can I convert multiple formats in one run?</summary>

Not with this implementation — `--output-format` accepts one target. For multi-format output, invoke the CLI once per format or wrap it in a shell loop:

```bash
for fmt in gpkg geojson; do
  python shapefile_converter.py data/ --output-format "$fmt" --output-dir "converted/$fmt"
done
```

</details>

<details class="faq-item">
<summary>How do I handle shapefiles larger than available RAM?</summary>

For datasets exceeding available memory, read in chunks using `pyogrio.read_arrow()` with a `where` clause, or use `gpd.read_file()` with the `rows` parameter to page through features. For datasets above 2 GB, consider converting to GeoPackage or FlatGeobuf first (both support streaming writes), then processing in windows. See [Memory Management for Large Geospatial Datasets](/spatial-batch-processing-async-workflows/memory-management-for-large-datasets/) for chunked strategies.

</details>

<details class="faq-item">
<summary>What if the output directory already contains converted files from a previous run?</summary>

The implementation overwrites silently — `to_file()` and `to_parquet()` both replace existing files. Add a `--no-overwrite` flag and a `if out_path.exists(): continue` guard to make the command idempotent, which is important for resumable batch jobs that may restart partway through a large directory.

</details>

---

## Related

- [Argument Parsing with Typer for GIS CLI Tools](/cli-architecture-design-patterns/argument-parsing-with-typer/) — the parent guide covering type-hint-driven argument parsing, custom validators, and multi-command app structure
- [Adding Auto-Completion to Python Spatial CLI Tools](/cli-architecture-design-patterns/argument-parsing-with-typer/adding-auto-completion-to-python-spatial-cli-tools/) — extend this converter with dynamic completers for format names and EPSG codes
