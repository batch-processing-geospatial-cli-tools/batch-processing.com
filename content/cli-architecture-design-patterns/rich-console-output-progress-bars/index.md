# Rich Console Output & Progress Bars

Geospatial batch processing is inherently asynchronous and computationally intensive. Whether you are reprojecting thousands of vector layers, clipping raster mosaics against administrative boundaries, or validating topology across distributed datasets, silent execution breeds operational uncertainty. Modern Python CLI tooling demands immediate, structured feedback that survives both local development and headless CI/CD environments. This is where **Rich Console Output & Progress Bars** become essential infrastructure rather than cosmetic enhancements. By integrating terminal rendering with geospatial I/O loops, developers can surface coordinate reference system (CRS) metadata, track processing throughput, and surface errors without interrupting pipeline execution. This pattern aligns with broader [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) by decoupling presentation logic from core geoprocessing routines, ensuring maintainability as toolchains scale.

## Prerequisites & Environment Setup

Before implementing terminal feedback loops, verify your environment meets baseline requirements for reliable rendering and geospatial computation:

- **Python 3.9+**: Required for stable `concurrent.futures` behavior, modern type hinting, and predictable async/await semantics. Consult the official [Python `concurrent.futures` documentation](https://docs.python.org/3/library/concurrent.futures.html) for executor lifecycle guarantees.
- **`rich>=13.0.0`**: Provides advanced progress tracking, table rendering, ANSI color management, and automatic terminal capability detection.
- **CLI routing framework**: `typer` or `click` for command dispatch. Review [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) for implementation patterns that integrate cleanly with progress managers.
- **Geospatial stack**: `geopandas`, `rasterio`, or `pyproj` for actual data manipulation.
- **Terminal emulator**: Must support ANSI escape sequences and 24-bit color (Windows Terminal, iTerm2, GNOME Terminal, or modern CI runners).

Install core dependencies via your package manager:
```bash
pip install rich typer geopandas pyproj rasterio
```

## Core Workflow: Step-by-Step Implementation

The implementation follows a predictable pipeline: initialize the console, define progress tasks, bind tasks to geospatial iterators, and render structured output upon completion.

### Step 1: Console Initialization and Theme Configuration

Rich provides a `Console` object that abstracts away terminal capabilities, auto-detecting width, color support, and encoding. For GIS workflows, standardizing output themes ensures consistent rendering across developer workstations and automated runners.

```python
from rich.console import Console
from rich.theme import Theme
from rich.progress import (
    Progress, SpinnerColumn, TextColumn, BarColumn, 
    TaskProgressColumn, TimeRemainingColumn
)

gis_theme = Theme({
    "info": "cyan",
    "warning": "yellow bold",
    "error": "red bold",
    "crs": "green",
    "path": "dim"
})

console = Console(theme=gis_theme, stderr=True)
```
Setting `stderr=True` is critical for CLI pipelines. It separates diagnostic output from standard data streams, preventing broken pipes when your tool's stdout is redirected to another process or file.

### Step 2: Defining the Progress Pipeline

Geospatial batch jobs rarely process files sequentially without contextual metadata. You must pre-calculate task totals to avoid misleading progress indicators. Rich's `Progress` context manager handles rendering, auto-refresh, and terminal resizing gracefully.

```python
def create_progress() -> Progress:
    return Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=40),
        TaskProgressColumn(),
        TimeRemainingColumn(),
        console=console,
        transient=True  # Collapses completed tasks to reduce scrollback
    )
```
The `transient=True` flag keeps terminal history clean by removing finished tasks from the visible buffer. This is particularly valuable when chaining multiple geoprocessing stages, as it prevents terminal clutter during long-running validation passes.

### Step 3: Binding Tasks to Geospatial Iterators

Progress tracking must remain synchronized with actual I/O operations. For file-based workflows, calculate total bytes or file counts upfront, then update the task inside your processing loop.

```python
from pathlib import Path
from typing import Iterator, Tuple
import rasterio

def process_raster_batch(
    input_dir: Path,
    output_dir: Path
) -> Iterator[Tuple[Path, bool]]:
    files = list(input_dir.glob("*.tif"))
    task_id = progress.add_task(
        description="[crs]Processing Raster Mosaics",
        total=len(files)
    )
    
    for src_path in files:
        dest_path = output_dir / f"clipped_{src_path.name}"
        try:
            with rasterio.open(src_path) as src:
                # Simulate heavy CRS transformation & I/O
                profile = src.profile.copy()
                # ... actual geoprocessing logic ...
                with rasterio.open(dest_path, "w", **profile) as dst:
                    dst.write(src.read())
                    
            yield src_path, True
        except Exception as e:
            console.log(f"[error]Failed {src_path.name}: {e}")
            yield src_path, False
        finally:
            progress.advance(task_id)
```
When scaling to multi-threaded or multi-process execution, avoid sharing the `Progress` instance across process boundaries. Rich's progress manager is thread-safe, but multiprocessing requires either a manager proxy or centralized progress aggregation via a queue. The official [Rich Progress documentation](https://rich.readthedocs.io/en/stable/progress.html) details thread-safe `update()` patterns and executor integration.

### Step 4: Structured Error Handling & Completion Reporting

Silent failures in spatial pipelines corrupt downstream analyses. Instead of halting execution on the first exception, collect results and render a summary table.

```python
from rich.table import Table
from rich.panel import Panel

def render_summary(results: list[Tuple[Path, bool]]) -> None:
    table = Table(title="Batch Processing Summary")
    table.add_column("File", style="path")
    table.add_column("Status", justify="center")
    
    success_count = 0
    for path, success in results:
        status = "[info]✓ OK" if success else "[error]✗ FAIL"
        table.add_row(path.name, status)
        if success:
            success_count += 1
            
    console.print(table)
    
    panel = Panel(
        f"[info]Processed: {len(results)} | [crs]Success: {success_count} | [warning]Failed: {len(results) - success_count}",
        border_style="cyan"
    )
    console.print(panel)
```
This approach preserves pipeline continuity while giving operators actionable diagnostics. You can extend this pattern to log CRS validation warnings, projection mismatches, or topology errors directly into the summary table.

## Framework Integration & Pipeline Architecture

Terminal rendering should never leak into core business logic. Wrap your `Console` and `Progress` instances in a dependency injection layer or pass them explicitly to CLI entry points. When using `typer`, you can attach progress managers to command contexts or use callback hooks for initialization.

```python
import typer

app = typer.Typer()

@app.command()
def clip(
    input_dir: Path = typer.Argument(..., help="Source raster directory"),
    output_dir: Path = typer.Argument(..., help="Destination directory"),
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Suppress progress output")
) -> None:
    if quiet:
        console.print = lambda *args, **kwargs: None
        
    with create_progress() as progress:
        results = list(process_raster_batch(input_dir, output_dir))
        render_summary(results)
```
Choosing between routing frameworks impacts how you structure these hooks. For teams evaluating trade-offs between callback-heavy architectures and modern type-driven dispatch, [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) provides a detailed comparison of progress manager injection strategies.

## CI/CD Compatibility & Headless Execution

Automated runners often lack pseudo-TTY allocation, which breaks ANSI rendering and causes Rich to fall back to plain text. To guarantee reliable output across environments:

1. **Force terminal mode when needed**: `Console(force_terminal=True)` overrides auto-detection for CI pipelines that support colorized logs.
2. **Graceful degradation**: Detect `sys.stdout.isatty()` and disable progress bars when piping to log aggregators.
3. **Quiet mode flags**: Implement `--quiet` or `--no-progress` switches that replace progress bars with single-line status updates or JSON-formatted telemetry.
4. **Log level routing**: Send `console.log()` to `stderr` and reserve `stdout` for machine-readable outputs (GeoJSON, CSV, or NDJSON).

```python
import sys

def is_interactive() -> bool:
    return sys.stdout.isatty() and not os.environ.get("CI")

console = Console(
    theme=gis_theme,
    force_terminal=is_interactive(),
    quiet=os.environ.get("QUIET_MODE") == "1"
)
```
This configuration ensures your tool behaves predictably whether executed locally by a developer or triggered by GitHub Actions, GitLab CI, or Kubernetes cron jobs.

## Advanced Patterns & Metadata Rendering

Once progress tracking is stabilized, you can extend the console layer to surface spatial metadata dynamically. Coordinate system validation, bounding box extraction, and schema inference are prime candidates for inline rendering. Instead of dumping raw PROJ strings, format them into readable tables with validation badges.

For teams building spatial data catalogs or validation suites, [Customizing Rich tables for coordinate system outputs](/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/) demonstrates how to map `pyproj.CRS` objects into structured terminal views with color-coded authority codes and axis order indicators.

By treating terminal output as a first-class data interface, you transform opaque batch jobs into observable, debuggable pipelines. Rich Console Output & Progress Bars provide the scaffolding necessary to maintain operational confidence as geospatial workloads scale from hundreds to millions of features.