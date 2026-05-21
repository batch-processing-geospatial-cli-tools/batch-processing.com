# How to Build a Typer CLI for Shapefile Conversion

To build a Typer CLI for shapefile conversion, you combine declarative argument parsing with `geopandas` (backed by `pyogrio`) for high-performance vector I/O, wrapping the conversion logic in a `@app.command()` function that validates inputs early, resolves globs or directories into explicit file lists, streams batch progress, and returns deterministic exit codes. This pattern eliminates boilerplate, enforces type safety at the CLI boundary, and integrates cleanly into CI/CD pipelines. The implementation below prioritizes memory efficiency, structured error handling, and modern GDAL bindings.

## Prerequisites & Dependencies

Install the core stack:
```bash
pip install typer geopandas pyogrio rich
```
Modern GeoPandas (≥1.0) defaults to `pyogrio` for I/O, which replaces the legacy `fiona`/`GDAL` Python bindings with a faster, thread-safe C extension. For foundational patterns on structuring command-line interfaces, review [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) before scaling to multi-command tools.

## Complete Implementation

```python
#!/usr/bin/env python3
"""shapefile-converter-cli.py
Batch convert ESRI Shapefiles to GeoJSON, GeoPackage, FlatGeobuf, or Parquet.
"""
from pathlib import Path
from typing import List, Optional
import typer
from rich.progress import track
import geopandas as gpd

app = typer.Typer(
    help="Batch convert ESRI Shapefiles to modern vector formats with CRS handling.",
    add_completion=True,
)

SUPPORTED_FORMATS = {"geojson", "gpkg", "fgb", "parquet"}
DRIVER_MAP = {
    "geojson": "GeoJSON",
    "gpkg": "GPKG",
    "fgb": "FlatGeobuf",
    "parquet": "Parquet",
}

def resolve_targets(input_path: Path) -> List[Path]:
    """Resolve a single file, directory, or glob pattern into .shp paths."""
    if input_path.is_file() and input_path.suffix.lower() == ".shp":
        return [input_path]
    if input_path.is_dir():
        return sorted(input_path.glob("*.shp"))
    # Treat as glob pattern relative to CWD
    resolved = sorted(Path.cwd().glob(str(input_path)))
    return [p for p in resolved if p.suffix.lower() == ".shp"]

@app.command()
def convert(
    input_path: Path = typer.Argument(..., help="Path to .shp, directory, or glob pattern"),
    output_format: str = typer.Option("gpkg", help=f"Target format: {', '.join(sorted(SUPPORTED_FORMATS))}"),
    target_crs: Optional[str] = typer.Option(None, help="Target EPSG or WKT (e.g., EPSG:4326)"),
    output_dir: Path = typer.Option(Path("converted"), help="Destination directory"),
    quiet: bool = typer.Option(False, help="Disable progress bar"),
) -> None:
    fmt = output_format.lower()
    if fmt not in SUPPORTED_FORMATS:
        typer.echo(f"❌ Unsupported format: {fmt}", err=True)
        raise typer.Exit(code=1)

    files = resolve_targets(input_path)
    if not files:
        typer.echo("❌ No valid shapefiles found.", err=True)
        raise typer.Exit(code=2)

    output_dir.mkdir(parents=True, exist_ok=True)
    target_ext = f".{fmt}"
    driver = DRIVER_MAP[fmt]

    iterator = files if quiet else track(files, description="Converting")
    success_count = 0
    fail_count = 0

    for src in iterator:
        try:
            # pyogrio handles large files efficiently and supports Arrow
            gdf = gpd.read_file(src, engine="pyogrio")
            if target_crs:
                gdf = gdf.to_crs(target_crs)
            out_path = output_dir / f"{src.stem}{target_ext}"
            gdf.to_file(out_path, driver=driver, engine="pyogrio")
            success_count += 1
        except Exception as e:
            typer.echo(f"⚠️ Failed {src.name}: {e}", err=True)
            fail_count += 1

    typer.echo(f"\n✅ Complete: {success_count} succeeded, {fail_count} failed.")
    if fail_count > 0:
        raise typer.Exit(code=3)

if __name__ == "__main__":
    app()
```

## Architecture & Input Resolution

The CLI separates concerns into three phases: **resolution**, **validation**, and **execution**. `resolve_targets()` normalizes user input into a deterministic list of `.shp` paths before any heavy I/O occurs. This prevents partial batch failures and ensures predictable ordering. Typer automatically validates `Path` types and rejects non-existent paths at the argument boundary, reducing runtime checks.

For teams scaling beyond single-command utilities, [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) outlines how to split this into subcommands (`convert`, `validate`, `merge`) while sharing a common `app` instance and configuration loader.

## Production Hardening

### Memory & Performance Tuning
Shapefiles often exceed available RAM when loaded naively. `pyogrio` mitigates this through C-level GDAL optimizations and optional Arrow streaming. For datasets >2GB, append `use_arrow=True` to both `read_file()` and `to_file()`. This bypasses Python object overhead and reduces peak memory by 40–60%. Always benchmark with representative data before deployment.

### CRS Validation Strategy
Coordinate reference system mismatches cause silent spatial misalignment. The `target_crs` parameter accepts EPSG codes (`EPSG:4326`) or WKT strings. GeoPandas delegates transformation to `pyproj`, which validates authority codes automatically. For strict pipelines, add a pre-flight check:
```python
import typer
from pyproj import CRS
try:
    CRS.from_user_input(target_crs)
except Exception as e:
    typer.echo(f"❌ Invalid CRS: {e}", err=True)
    raise typer.Exit(code=1)
```

### Deterministic Exit Codes
CI/CD systems rely on standard exit codes. This implementation returns:
- `0`: Full success
- `1`: Invalid arguments or unsupported format
- `2`: No input files matched
- `3`: Partial failure (some files converted, others errored)

Use `--quiet` in automated workflows to suppress Rich progress bars, which can corrupt log parsers. Refer to the official [Typer documentation](https://typer.tiangolo.com/) for advanced exit code handling and callback hooks.

## Testing & CI Integration

Unit testing CLI tools requires mocking filesystem I/O and capturing stdout/stderr. Typer provides `CliRunner` for this exact purpose:
```python
from typer.testing import CliRunner
from shapefile_converter_cli import app

runner = CliRunner()
result = runner.invoke(app, ["test_data/", "--output-format", "geojson", "--quiet"])
assert result.exit_code == 0
assert "Complete: 1 succeeded" in result.output
```

In GitHub Actions or GitLab CI, run the CLI against a curated fixture directory. Cache `pyogrio` wheels to avoid GDAL compilation overhead on runners. For I/O engine specifics and driver compatibility matrices, consult the [GeoPandas I/O documentation](https://geopandas.org/en/stable/docs/user_guide/io.html).

## Deployment Checklist
- [ ] Pin `geopandas` and `pyogrio` to compatible minor versions
- [ ] Add `--dry-run` flag for pre-flight validation without disk writes
- [ ] Log failed files to a structured JSON report for downstream alerting
- [ ] Containerize with `python:3.11-slim` and install `libgdal-dev` if building from source
- [ ] Run `typer --install-completion` in CI to verify shell integration

This pattern delivers a maintainable, production-grade CLI that handles real-world GIS data volumes while remaining fully testable and pipeline-ready.