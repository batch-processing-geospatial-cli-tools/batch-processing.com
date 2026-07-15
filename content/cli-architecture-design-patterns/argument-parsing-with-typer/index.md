---
title: "Argument Parsing with Typer"
description: "Build type-safe CLI argument parsers for geospatial pipelines using Typer — covering validation, subcommands, batch progress, and production error handling."
slug: "argument-parsing-with-typer"
type: "topic"
breadcrumb: "CLI Architecture > Argument Parsing with Typer"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

Typer turns Python type annotations into a complete argument-parsing layer — inputs are coerced, validated, and documented automatically, with no manual `required=True` flags or `argparse.add_argument` boilerplate. It is one part of the broader [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) guide.

## Prerequisites

- **Python 3.10+** for `str | None` union syntax and `list[Path]` generics without `from __future__ import annotations`.
- **`pip install "typer[all]"`** — the `[all]` extra pulls in Click (the parsing engine), Rich (terminal rendering), and shellingham (shell detection for tab completion). Without it, progress bars, help formatting, and shell completion are unavailable.
- **Geospatial stack**: `geopandas`, `rasterio`, and `pyproj` for the downstream operations the CLI wraps. Install `pyogrio` as the `geopandas` I/O backend (`pip install pyogrio`) — it is substantially faster than fiona for both read and write paths.
- The [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) guide gives the broader context for deciding where argument parsing ends and subcommand routing begins.

## Problem framing

The most common failure mode when scripting spatial pipelines is an argument that passes string validation but silently corrupts the output: a bounding box with `minx > maxx`, a target EPSG code for a deprecated datum, or a resolution value accidentally entered in degrees when the pipeline expects metres. `sys.argv` slicing and plain `argparse` catch none of these. Every kilometre of I/O runs before the bad value surfaces in a traceback — or worse, in the output data.

Typer addresses this by placing type coercion and domain validation at the parser boundary, before a single file is opened.

## Typer argument-parsing flow

The diagram below shows how a CLI invocation moves through Typer's layers — type coercion first, then custom validators, then the command function — so domain errors are caught before any I/O starts.

<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Typer argument parsing flow: raw argv feeds type coercion, then custom validators, then the command function" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Typer argument-parsing flow</title>
  <desc>Raw CLI arguments pass through Typer's type coercion layer (str→Path, str→int), then through custom validator callbacks (EPSG check, bbox ordering, driver match), and finally into the command function body where I/O and computation begin.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- boxes -->
  <rect x="10" y="70" width="130" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <text x="75" y="96" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Raw argv</text>
  <text x="75" y="114" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">sys.argv[1:]</text>
  <rect x="188" y="70" width="150" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <text x="263" y="93" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Type coercion</text>
  <text x="263" y="111" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">str → Path, int, float</text>
  <text x="263" y="124" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">bool flags resolved</text>
  <rect x="386" y="70" width="150" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <text x="461" y="93" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Validators</text>
  <text x="461" y="111" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">EPSG, bbox order,</text>
  <text x="461" y="124" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">driver match</text>
  <rect x="584" y="70" width="126" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <text x="647" y="93" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Command fn</text>
  <text x="647" y="111" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">I/O + computation</text>
  <text x="647" y="124" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">starts here</text>
  <!-- arrows -->
  <line x1="140" y1="100" x2="185" y2="100" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arr)"/>
  <line x1="338" y1="100" x2="383" y2="100" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arr)"/>
  <line x1="536" y1="100" x2="581" y2="100" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arr)"/>
  <!-- error drop arrows -->
  <line x1="263" y1="130" x2="263" y2="165" stroke="currentColor" stroke-width="1" opacity="0.4" stroke-dasharray="4 3" marker-end="url(#arr)"/>
  <text x="263" y="182" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">BadParameter exit 2</text>
  <line x1="461" y1="130" x2="461" y2="165" stroke="currentColor" stroke-width="1" opacity="0.4" stroke-dasharray="4 3" marker-end="url(#arr)"/>
  <text x="461" y="182" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">BadParameter exit 2</text>
</svg>

## Step-by-step implementation

### Step 1 — Initialize the application instance

Every Typer CLI starts with an explicit `typer.Typer()` instance. This sets the root command name, enables Rich help formatting, and prepares the shell-completion layer.

```python
import typer

app = typer.Typer(
    name="geo-pipeline",
    help="Spatial data processing and batch conversion pipeline.",
    rich_markup_mode="rich",   # enables colour + markdown in help text
    add_completion=True,       # registers --install-completion / --show-completion
)
```

`rich_markup_mode="rich"` is only available when `typer[all]` is installed. Drop it to `"none"` if you are building a minimal install without the Rich dependency.

### Step 2 — Declare entry points with type-hint parameters

Typer reads the function signature and maps each parameter to a CLI argument or option. Positional `typer.Argument` values are required; `typer.Option` values carry defaults.

```python
from pathlib import Path
from typing import Optional
import typer

@app.command()
def process_raster(
    input_path: Path = typer.Argument(..., help="Path to source GeoTIFF or Cloud-Optimised GeoTIFF."),
    output_dir: Path = typer.Option(Path("./output"), "--out-dir", "-o", help="Destination directory for processed tiles."),
    resolution: float = typer.Option(10.0, "--res", help="Target spatial resolution in metres."),
    target_epsg: int = typer.Option(32632, "--epsg", help="Output CRS as EPSG code (default: UTM zone 32N)."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable DEBUG-level log output."),
) -> None:
    """Resample a raster to the target resolution and reproject to the specified CRS."""
    if not input_path.exists():
        raise typer.BadParameter(f"Input file not found: {input_path}", param_hint="input_path")
    output_dir.mkdir(parents=True, exist_ok=True)
    # downstream rasterio / pyproj logic follows
```

The `...` sentinel marks `input_path` as required. Typer raises a formatted error and exits with code 2 before the function body runs if the argument is absent.

### Step 3 — Apply domain validators for geospatial inputs

Standard type coercion catches type errors but not domain errors. Bounding boxes, EPSG codes, and driver strings need explicit callbacks.

```python
from pathlib import Path
from typing import Optional
import typer
import pyproj

SUPPORTED_DRIVERS = {".gpkg", ".geojson", ".fgb", ".shp"}

def validate_epsg(ctx: typer.Context, param: typer.CallbackParam, value: int) -> int:
    try:
        pyproj.CRS.from_epsg(value)
    except pyproj.exceptions.CRSError:
        raise typer.BadParameter(f"EPSG:{value} is not a recognised CRS code.")
    return value

def validate_bbox(
    ctx: typer.Context, param: typer.CallbackParam, value: Optional[str]
) -> Optional[tuple[float, float, float, float]]:
    if value is None:
        return None
    try:
        parts = [float(x) for x in value.split(",")]
    except ValueError:
        raise typer.BadParameter("All four bbox values must be numeric floats.")
    if len(parts) != 4:
        raise typer.BadParameter("Bounding box requires exactly 4 comma-separated floats: minx,miny,maxx,maxy.")
    minx, miny, maxx, maxy = parts
    if minx >= maxx:
        raise typer.BadParameter(f"minx ({minx}) must be less than maxx ({maxx}).")
    if miny >= maxy:
        raise typer.BadParameter(f"miny ({miny}) must be less than maxy ({maxy}).")
    return (minx, miny, maxx, maxy)

@app.command()
def clip_vector(
    source: Path = typer.Argument(..., help="Source vector file (.gpkg, .geojson, .fgb, .shp)."),
    target_epsg: int = typer.Option(4326, "--epsg", callback=validate_epsg, help="Output CRS as EPSG code."),
    bbox: Optional[str] = typer.Option(
        None, "--bbox", callback=validate_bbox,
        help="Clipping extent as minx,miny,maxx,maxy in the source CRS."
    ),
) -> None:
    """Clip a vector dataset to a bounding box and reproject to the target CRS."""
    if source.suffix.lower() not in SUPPORTED_DRIVERS:
        raise typer.BadParameter(
            f"Driver not supported: {source.suffix}. Expected one of {sorted(SUPPORTED_DRIVERS)}.",
            param_hint="source",
        )
    # pyogrio + geopandas processing follows
```

Failing early with `typer.BadParameter` exits with code 2, which distinguishes user input errors from runtime failures (code 1) in orchestration logs.

### Step 4 — Structure subcommands for spatial operations

As a toolset grows, splitting operations into named subcommands — each with its own typed signature — is significantly cleaner than a single function with dozens of flags. Typer registers each `@app.command()` decorated function as a subcommand automatically. For the full pattern on grouping related subcommands into nested `typer.Typer()` instances, see [CLI Subcommand Organization](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/).

```python
from pathlib import Path
import typer
import geopandas as gpd

@app.command()
def reproject(
    input_file: Path = typer.Argument(..., help="Source vector or raster file."),
    target_epsg: int = typer.Option(4326, "--epsg", callback=validate_epsg, help="Target CRS as EPSG code."),
    output_file: Optional[Path] = typer.Option(None, "--out", help="Output path; defaults to <input>_epsg<code>.gpkg."),
) -> None:
    """Reproject a vector dataset to a new coordinate reference system."""
    if output_file is None:
        output_file = input_file.with_stem(f"{input_file.stem}_epsg{target_epsg}").with_suffix(".gpkg")
    gdf: gpd.GeoDataFrame = gpd.read_file(input_file, engine="pyogrio")
    gdf.to_crs(epsg=target_epsg, inplace=True)
    gdf.to_file(output_file, engine="pyogrio")
    typer.echo(f"Reprojected {len(gdf)} features → {output_file}")

@app.command()
def merge(
    inputs: list[Path] = typer.Argument(..., help="Two or more vector files to merge."),
    output: Path = typer.Option(Path("merged.gpkg"), "--out", help="Output GeoPackage path."),
    target_epsg: int = typer.Option(4326, "--epsg", callback=validate_epsg, help="Normalise all inputs to this CRS before merging."),
) -> None:
    """Merge multiple vector datasets into a single GeoPackage, normalising CRS."""
    frames = [
        gpd.read_file(p, engine="pyogrio").to_crs(epsg=target_epsg)
        for p in inputs
    ]
    merged: gpd.GeoDataFrame = gpd.pd.concat(frames, ignore_index=True)
    merged.to_file(output, driver="GPKG", engine="pyogrio")
    typer.echo(f"Merged {len(inputs)} files → {output} ({len(merged)} features total)")
```

### Step 5 — Integrate batch iteration with Rich progress tracking

Batch runs over file directories or glob patterns need both robust iteration and live user feedback. Pair `typer.Argument` with a glob pattern string and `rich.progress.track` for non-blocking progress display. For [Rich console output and progress bars](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/) beyond the basics — live tables, status spinners, and column customisation — see the dedicated coverage.

```python
import glob
import sys
import typer
from pathlib import Path
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn

@app.command()
def batch_validate(
    pattern: str = typer.Argument("*.gpkg", help="Glob pattern for target files."),
    strict: bool = typer.Option(False, "--strict", help="Exit 1 on the first validation failure."),
) -> None:
    """Validate geometry, CRS presence, and schema across a batch of vector files."""
    files = sorted(glob.glob(pattern))
    if not files:
        typer.echo(f"No files matched pattern: {pattern!r}", err=True)
        raise typer.Exit(code=1)

    failures: list[str] = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeElapsedColumn(),
        disable=not sys.stdout.isatty(),   # suppress live rendering in CI
    ) as progress:
        task = progress.add_task("Validating…", total=len(files))
        for fp in files:
            import geopandas as gpd
            try:
                gdf = gpd.read_file(fp, engine="pyogrio", rows=1)
                if gdf.crs is None:
                    failures.append(f"{fp}: no CRS defined")
            except Exception as exc:
                failures.append(f"{fp}: {exc}")
                if strict:
                    raise typer.Exit(code=1)
            progress.advance(task)

    if failures:
        for msg in failures:
            typer.echo(msg, err=True)
        raise typer.Exit(code=1)
    typer.echo(f"All {len(files)} files passed validation.")
```

The `disable=not sys.stdout.isatty()` guard prevents Rich's live-rendering escape codes from corrupting CI log streams.

## Configuration integration

CLI flags should be the final override layer, not the sole source of truth. Wire Typer defaults into the site's layered config pattern — YAML file first, environment variable second, CLI flag last — so that automated runs pick up project-level settings without repeating flags on every invocation. [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) covers the full YAML/TOML loading pattern; the Typer integration point is the `default_factory` parameter:

```python
import os
import yaml
from pathlib import Path
from functools import lru_cache
from typing import Optional
import typer

CONFIG_PATH = Path(os.environ.get("GEO_PIPELINE_CONFIG", "geo_pipeline.yaml"))

@lru_cache(maxsize=1)
def _load_config() -> dict:
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open() as fh:
            return yaml.safe_load(fh) or {}
    return {}

def _default_epsg() -> int:
    # precedence: env var > YAML config > hard-coded default
    env_val = os.environ.get("GEO_PIPELINE_TARGET_EPSG")
    if env_val is not None:
        return int(env_val)
    return _load_config().get("target_epsg", 4326)

@app.command()
def export(
    source: Path = typer.Argument(...),
    target_epsg: int = typer.Option(default_factory=_default_epsg, "--epsg", callback=validate_epsg),
) -> None:
    """Export source dataset reprojected to the configured CRS."""
    ...
```

Storing project-level defaults in `geo_pipeline.yaml` and surfacing the config path via `GEO_PIPELINE_CONFIG` mirrors the env-var sync pattern described in [Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/).

## Error handling & gotchas

**CRS mismatch on merge.** `geopandas.concat` does not reproject automatically. Ensure all frames share the same CRS before concatenating, or pass `to_crs(epsg=target_epsg)` on each frame as shown in the `merge` command above.

**GDAL driver not found.** On minimal GDAL builds (e.g., inside Docker images without `gdal-bin`), FlatGeobuf (`.fgb`) or GeoPackage (`.gpkg`) drivers may be absent. Check `pyogrio.list_drivers()` at startup and raise a clear `typer.BadParameter` before attempting I/O.

**Mutable default arguments.** Never use `list` or `dict` as a default value in a Typer function signature — Python shares the same object across calls. Use `None` and initialise inside the function body:

```python
# wrong — list is shared across invocations
def export(layers: list[str] = []) -> None: ...

# correct
def export(layers: Optional[list[str]] = None) -> None:
    if layers is None:
        layers = []
```

**`list[Path]` on Python 3.9.** The built-in `list[Path]` generic syntax in function signatures requires Python 3.10+. On 3.9, use `from __future__ import annotations` at the top of the file or switch to `List[Path]` from `typing`.

**Non-TTY progress bars.** Rich's auto-detection of TTY state differs between versions. Always pass `disable=not sys.stdout.isatty()` explicitly rather than relying on Rich's default behaviour.

**BadParameter vs Abort.** Use `typer.BadParameter` for invalid user inputs (exits 2). Use `raise typer.Abort()` when the user must confirm a destructive action. Use `raise typer.Exit(code=1)` for runtime failures — this distinction lets orchestration tools (Airflow, GitHub Actions, systemd) route on exit code.

## Verification

After wiring up validators, confirm the parser is working correctly with these checks:

```bash
# 1. Help output renders correctly with Rich formatting
python -m geo_pipeline --help
python -m geo_pipeline reproject --help

# 2. Type coercion error — non-numeric resolution
python -m geo_pipeline process-raster input.tif --res not_a_number
# Expected: "Error: Invalid value for '--res': 'not_a_number' is not a valid float."
# Expected exit code: 2

# 3. Domain validator — invalid EPSG
python -m geo_pipeline reproject data/roads.gpkg --epsg 9999999
# Expected: "Error: Invalid value for '--epsg': EPSG:9999999 is not a recognised CRS code."
# Expected exit code: 2

# 4. Bbox ordering check
python -m geo_pipeline clip-vector data/parcels.gpkg --bbox "10,20,5,30"
# Expected: "Error: ... minx (10.0) must be less than maxx (5.0)"
# Expected exit code: 2

# 5. Programmatic test with CliRunner
python -m pytest tests/test_cli.py -v
```

```python
# tests/test_cli.py
from typer.testing import CliRunner
from geo_pipeline.cli import app
from pathlib import Path

runner = CliRunner()

def test_reproject_invalid_epsg():
    result = runner.invoke(app, ["reproject", "data/roads.gpkg", "--epsg", "9999999"])
    assert result.exit_code == 2
    assert "not a recognised CRS" in result.output

def test_batch_validate_no_match():
    result = runner.invoke(app, ["batch-validate", "*.nonexistent"])
    assert result.exit_code == 1
```

## Performance notes

Typer's parsing overhead is negligible — microseconds per invocation. The performance-critical choices are downstream:

- **`pyogrio` over `fiona`**: pyogrio's vectorised GDAL bindings are 3–10× faster for large GeoPackage and FlatGeobuf reads. Pass `engine="pyogrio"` to `geopandas.read_file` consistently.
- **Parallelism for batch operations**: GDAL is not thread-safe. Use `concurrent.futures.ProcessPoolExecutor` for CPU-bound raster operations (reprojection, resampling). Each worker process gets its own GDAL state. See [Multiprocessing Geospatial Tasks](https://www.batch-processing.com/spatial-batch-processing-async-workflows/multiprocessing-geospatial-tasks/) for pool sizing and shared-memory patterns.
- **Memory on large vector reads**: Reading an entire GeoDataFrame into memory before clipping or reprojecting is the most common source of OOM errors. Stream the file in chunks using pyogrio's `read_info` + row-range slicing, or use [Chunked Vector Data Reading](https://www.batch-processing.com/spatial-batch-processing-async-workflows/chunked-vector-data-reading/) to process features incrementally.
- **Shell completion cost**: `add_completion=True` adds two hidden subcommands (`--install-completion`, `--show-completion`). They impose no runtime cost on normal invocations.

## FAQ

<details class="faq-item">
<summary><span>Should I use <code>typer.Argument</code> or <code>typer.Option</code> for file paths?</span></summary>

Use `typer.Argument` for positional inputs the user must always supply — source file, target directory. Use `typer.Option` for everything that has a sensible default or is genuinely optional: resolution, CRS, verbosity flags. Misclassifying a required path as an Option forces users to type the flag name on every invocation and is a common source of shell-script breakage when the flag name changes.

</details>

<details class="faq-item">
<summary>How do I validate an EPSG code inside a Typer callback?</summary>

Accept the value as `int`, then call `pyproj.CRS.from_epsg(value)` inside a `try/except pyproj.exceptions.CRSError` block. Raise `typer.BadParameter` with a message that includes the original int so Typer formats the error consistently with its own type-coercion messages. The callback runs before the command function body, so no I/O has been initiated when the error fires.

</details>

<details class="faq-item">
<summary>Can I layer a YAML config file under CLI flags?</summary>

Yes. Load the YAML file into a dict at import time (or lazily via `@lru_cache`), then set each `typer.Option`'s `default_factory` to a function that reads from `os.environ` first and falls back to the config dict. CLI flags always override because Typer resolves them after the Python default expression runs. The full layered-config pattern is covered in [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/).

</details>

<details class="faq-item">
<summary>Why does my Rich progress bar produce garbled output in CI?</summary>

Rich detects a non-TTY environment (pipes, GitHub Actions log streams) and in older versions it emits partial escape codes rather than disabling fully. Pass `disable=not sys.stdout.isatty()` explicitly to `rich.progress.Progress`. This also lets you force disable or enable the bar in tests without patching the TTY state.

</details>

<details class="faq-item">
<summary>How do I test Typer commands without spawning a subprocess?</summary>

Use `typer.testing.CliRunner` from the `typer[all]` package. Call `runner.invoke(app, ["subcommand", "--option", "value"])` and assert on `result.exit_code` and `result.output`. This avoids subprocess overhead, plays well with `pytest` fixtures that set up temporary GeoPackage files in `tmp_path`, and gives you the full exception traceback via `result.exception` when a test fails unexpectedly.

</details>

---

## Related

- [How to Build a Typer CLI for Shapefile Conversion](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/how-to-build-a-typer-cli-for-shapefile-conversion/) — end-to-end worked example wiring the patterns above to a real `geopandas` shapefile driver workflow.
- [Adding Auto-completion to Python Spatial CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/adding-auto-completion-to-python-spatial-cli-tools/) — configure shell completion for file paths, EPSG codes, and layer names.
- [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) — when explicit Click decorator syntax is preferable to Typer's type-hint inference.
- [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) — parent guide covering subcommand organisation, configuration layering, environment variable sync, and Rich output.
