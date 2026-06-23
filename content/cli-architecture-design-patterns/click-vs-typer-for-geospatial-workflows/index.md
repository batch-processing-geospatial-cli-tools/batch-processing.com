---
title: "Click vs Typer for Geospatial Workflows"
description: "Compare Click and Typer for building geospatial Python CLIs: type safety, CRS validation, batch processing patterns, and production deployment trade-offs."
slug: "click-vs-typer-for-geospatial-workflows"
type: "cluster"
breadcrumb: "Click vs Typer"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Click vs Typer for Geospatial Workflows",
      "description": "Compare Click and Typer for building geospatial Python CLIs: type safety, CRS validation, batch processing patterns, and production deployment trade-offs.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 3, "name": "Click vs Typer for Geospatial Workflows", "item": "https://batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a production geospatial CLI with Click or Typer",
      "step": [
        {"@type": "HowToStep", "name": "Isolate the geospatial environment", "text": "Pin GDAL, PROJ, and shapely versions; validate availability at import time."},
        {"@type": "HowToStep", "name": "Choose a framework", "text": "Use Typer for type-driven rapid development; use Click for explicit callback control."},
        {"@type": "HowToStep", "name": "Define command groups by data type", "text": "Group subcommands under vector, raster, and metadata to mirror GIS taxonomy."},
        {"@type": "HowToStep", "name": "Validate CRS inputs at the boundary", "text": "Attach pyproj validator callbacks to EPSG options before any processing begins."},
        {"@type": "HowToStep", "name": "Wire in layered config", "text": "Cascade defaults → YAML file → environment variables → CLI flags for every spatial option."},
        {"@type": "HowToStep", "name": "Verify with exit codes", "text": "Return POSIX exit codes 0/1/2 and log structured JSON on failure for CI integration."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Can I mix Click and Typer in the same project?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes — Typer wraps Click internally, so you can call typer.main.get_command() to expose a Typer app as a Click group, enabling incremental migration of existing Click commands."}
        },
        {
          "@type": "Question",
          "name": "How do I validate a bounding box argument in Typer?",
          "acceptedAnswer": {"@type": "Answer", "text": "Define a callback that parses the string into four floats, validates min/max ordering and coordinate range for the target CRS, and raises typer.BadParameter with a human-readable message on failure."}
        },
        {
          "@type": "Question",
          "name": "Why does importing geopandas slow my CLI startup?",
          "acceptedAnswer": {"@type": "Answer", "text": "geopandas loads pyogrio/fiona, GDAL, and PROJ on import. Defer the import to inside the command function body so that help text and argument validation remain instant even when the geospatial stack is not installed."}
        },
        {
          "@type": "Question",
          "name": "Which framework works better with PyInstaller for distribution?",
          "acceptedAnswer": {"@type": "Answer", "text": "Both work, but Click's smaller dependency surface makes PyInstaller hidden-import lists shorter. With Typer you must ensure rich and its extras are collected; with Click you only need click itself plus your GIS stack."}
        },
        {
          "@type": "Question",
          "name": "How do I test a Typer command that reads a real shapefile?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use typer.testing.CliRunner with pytest's tmp_path fixture. Write a minimal GeoPackage with geopandas into tmp_path, then invoke the command with runner.invoke(app, [str(tmp_path / 'test.gpkg')]). Assert both the exit code and the output file's CRS."}
        }
      ]
    }
  ]
}
</script>

**TL;DR:** For greenfield geospatial tooling choose [Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) — its native type hints eliminate boilerplate CRS validation; for legacy code or intricate parameter interdependencies, Click's explicit callback chain gives finer control with no surprises.

## Prerequisites

This page is part of the [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) guide.

- Python 3.10 or later (required for `match` statements and `typing.Annotated`)
- `click>=8.1` or `typer>=0.12` (Typer 0.12 targets Click 8.1 internally)
- Geospatial stack: `geopandas>=0.14`, `rasterio>=1.3.9`, `pyproj>=3.6`, `shapely>=2.0`
- Optional but recommended: `pyogrio>=0.7` as the vector I/O engine (faster than `fiona` for batch reads)
- `rich>=13` for progress bars and formatted output
- `uv` or `pip-tools` for reproducible wheels — system GDAL bindings must match the Python package versions exactly

Install the minimal set:

```bash
pip install "typer[all]>=0.12" geopandas pyogrio pyproj rasterio shapely
```

## Problem Framing

A geospatial batch pipeline fails in ways that generic Python CLIs do not: a CRS mismatch between input files silently produces geometrically correct but geographically wrong output; a missing GDAL driver raises an `OSError` deep inside a ten-second raster read rather than at startup; an invalid EPSG code is accepted by the argument parser and only rejected when `pyproj.CRS.from_epsg()` fires during the first geometry transform. These failures share a root cause — validation happens too late, after expensive I/O has already begun. The framework decision shapes where validation lives and how clearly it reports failures.

---

<svg viewBox="0 0 820 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision diagram: choosing between Click and Typer for a geospatial CLI" style="width:100%;max-width:820px;display:block;margin:2rem auto;">
  <title>Click vs Typer decision flow for geospatial CLIs</title>
  <desc>A flowchart showing the decision path from "New geospatial CLI?" through three questions — greenfield vs legacy, complex parameter interdependencies, and Rich output priority — arriving at either Typer or Click.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Start node -->
  <rect x="310" y="10" width="200" height="44" rx="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="410" y="37" text-anchor="middle" font-size="13" fill="currentColor" font-family="sans-serif">New geospatial CLI?</text>
  <!-- Arrow down -->
  <line x1="410" y1="54" x2="410" y2="80" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <!-- Diamond: Greenfield? -->
  <polygon points="410,80 520,115 410,150 300,115" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="410" y="111" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Greenfield</text>
  <text x="410" y="127" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">codebase?</text>
  <!-- Yes branch: right -->
  <line x1="520" y1="115" x2="620" y2="115" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <text x="565" y="108" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">Yes</text>
  <!-- No branch: left -->
  <line x1="300" y1="115" x2="200" y2="115" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <text x="248" y="108" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">No</text>
  <!-- Diamond: Complex params? (left) -->
  <polygon points="200,115 300,150 200,185 100,150" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="200" y="146" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Complex param</text>
  <text x="200" y="162" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">interdeps?</text>
  <!-- Diamond: Rich output priority? (right) -->
  <polygon points="620,115 720,150 620,185 520,150" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="620" y="146" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Rich output</text>
  <text x="620" y="162" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">priority?</text>
  <!-- Complex params Yes -> Click -->
  <line x1="200" y1="185" x2="200" y2="240" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <text x="208" y="220" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">Yes</text>
  <rect x="120" y="240" width="160" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.9"/>
  <text x="200" y="263" text-anchor="middle" font-size="14" fill="currentColor" font-family="sans-serif" font-weight="bold">Click</text>
  <text x="200" y="278" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">explicit callbacks</text>
  <!-- Complex params No -> Typer -->
  <line x1="300" y1="150" x2="360" y2="150" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <text x="332" y="143" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">No</text>
  <line x1="360" y1="150" x2="360" y2="260" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <line x1="360" y1="260" x2="460" y2="260" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <!-- Rich priority Yes -> Typer -->
  <line x1="620" y1="185" x2="620" y2="210" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <line x1="620" y1="210" x2="540" y2="210" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <line x1="540" y1="210" x2="540" y2="240" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <text x="628" y="204" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">Yes</text>
  <!-- Rich priority No -> Click -->
  <line x1="720" y1="150" x2="760" y2="150" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <line x1="760" y1="150" x2="760" y2="262" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <line x1="760" y1="262" x2="680" y2="262" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)" opacity="0.6"/>
  <text x="738" y="143" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">No</text>
  <rect x="620" y="240" width="160" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.9"/>
  <text x="700" y="263" text-anchor="middle" font-size="14" fill="currentColor" font-family="sans-serif" font-weight="bold">Click</text>
  <text x="700" y="278" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">legacy compat</text>
  <!-- Typer result -->
  <rect x="460" y="240" width="160" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.95"/>
  <text x="540" y="263" text-anchor="middle" font-size="14" fill="currentColor" font-family="sans-serif" font-weight="bold">Typer</text>
  <text x="540" y="278" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.7">type-driven, Rich</text>
</svg>

---

## Architectural Comparison

The foundational difference is where parameter resolution and type coercion live. Click uses explicit decorator stacks (`@click.option`, `@click.argument`, custom `ParamType` subclasses) so the parsing lifecycle is transparent but verbose. Typer reads Python type annotations at import time and generates the full Click command tree internally — you write a plain function signature and get validation, coercion, and Rich-formatted help for free.

| Dimension | Click | Typer |
|---|---|---|
| Validation engine | Manual `ParamType.convert()` callbacks | Inline Python validators passed to `typer.Option(callback=...)` |
| Type coercion | Explicit `type=` on each decorator | Native Python annotations (`Path`, `int`, `Enum`) |
| Help formatting | Plain text, highly customisable | Rich auto-formatted, colour-coded |
| Subcommand groups | `@click.group()` + `@group.command()` | `typer.Typer()` + `app.add_typer()` |
| Context injection | `click.Context` passed explicitly | Via `typer.Context` or function defaults |
| Migration path | Native — Click is stable | Incremental: `typer.main.get_command(app)` exposes a Click group |
| Learning curve | Steeper; explicit every step | Shallower; Pythonic defaults |

For teams comparing options, the [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) page covers type-driven annotation patterns in depth, while Click's strengths become clearer in the [CLI Subcommand Organization](/cli-architecture-design-patterns/cli-subcommand-organization/) discussion.

## Step-by-Step Implementation

The following five steps build a production batch coordinate-transformer CLI. Each step includes the Typer form alongside the equivalent Click pattern so you can evaluate them side by side.

### Step 1 — Guard Geospatial Imports at Module Root

Place dependency guards at the top of your CLI module. If GDAL or PROJ is absent the command should refuse to register rather than failing mid-batch.

```python
# geo_cli/__init__.py
import sys

try:
    import rasterio  # noqa: F401
    import pyogrio   # noqa: F401
    import pyproj    # noqa: F401
except ImportError as exc:
    sys.exit(
        f"Missing geospatial dependency: {exc}\n"
        "Install with: pip install rasterio pyogrio pyproj"
    )
```

See [Handling missing dependencies gracefully in Click apps](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/handling-missing-dependencies-gracefully-in-click-apps/) for an extended pattern that intercepts `OSError` raised during GDAL driver initialisation and wraps it in a structured diagnostic message.

### Step 2 — Define Command Groups by Data Type

Structure subcommands around GIS taxonomy (`vector`, `raster`, `metadata`). In Typer each group is a separate `Typer` instance; in Click it is a `@click.group()` with nested `@group.command()` decorators.

```python
# geo_cli/app.py
import typer
from pathlib import Path

app = typer.Typer(
    name="geocli",
    help="Geospatial batch transformer — reproject, clip, and validate spatial data.",
    no_args_is_help=True,
)
vector_app = typer.Typer(no_args_is_help=True)
raster_app = typer.Typer(no_args_is_help=True)

app.add_typer(vector_app, name="vector", help="Vector file operations (GeoJSON, GPKG, Shapefile).")
app.add_typer(raster_app, name="raster", help="Raster file operations (GeoTIFF, COG, NetCDF).")
```

For a deep dive into structuring complex command hierarchies, consult [CLI Subcommand Organization](/cli-architecture-design-patterns/cli-subcommand-organization/), which covers shared context, command aliases, and lazy-load patterns.

### Step 3 — Validate CRS Inputs at the CLI Boundary

Never let an invalid EPSG code reach `geopandas.GeoDataFrame.to_crs()`. Validate against the live PROJ registry in a Typer callback so the error is raised before any file I/O begins.

```python
# geo_cli/validators.py
import typer
import pyproj

def validate_epsg(value: int) -> int:
    """Reject codes not registered in the local PROJ database."""
    try:
        pyproj.CRS.from_epsg(value)
    except pyproj.exceptions.CRSError as exc:
        raise typer.BadParameter(
            f"EPSG:{value} is not valid in the current PROJ database: {exc}"
        )
    return value

def validate_bbox(value: str) -> tuple[float, float, float, float]:
    """Parse and validate 'minx,miny,maxx,maxy' bounding box string."""
    try:
        parts = [float(p) for p in value.split(",")]
    except ValueError:
        raise typer.BadParameter("Bounding box must be four comma-separated floats.")
    if len(parts) != 4:
        raise typer.BadParameter("Expected exactly four values: minx,miny,maxx,maxy.")
    minx, miny, maxx, maxy = parts
    if minx >= maxx or miny >= maxy:
        raise typer.BadParameter("minx must be less than maxx, and miny less than maxy.")
    return (minx, miny, maxx, maxy)
```

The equivalent Click pattern uses a `click.ParamType` subclass with a `convert()` method — more boilerplate but identical semantics:

```python
# Click equivalent
import click

class EPSGType(click.ParamType):
    name = "epsg"

    def convert(self, value, param, ctx):
        try:
            code = int(value)
            pyproj.CRS.from_epsg(code)
            return code
        except (ValueError, pyproj.exceptions.CRSError) as exc:
            self.fail(f"EPSG:{value} is invalid: {exc}", param, ctx)

EPSG = EPSGType()
```

### Step 4 — Build the Batch Reprojection Command

Wire the validators into a complete command with progress tracking. `pyogrio` is preferred over `fiona` for vector I/O because its vectorised read path is 3–8× faster on large GeoPackages.

```python
# geo_cli/commands/vector.py
from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated

import typer
import geopandas as gpd
from rich.progress import track

from geo_cli.app import vector_app
from geo_cli.validators import validate_epsg

@vector_app.command("reproject")
def reproject_vectors(
    input_dir: Annotated[Path, typer.Argument(
        help="Directory containing GeoJSON or GPKG files.",
        exists=True,
        file_okay=False,
        dir_okay=True,
        readable=True,
    )],
    target_epsg: Annotated[int, typer.Option(
        "--epsg",
        help="Target EPSG code, validated against the PROJ registry.",
        callback=validate_epsg,
    )] = 4326,
    overwrite: Annotated[bool, typer.Option(
        "--overwrite/--no-overwrite",
        help="Overwrite existing output files.",
    )] = False,
) -> None:
    """Reproject all GeoJSON and GPKG files in a directory to a target CRS."""
    # Defer heavy import until command body — keeps help text fast
    patterns = ("*.gpkg", "*.geojson", "*.shp")
    files: list[Path] = []
    for pat in patterns:
        files.extend(input_dir.glob(pat))

    if not files:
        typer.echo(f"No vector files found in {input_dir}", err=True)
        raise typer.Exit(code=2)

    failed: list[str] = []

    for path in track(files, description="Reprojecting…"):
        out_path = path.parent / f"{path.stem}_epsg{target_epsg}.gpkg"

        if out_path.exists() and not overwrite:
            typer.echo(f"Skipping {path.name} — output exists (use --overwrite).", err=True)
            continue

        try:
            # pyogrio engine avoids fiona's per-feature overhead
            gdf: gpd.GeoDataFrame = gpd.read_file(path, engine="pyogrio")

            if gdf.crs is None:
                raise ValueError(f"No CRS defined in {path.name}; set one before reprojecting.")

            gdf = gdf.to_crs(epsg=target_epsg)
            gdf.to_file(out_path, driver="GPKG", engine="pyogrio")

        except Exception as exc:  # noqa: BLE001
            typer.echo(f"ERROR {path.name}: {exc}", err=True)
            failed.append(path.name)

    if failed:
        typer.echo(f"\n{len(failed)} file(s) failed: {', '.join(failed)}", err=True)
        raise typer.Exit(code=1)

    raise typer.Exit(code=0)
```

### Step 5 — Wire in Layered Configuration

Hard-coding `--epsg 4326` in every invocation is fragile. Apply the config cascade pattern documented in [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/): defaults in code → YAML file → environment variable → CLI flag. The environment-variable layer is covered in [Environment Variable Sync](/cli-architecture-design-patterns/environment-variable-sync/).

```python
# geo_cli/config.py
from __future__ import annotations

import os
from pathlib import Path

import yaml

_CONFIG_FILE = Path.home() / ".config" / "geocli" / "config.yaml"

_DEFAULTS: dict[str, int | str | bool] = {
    "default_epsg": 4326,
    "workers": 4,
    "overwrite": False,
}

def load_config() -> dict[str, int | str | bool]:
    cfg = dict(_DEFAULTS)
    if _CONFIG_FILE.exists():
        with _CONFIG_FILE.open() as fh:
            file_cfg: dict = yaml.safe_load(fh) or {}
        cfg.update(file_cfg)
    # Environment variables override the YAML file
    if epsg := os.environ.get("GEOCLI_DEFAULT_EPSG"):
        cfg["default_epsg"] = int(epsg)
    if workers := os.environ.get("GEOCLI_WORKERS"):
        cfg["workers"] = int(workers)
    return cfg
```

Then in the command definition replace the hardcoded default:

```python
from geo_cli.config import load_config

_cfg = load_config()

@vector_app.command("reproject")
def reproject_vectors(
    input_dir: Annotated[Path, typer.Argument(...)],
    target_epsg: Annotated[int, typer.Option(
        "--epsg",
        callback=validate_epsg,
        envvar="GEOCLI_DEFAULT_EPSG",  # Typer also reads this automatically
    )] = _cfg["default_epsg"],  # type: ignore[assignment]
    ...
) -> None:
    ...
```

For YAML-based configuration management patterns including schema validation with `pydantic`, see [Managing YAML configs for geospatial CLI workflows](/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/).

## Error Handling and Gotchas

**CRS mismatch in mixed-projection directories.** When `input_dir` contains files in different CRS (e.g., EPSG:4326 mixed with EPSG:32632), `gdf.to_crs()` succeeds silently for each file individually but the outputs may not overlay correctly if you assumed they were already aligned. Always log the source CRS alongside the target:

```python
import logging

logger = logging.getLogger("geocli.reproject")

# Inside the processing loop:
src_crs = gdf.crs.to_epsg()
logger.info("Reprojecting %s from EPSG:%s to EPSG:%s", path.name, src_crs, target_epsg)
```

**GDAL driver not available.** On minimal Docker images, `rasterio.open()` raises `rasterio.errors.RasterioIOError: not recognized as a supported file format` when the GDAL build lacks the relevant driver. Test driver availability at CLI startup rather than mid-batch:

```python
import rasterio.drivers

def assert_drivers(*names: str) -> None:
    available = rasterio.drivers.raster_driver_extensions()
    missing = [n for n in names if n.lower() not in available]
    if missing:
        raise RuntimeError(f"GDAL drivers not available: {missing}. Rebuild with --enable-driver flags.")
```

**Typer version mismatch with Click.** Typer 0.12 requires Click 8.1. If your project pins `click<8`, installing Typer will either refuse or silently downgrade. Pin both explicitly in your `pyproject.toml` and validate with `pip check` in CI.

**Missing `PROJ_DATA` on packaged binaries.** When distributing with `shiv` or PyInstaller, `pyproj.CRS.from_epsg()` fails with `proj.db: no such file or directory`. Set `PROJ_DATA` to the path of the bundled PROJ database in your entrypoint wrapper.

**Lazy import overhead.** Importing `geopandas` at module scope adds 300–800 ms of startup overhead — detectable when `geocli --help` is noticeably slow. Move all GIS imports inside command function bodies.

## Verification

After installing the CLI, verify the end-to-end pipeline with a minimal round-trip:

```bash
# Create a tiny test GeoPackage
python - <<'EOF'
import geopandas as gpd
from shapely.geometry import Point

gdf = gpd.GeoDataFrame(
    {"name": ["test_point"]},
    geometry=[Point(13.405, 52.52)],  # Berlin, WGS84
    crs="EPSG:4326"
)
gdf.to_file("/tmp/test_input.gpkg", driver="GPKG")
EOF

# Run the reproject command
geocli vector reproject /tmp --epsg 32633
echo "Exit code: $?"

# Verify output CRS
python - <<'EOF'
import geopandas as gpd
gdf = gpd.read_file("/tmp/test_input_epsg32633.gpkg")
assert gdf.crs.to_epsg() == 32633, f"Expected EPSG:32633, got {gdf.crs}"
print("CRS verified:", gdf.crs)
EOF
```

Expected: exit code `0` and `CRS verified: EPSG:32633`. A non-zero exit code combined with the `rich.progress` bar stopping mid-file indicates a corrupted geometry — run `geopandas.read_file(path).is_valid.all()` on the failing input.

## Performance Notes

**Batch throughput.** For directories exceeding 500 files, the single-process loop becomes the bottleneck. Switch to `concurrent.futures.ProcessPoolExecutor` with worker count capped at `min(os.cpu_count(), 8)` to avoid GDAL's internal thread-pool contention. Each worker must instantiate its own `geopandas` context — shared objects are not fork-safe.

**Memory footprint.** `gpd.read_file()` loads the entire layer into RAM. For files larger than ~500 MB, read in chunks with `pyogrio.read_dataframe(path, max_features=50_000, skip_features=offset)` and process each chunk independently.

**I/O bottleneck on network storage.** When `input_dir` is an NFS mount or S3-backed filesystem (via `s3fs`), GPKG reads are limited by round-trip latency. Pre-stage files to a local temporary directory and process from there. The [Async I/O for raster processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) pattern applies directly to this scenario.

## FAQ

<details class="faq-item">
<summary>Can I mix Click and Typer commands in the same project?</summary>

Yes. Typer wraps Click internally, so `typer.main.get_command(app)` returns a `click.Group`. You can attach legacy Click commands to that group directly: `typer_group.add_command(old_click_cmd)`. This enables incremental migration — rewrite commands one at a time without breaking the existing CLI surface.

</details>

<details class="faq-item">
<summary>How do I validate a bounding box argument in Typer?</summary>

Define a callback that splits the string on commas, coerces each part to `float`, and checks that `minx < maxx` and `miny < maxy`. Pass it to `typer.Option(callback=validate_bbox)`. The `validate_bbox` function in Step 3 above is a complete implementation — raise `typer.BadParameter` with the reason string and Typer formats the error automatically.

</details>

<details class="faq-item">
<summary>Why does importing geopandas slow my CLI startup?</summary>

`geopandas` loads `pyogrio` (or `fiona`), GDAL, and PROJ on import — a chain that costs 300–800 ms on warm disk, more on cold starts inside containers. Move `import geopandas as gpd` inside the command function body so that `geocli --help` remains instant even when the full GIS stack is not installed.

</details>

<details class="faq-item">
<summary>Which framework is easier to test with pytest?</summary>

Typer ships `typer.testing.CliRunner` (a thin wrapper around Click's test runner). Invoke commands without spawning a subprocess: `result = runner.invoke(app, ["vector", "reproject", str(tmp_gpkg_dir)])`. Assert `result.exit_code == 0` and inspect the output path's CRS. Click's `CliRunner` works identically if you expose the Click group via `typer.main.get_command(app)`.

</details>

<details class="faq-item">
<summary>How do I add shell auto-completion for EPSG codes?</summary>

For Typer, implement a completion callback that queries `pyproj.get_codes("EPSG", pyproj.enums.PJType.PROJECTED_CRS)` and returns matching strings. Wire it to `typer.Option(autocompletion=epsg_completer)`. Run `geocli --install-completion` to register the generated completion script. The [Adding auto-completion to Python spatial CLI tools](/cli-architecture-design-patterns/argument-parsing-with-typer/adding-auto-completion-to-python-spatial-cli-tools/) page provides a full implementation including fuzzy EPSG name matching.

</details>

---

## Related

- [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) — type-driven parameter definitions, subcommand routing, and shared context injection for geospatial CLIs
- [Handling missing dependencies gracefully in Click apps](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/handling-missing-dependencies-gracefully-in-click-apps/) — structured diagnostics for GDAL `OSError` and `ImportError` at startup
- [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) — layered YAML config with environment-variable overrides for spatial defaults
- [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) — parent guide covering the full design space of production Python GIS tooling
