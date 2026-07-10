---
title: "CLI Subcommand Organization for GIS Toolchains"
description: "Structure Python GIS CLI tools with modular subcommand hierarchies, lazy imports, and type-driven signatures so your toolchain stays fast and testable as it scales."
slug: "cli-subcommand-organization"
type: "topic"
breadcrumb: "CLI Subcommand Organization"
datePublished: "2024-11-01"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "CLI Subcommand Organization for GIS Toolchains",
      "description": "Structure Python GIS CLI tools with modular subcommand hierarchies, lazy imports, and type-driven signatures so your toolchain stays fast and testable as it scales.",
      "datePublished": "2024-11-01",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 3, "name": "CLI Subcommand Organization", "item": "https://batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Organize CLI Subcommands for a Python GIS Toolchain",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Define namespace hierarchy", "text": "Map GIS operations into domain-action groups before writing code."},
        {"@type": "HowToStep", "position": 2, "name": "Establish modular directory structure", "text": "Isolate each subcommand group into its own Python module."},
        {"@type": "HowToStep", "position": 3, "name": "Implement lazy registration", "text": "Defer heavy GIS imports until the specific subcommand is invoked."},
        {"@type": "HowToStep", "position": 4, "name": "Attach type-driven signatures", "text": "Use typing.Annotated for arguments, options, and file paths."},
        {"@type": "HowToStep", "position": 5, "name": "Wire entry points", "text": "Define console scripts in pyproject.toml and validate with CliRunner."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How many subcommand levels should a GIS CLI have?",
          "acceptedAnswer": {"@type": "Answer", "text": "Two levels (group + command) covers most GIS toolchains. A third level is justified when you have truly distinct domains, such as separating raster processing from vector processing within an ingest group. Beyond three levels, tab completion becomes harder to discover and --help output grows unwieldy."}
        },
        {
          "@type": "Question",
          "name": "Why does geo --help take 2 seconds on my machine?",
          "acceptedAnswer": {"@type": "Answer", "text": "GDAL and rasterio trigger C extension initialisation at import time. If your subcommand modules import rasterio or pyproj at module level, every --help call pays that cost. Use lazy registration — defer those imports into the command callback itself."}
        },
        {
          "@type": "Question",
          "name": "Can I mix Click and Typer subcommands in the same app?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes. Typer exposes a .as_click_group() method. You can attach a raw Click group as a subcommand of a Typer app, or vice versa. This is useful when migrating a legacy Click-based command incrementally."}
        },
        {
          "@type": "Question",
          "name": "How do I share a database or GDAL environment handle across subcommands?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use a Typer callback on the root app to initialise shared resources and store them on a context object (ctx.ensure_object(dict)). Each subcommand retrieves the handle via ctx.obj. Avoid module-level singletons — they survive test isolation boundaries and cause subtle state leakage."}
        },
        {
          "@type": "Question",
          "name": "What exit code should a CRS validation failure return?",
          "acceptedAnswer": {"@type": "Answer", "text": "Reserve 0 for success, 1 for user input errors (wrong flag, missing file), 2 for framework/CLI errors, and codes 3+ for domain-specific failures. A CRS mismatch caught before processing should exit 1 (bad input). A CRS transformation that fails mid-flight due to a missing PROJ datum grid should exit 3 so orchestrators can distinguish recoverable input mistakes from environment failures."}
        }
      ]
    }
  ]
}
</script>

Splitting a Python GIS CLI into a clean subcommand hierarchy is the single most effective way to keep startup time under 200 ms and test surface area manageable — even when the underlying stack pulls in GDAL, rasterio, and pyproj. This page is part of the [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) guide.

## Prerequisites

- **Python 3.10+** — `typing.Annotated` and `match` statements; `pathlib.Path` throughout.
- **`typer>=0.12`** or **`click>=8.1`** — examples below use Typer; the structural patterns apply to either.
- **GIS stack** — `rasterio>=1.3`, `pyproj>=3.6`, `shapely>=2.0`, `pyogrio>=0.7` for realistic command signatures.
- **`pytest>=8`** with `typer.testing.CliRunner` for integration tests.
- Background reading: [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) covers type-driven option declarations; [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) covers framework trade-offs if you have not yet committed to one.

## Problem framing

A flat `cli.py` that registers thirty commands at module level creates two compounding problems for GIS tooling. First, every `--help` invocation imports `rasterio`, `pyproj`, and GDAL's Python bindings unconditionally — adding 600–900 ms of startup latency on typical developer hardware. Second, the entire surface area must be tested as one monolith: a bug in the mosaic command can silently shadow the reproject command because they share module-level state. Teams hit both problems simultaneously around the 15-command mark and discover there is no easy way to decompose the application after the fact.

The fix is hierarchical: group commands by domain, isolate modules, and register subcommands lazily. Applied to a typical GIS toolchain this yields `geo ingest`, `geo transform`, and `geo validate` as top-level groups, each backed by a module that only loads its heavy dependencies when that group is actually invoked.

## Subcommand architecture diagram

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hierarchical subcommand structure for a Python GIS CLI" style="width:100%;max-width:720px;font-family:inherit;">
  <title>GIS CLI Subcommand Hierarchy</title>
  <desc>Tree diagram showing the geo root command branching into ingest, transform, and validate subcommand groups, each containing domain-specific leaf commands.</desc>
  <!-- root node -->
  <rect x="300" y="12" width="120" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="360" y="34" text-anchor="middle" font-size="13" fill="currentColor" font-weight="600">geo</text>
  <!-- connector lines from root -->
  <line x1="360" y1="48" x2="360" y2="68" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3"/>
  <line x1="360" y1="68" x2="110" y2="68" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3"/>
  <line x1="360" y1="68" x2="610" y2="68" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3"/>
  <line x1="110" y1="68" x2="110" y2="88" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3"/>
  <line x1="360" y1="68" x2="360" y2="88" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3"/>
  <line x1="610" y1="68" x2="610" y2="88" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3"/>
  <!-- group nodes -->
  <rect x="50" y="88" width="120" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="110" y="110" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">ingest</text>
  <rect x="300" y="88" width="120" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="360" y="110" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">transform</text>
  <rect x="550" y="88" width="120" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="610" y="110" text-anchor="middle" font-size="12" fill="currentColor" font-weight="600">validate</text>
  <!-- ingest leaf connectors -->
  <line x1="110" y1="124" x2="110" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="110" y1="148" x2="60" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="110" y1="148" x2="160" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="60" y1="148" x2="60" y2="162" stroke="currentColor" stroke-width="1"/>
  <line x1="160" y1="148" x2="160" y2="162" stroke="currentColor" stroke-width="1"/>
  <rect x="16" y="162" width="88" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="60" y="181" text-anchor="middle" font-size="11" fill="currentColor">raster</text>
  <rect x="116" y="162" width="88" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="160" y="181" text-anchor="middle" font-size="11" fill="currentColor">vector</text>
  <!-- transform leaf connectors -->
  <line x1="360" y1="124" x2="360" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="360" y1="148" x2="310" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="360" y1="148" x2="410" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="310" y1="148" x2="310" y2="162" stroke="currentColor" stroke-width="1"/>
  <line x1="410" y1="148" x2="410" y2="162" stroke="currentColor" stroke-width="1"/>
  <rect x="266" y="162" width="88" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="310" y="181" text-anchor="middle" font-size="11" fill="currentColor">reproject</text>
  <rect x="366" y="162" width="88" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="410" y="181" text-anchor="middle" font-size="11" fill="currentColor">mosaic</text>
  <!-- validate leaf connectors -->
  <line x1="610" y1="124" x2="610" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="610" y1="148" x2="560" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="610" y1="148" x2="660" y2="148" stroke="currentColor" stroke-width="1"/>
  <line x1="560" y1="148" x2="560" y2="162" stroke="currentColor" stroke-width="1"/>
  <line x1="660" y1="148" x2="660" y2="162" stroke="currentColor" stroke-width="1"/>
  <rect x="516" y="162" width="88" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="560" y="181" text-anchor="middle" font-size="11" fill="currentColor">topology</text>
  <rect x="616" y="162" width="88" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="660" y="181" text-anchor="middle" font-size="11" fill="currentColor">crs</text>
  <!-- legend -->
  <rect x="16" y="220" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="36" y="232" font-size="11" fill="currentColor">group (sub-app)</text>
  <rect x="16" y="244" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>
  <text x="36" y="256" font-size="11" fill="currentColor">leaf command (callback)</text>
  <!-- annotation -->
  <text x="360" y="300" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">Each group lives in its own module; heavy imports (rasterio, pyproj) are deferred until invocation.</text>
</svg>

## Step-by-step implementation

### Step 1 — Define the namespace hierarchy

Before writing code, sketch a `domain-verb` taxonomy for your operations. Common groups for a GIS toolchain:

| Group | Responsibility | Heavy dependency |
|---|---|---|
| `ingest` | Load raster or vector data from disk or cloud | `rasterio`, `pyogrio` |
| `transform` | Reproject, resample, mosaic, buffer | `pyproj`, `rasterio` |
| `validate` | Topology checks, CRS consistency, schema conformance | `shapely`, `pyproj` |
| `batch` | Orchestrate multi-file pipelines | all of the above |

Avoid verb-noun collisions: `geo convert raster` and `geo convert vector` look tidy until users run `geo convert --help` and see an opaque list. Use `geo transform reproject` and `geo ingest vector` instead — the group name carries the domain context.

### Step 2 — Establish a modular directory layout

Isolate each group into its own package. A monolithic `cli.py` becomes unmanageable beyond ~300 lines and prevents independent unit testing of each domain:

```text
src/geo_cli/
├── __init__.py          # re-exports main app
├── main.py              # root Typer app; aggregates sub-apps
├── ingest/
│   ├── __init__.py      # instantiates and exports ingest sub-app
│   ├── raster.py        # rasterio-based ingestion
│   └── vector.py        # pyogrio-based vector ingestion
├── transform/
│   ├── __init__.py      # instantiates and exports transform sub-app
│   ├── reproject.py     # pyproj / rasterio CRS transforms
│   └── mosaic.py        # rasterio merge + windowed writes
└── validate/
    ├── __init__.py      # instantiates and exports validate sub-app
    ├── topology.py      # shapely geometry checks
    └── crs.py           # pyproj CRS consistency checks
```

Each `__init__.py` creates a `typer.Typer()` instance and registers that module's commands. No cross-module imports at the package boundary — every group is self-contained.

### Step 3 — Implement lazy subcommand registration

GDAL's Python bindings trigger C extension initialisation at import time. On a developer laptop with a warm cache, `import rasterio` takes roughly 300–500 ms; `import pyproj` adds another 100–200 ms. Both together can push a bare `geo --help` past a full second — enough to break the perceived snappiness that makes CLI tools pleasant to use.

The fix is lazy registration: attach sub-apps to the root without importing their modules at startup. Typer's `app.add_typer()` accepts an already-created `typer.Typer()` instance; you can defer that creation until the group is first called:

```python
# src/geo_cli/main.py
import typer

app = typer.Typer(
    name="geo",
    help="Production GIS CLI toolchain",
    no_args_is_help=True,
)

def _register_subcommands() -> None:
    # Imports happen here, not at module level.
    # Root-level `geo --help` never touches rasterio or pyproj.
    from geo_cli.ingest import app as ingest_app        # noqa: PLC0415
    from geo_cli.transform import app as transform_app  # noqa: PLC0415
    from geo_cli.validate import app as validate_app    # noqa: PLC0415

    app.add_typer(ingest_app,    name="ingest",    help="Load rasters and vectors from disk or cloud")
    app.add_typer(transform_app, name="transform", help="Reproject, resample, and mosaic spatial data")
    app.add_typer(validate_app,  name="validate",  help="Check CRS consistency and topology")

_register_subcommands()
```

Each sub-app's `__init__.py` looks like this:

```python
# src/geo_cli/ingest/__init__.py
import typer

app = typer.Typer(help="Data ingestion commands")

# Register leaf commands — rasterio import is deferred inside each callback
from geo_cli.ingest import raster, vector  # noqa: E402, F401
```

And the leaf module defers the heavy import into the callback body:

```python
# src/geo_cli/ingest/raster.py
from pathlib import Path
from typing import Annotated
import typer

from geo_cli.ingest import app

@app.command("raster")
def ingest_raster(
    source: Annotated[Path, typer.Argument(help="Source GeoTIFF or VRT path")],
    output_dir: Annotated[Path, typer.Option("--out", help="Destination directory")],
    epsg: Annotated[int, typer.Option("--epsg", help="Force output CRS, e.g. 4326")] = 0,
    overwrite: Annotated[bool, typer.Option("--overwrite", "-f")] = False,
) -> None:
    """Ingest a raster file, optionally reprojecting to a target EPSG."""
    import rasterio                            # deferred: only loads when command runs
    from rasterio.crs import CRS

    if not source.exists():
        raise typer.BadParameter(f"Source not found: {source}", param_hint="SOURCE")

    output_dir.mkdir(parents=True, exist_ok=True)
    dest = output_dir / source.name

    if dest.exists() and not overwrite:
        typer.echo(f"Skipping {dest} — already exists. Pass --overwrite to replace.", err=True)
        raise typer.Exit(code=1)

    with rasterio.open(source) as src:
        profile = src.profile.copy()
        if epsg:
            profile.update(crs=CRS.from_epsg(epsg))
        data = src.read()

    with rasterio.open(dest, "w", **profile) as dst:
        dst.write(data)

    typer.echo(f"Ingested {source.name} -> {dest}")
```

Because `import rasterio` sits inside the callback body, `geo --help`, `geo ingest --help`, and every other group's commands remain fast until someone actually runs `geo ingest raster`.

### Step 4 — Attach type-driven signatures using `typing.Annotated`

[Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) establishes the type-driven pattern in detail. Applied here to a reprojection command:

```python
# src/geo_cli/transform/reproject.py
from pathlib import Path
from typing import Annotated
import typer

from geo_cli.transform import app

@app.command("reproject")
def reproject(
    input_path: Annotated[Path, typer.Argument(
        help="Source GeoTIFF, shapefile, or GeoJSON",
        exists=True, file_okay=True, readable=True,
    )],
    output_path: Annotated[Path, typer.Argument(help="Destination path")],
    target_epsg: Annotated[int, typer.Option(
        "--epsg", "-e",
        help="Target EPSG code, e.g. 32632 for UTM zone 32N",
        min=1, max=999999,
    )],
    resampling: Annotated[str, typer.Option(
        "--resampling",
        help="Rasterio resampling algorithm (nearest, bilinear, cubic)",
    )] = "bilinear",
    overwrite: Annotated[bool, typer.Option("--overwrite", "-f")] = False,
) -> None:
    """Reproject a raster to the given EPSG coordinate reference system."""
    import rasterio
    from rasterio.crs import CRS
    from rasterio.warp import calculate_default_transform, reproject as rio_reproject, Resampling

    if output_path.exists() and not overwrite:
        typer.echo(f"Output exists: {output_path}. Use --overwrite.", err=True)
        raise typer.Exit(code=1)

    dst_crs = CRS.from_epsg(target_epsg)
    resamp = Resampling[resampling]

    with rasterio.open(input_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(crs=dst_crs, transform=transform, width=width, height=height)

        with rasterio.open(output_path, "w", **profile) as dst:
            for band_idx in range(1, src.count + 1):
                rio_reproject(
                    source=rasterio.band(src, band_idx),
                    destination=rasterio.band(dst, band_idx),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=dst_crs,
                    resampling=resamp,
                )

    typer.echo(f"Reprojected {input_path.name} -> EPSG:{target_epsg} at {output_path}")
```

The `exists=True`, `file_okay=True`, and `readable=True` arguments to `typer.Argument` cause Typer to validate the path before the callback runs, so the business logic never encounters a missing file.

### Step 5 — Wire entry points in `pyproject.toml`

```toml
[project]
name = "geo-cli"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "typer[all]>=0.12",
    "rasterio>=1.3",
    "pyproj>=3.6",
    "shapely>=2.0",
    "pyogrio>=0.7",
]

[project.scripts]
geo = "geo_cli.main:app"

[dependency-groups]
dev = ["pytest>=8", "pytest-tmp-path"]
```

After `pip install -e .` (or `uv pip install -e .`), the `geo` executable is available system-wide. Typer handles argument routing, subcommand dispatch, and exit code propagation automatically.

## Configuration integration

The layered config pattern — defaults in code, overrides from a YAML file, then environment variables, then explicit flags — plugs naturally into this subcommand structure. Each group's `__init__.py` can read a shared `Settings` object that [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) describes in full:

```python
# src/geo_cli/config.py
from __future__ import annotations
import os
from pathlib import Path
import yaml
from pydantic import BaseModel

class GeoSettings(BaseModel):
    default_epsg: int = 4326
    temp_dir: Path = Path("/tmp/geo_scratch")
    gdal_cachemax_mb: int = 512

    @classmethod
    def load(cls) -> "GeoSettings":
        cfg_path = Path(os.getenv("GEO_CONFIG", "geo.yaml"))
        base: dict = {}
        if cfg_path.exists():
            with cfg_path.open() as fh:
                base = yaml.safe_load(fh) or {}
        # env vars shadow file values
        if epsg := os.getenv("GEO_DEFAULT_EPSG"):
            base["default_epsg"] = int(epsg)
        return cls(**base)

settings = GeoSettings.load()
```

Any subcommand that needs a default EPSG imports `settings.default_epsg`. When `GEO_DEFAULT_EPSG=32632` is set in the shell — for instance in a CI environment that always works in UTM zone 32N — it overrides the YAML default without touching command flags. Explicit `--epsg` on the command line takes precedence over both.

[Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/) covers the precedence chain and `GDAL_*` / `PROJ_*` variable handling in detail.

## Error handling and gotchas

**CRS mismatch at the PROJ datum grid boundary.** `pyproj.CRS.from_epsg(target_epsg)` succeeds even when the required PROJ datum-shift grid is absent from the local PROJ data directory. The actual transformation error surfaces during `rasterio.warp.reproject()`. Catch `rasterio.errors.CRSError` explicitly and exit with code `3` (domain failure) rather than letting the traceback propagate:

```python
from rasterio.errors import CRSError

try:
    rio_reproject(...)
except CRSError as exc:
    typer.echo(f"CRS error — check PROJ network access or datum grids: {exc}", err=True)
    raise typer.Exit(code=3)
```

**GDAL driver not available.** A `rasterio.errors.DriverRegistrationError` means the requested format driver is not compiled into the GDAL build. This is a configuration problem, not a user input error. Exit with code `2`:

```python
from rasterio.errors import DriverRegistrationError

except DriverRegistrationError as exc:
    typer.echo(f"GDAL driver unavailable: {exc}. Check your GDAL build or conda environment.", err=True)
    raise typer.Exit(code=2)
```

**Module-level GDAL state leakage in tests.** Because Python caches imported modules, a test that calls `geo transform reproject` will leave `rasterio` imported for the rest of the test session. If another test expects a clean GDAL environment, it will silently inherit GDAL's thread lock state. Always mock `rasterio.open` in unit tests; reserve full integration tests for a CI job that resets the Python process.

**`pathlib.Path` not serialisable across the callback boundary.** If you store a `Path` value in `ctx.obj` and then try to serialise it to JSON for logging, you need `str(path)`. Add a small helper to your config module that normalises paths to strings before persisting them.

**Exit code leakage through Typer's exception handler.** By default, any unhandled exception becomes exit code `1`. If you have domain-specific codes (`3` for CRS failure, `4` for topology violation), you must catch those exceptions explicitly and call `raise typer.Exit(code=N)` — do not rely on the default handler.

## Verification

After `pip install -e .`, verify the structure and startup latency in one step:

```bash
# confirms subcommand routing is wired correctly
geo --help
geo ingest --help
geo transform reproject --help

# measures cold-start latency (should be < 200 ms with lazy imports)
time geo --help
```

For automated verification in CI, use `typer.testing.CliRunner`:

```python
# tests/test_cli_structure.py
from typer.testing import CliRunner
from geo_cli.main import app

runner = CliRunner()

def test_root_help_lists_groups():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "ingest" in result.output
    assert "transform" in result.output
    assert "validate" in result.output

def test_ingest_raster_rejects_missing_file(tmp_path: Path):
    result = runner.invoke(app, [
        "ingest", "raster",
        "does_not_exist.tif",
        "--out", str(tmp_path),
    ])
    assert result.exit_code != 0

def test_transform_reproject_help():
    result = runner.invoke(app, ["transform", "reproject", "--help"])
    assert result.exit_code == 0
    assert "--epsg" in result.output
```

Add a startup-time smoke test to catch accidental top-level imports that drag in heavy dependencies:

```python
import subprocess, time

def test_help_latency_under_500ms():
    start = time.perf_counter()
    result = subprocess.run(["geo", "--help"], capture_output=True)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert result.returncode == 0
    assert elapsed_ms < 500, f"geo --help took {elapsed_ms:.0f} ms — check for top-level heavy imports"
```

## Performance notes

**Startup latency** is dominated by C extension initialisation. With lazy imports, `geo --help` stays under 100 ms on a machine with a warm Python cache. Without them, `rasterio` + `pyproj` together add 500–800 ms.

**Memory footprint per subcommand invocation** depends almost entirely on the raster window size you read into memory, not on the CLI framework. Typer itself adds negligible overhead. For batch ingest operations, read rasters using windowed reads rather than loading entire arrays — see the spatial batch processing patterns for how to keep per-file memory consumption flat regardless of file size.

**Parallelism.** The subcommand structure is single-threaded by default. If you need to parallelize `geo ingest raster` over a directory of files, wire a `--workers N` option that dispatches to a `concurrent.futures.ProcessPoolExecutor`. The lazy import pattern helps here: each worker process starts fresh and imports only the modules its command needs, avoiding GDAL thread lock contention.

**Shell completion generation** (`geo --install-completion`) enumerates all registered subcommands at completion time. With lazy registration, Typer must still discover subcommand names to offer completions. Ensure `_register_subcommands()` runs at import time (as shown above) so the names are available without running an actual command.

## FAQ

<details class="faq-item">
<summary>How many subcommand levels should a GIS CLI have?</summary>

Two levels (group + command) covers most GIS toolchains. A third level is justified when you have truly distinct domains — for example separating `geo ingest raster cloud` from `geo ingest raster local`. Beyond three levels, tab completion becomes harder to discover and `--help` output grows unwieldy. If you find yourself adding a fourth level, split the application into multiple named entry points instead.
</details>

<details class="faq-item">
<summary><span>Why does <code>geo --help</code> take two seconds on my machine?</span></summary>

GDAL and rasterio trigger C extension initialisation at import time. If your subcommand modules import `rasterio` or `pyproj` at the top of the file, every `--help` invocation pays that cost. Move those imports inside the command callback body, as shown in Step 3. Run `time geo --help` before and after — the difference is usually 400–700 ms.
</details>

<details class="faq-item">
<summary>Can I mix Click and Typer subcommands in the same app?</summary>

Yes. Typer exposes a `.as_click_group()` method that converts a `typer.Typer` instance into a `click.Group`. You can then attach a raw Click group as a subcommand. This is useful when migrating a legacy Click-based command incrementally: keep the old Click group working while rebuilding individual commands as Typer callbacks. The [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) page covers the interop pattern in detail.
</details>

<details class="faq-item">
<summary>How do I share a GDAL environment handle or database connection across subcommands?</summary>

Use a Typer `@app.callback()` on the root app to initialise shared resources and store them on a `typer.Context` object via `ctx.ensure_object(dict)`. Each subcommand retrieves the handle via `ctx.obj["gdal_env"]`. Avoid module-level singletons — they survive test isolation boundaries and cause subtle state leakage when `CliRunner` invokes multiple commands in the same process.
</details>

<details class="faq-item">
<summary>What exit code should a CRS validation failure return?</summary>

Use `0` for success, `1` for user input errors (wrong flag, missing file), `2` for framework or environment errors (missing GDAL driver), and codes `3+` for domain-specific failures. A CRS mismatch detected before processing starts is a user input error: exit `1`. A CRS transformation that fails mid-flight due to a missing PROJ datum grid is an environment problem: exit `2`. A topology violation found during validation is a domain result: exit `3`. Document these codes explicitly so orchestrators (Airflow, GitHub Actions, cron) can route failures accurately.
</details>

---

## Related

- [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) — parent guide covering the full architecture of production Python GIS command-line tools
- [Structuring a Multi-Command GDAL CLI with Typer Sub-Apps](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/structuring-a-multi-command-gdal-cli-with-typer-sub-apps/) — split raster, vector, and inspect commands into mountable sub-apps that stay independently testable
- [Sharing Global Options Across Geospatial Subcommands](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/sharing-global-options-across-geospatial-subcommands/) — propagate `--crs`, `--workers`, and `--config` to every subcommand through a Typer context object
- [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) — type-driven option and argument declarations that slot directly into the subcommand signatures shown here
- [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) — layered config (YAML + env vars + flags) for geospatial CLI tools, including GDAL cache tuning
- [Rich Console Output & Progress Bars](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/) — adding structured progress feedback to long-running raster and vector commands within this subcommand structure
