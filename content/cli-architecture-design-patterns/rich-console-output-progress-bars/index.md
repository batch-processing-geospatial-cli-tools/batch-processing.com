---
title: "Rich Console Output & Progress Bars for GIS CLIs"
description: "Add structured progress bars, themed tables, and error-safe console output to geospatial batch CLIs using Python's Rich library — with full CI/CD compatibility."
slug: "rich-console-output-progress-bars"
type: "topic"
breadcrumb: "CLI Architecture & Design Patterns > Rich Console Output & Progress Bars"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Rich Console Output & Progress Bars for Geospatial CLI Tools",
      "description": "Use Python's Rich library to add structured progress bars, themed tables, and error-safe console output to geospatial batch processing CLIs — with full CI/CD compatibility.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 3, "name": "Rich Console Output & Progress Bars", "item": "https://batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Add Rich progress bars and structured console output to a geospatial CLI",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Initialize a themed Console on stderr"},
        {"@type": "HowToStep", "position": 2, "name": "Build a Progress context with geospatial-aware columns"},
        {"@type": "HowToStep", "position": 3, "name": "Bind tasks to raster or vector I/O iterators"},
        {"@type": "HowToStep", "position": 4, "name": "Render a structured summary table after the batch"},
        {"@type": "HowToStep", "position": 5, "name": "Configure headless / CI fallback modes"}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is Rich's Progress object thread-safe for concurrent raster processing?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes — Progress.advance() and Progress.update() are thread-safe when called from multiple threads. For multiprocessing you need a Manager-proxied counter or a queue-based aggregator, because worker processes do not share memory with the parent console."}
        },
        {
          "@type": "Question",
          "name": "Why should I write Console output to stderr rather than stdout?",
          "acceptedAnswer": {"@type": "Answer", "text": "Writing progress and diagnostics to stderr keeps stdout clean for machine-readable output (GeoJSON, CSV, NDJSON). When stdout is piped to another process or file, stderr output continues to appear in the terminal without breaking the pipe."}
        },
        {
          "@type": "Question",
          "name": "How do I disable the progress bar when running inside GitHub Actions or GitLab CI?",
          "acceptedAnswer": {"@type": "Answer", "text": "Detect the CI environment variable and sys.stdout.isatty(). Set Console(quiet=True) or omit the Progress context altogether, replacing it with plain console.log() calls that CI log aggregators can parse."}
        },
        {
          "@type": "Question",
          "name": "What does transient=True do in a Rich Progress context?",
          "acceptedAnswer": {"@type": "Answer", "text": "transient=True removes each completed progress bar from the terminal scrollback once its task finishes. This keeps the terminal clean during multi-stage pipelines without flooding the history with stale bars."}
        },
        {
          "@type": "Question",
          "name": "Can I use Rich tables to display CRS metadata alongside progress?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes. After the batch completes, render a rich.table.Table with columns for EPSG code, authority, axis order, and validation status. For detailed column configuration and overflow handling see the Customizing Rich tables for coordinate system outputs guide."}
        }
      ]
    }
  ]
}
</script>

Adding terminal feedback to geospatial batch CLIs turns opaque multi-minute raster runs into observable, debuggable pipelines — this page is part of the [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) guide.

## Prerequisites

- Python 3.9+ (required for stable `concurrent.futures` behavior and modern type hints)
- `rich>=13.0.0` — progress tracking, themed tables, ANSI color management, auto terminal detection
- A CLI dispatch layer: use [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) for type-safe entry points that accept `Path` and EPSG arguments
- Geospatial stack: `rasterio`, `geopandas`, or `pyproj` for real data operations
- Terminal with ANSI support (Windows Terminal, iTerm2, GNOME Terminal, modern CI runners with `TERM=xterm-256color`)

```bash
pip install "rich>=13.0.0" "typer[all]" geopandas pyproj rasterio
```

## Problem framing

Silent batch jobs fail operators. A reprojection loop that quietly skips 400 files due to a missing EPSG:3857 override looks identical to a successful run — until the downstream mosaic has holes. Without progress feedback you also lose throughput visibility: there is no way to know whether 10 000 GeoTIFFs will finish in two minutes or two hours. Rich Console Output solves both problems by exposing per-file state, elapsed time, and error counts in the terminal, while keeping stdout clean for machine-readable data.

## Architecture overview

The diagram below shows how a Rich console layer sits between the CLI entry point and the core geoprocessing routines. Presentation logic is fully decoupled; the processing functions yield `(Path, bool)` tuples and never import `rich`.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Rich console architecture: CLI entry point feeds into Console/Progress layer which drives the geoprocessing loop and collects results for the summary table" style="width:100%;max-width:720px;display:block;margin:1.5rem auto;">
  <title>Rich console architecture for geospatial CLIs</title>
  <desc>Three-layer diagram showing CLI entry point, Rich console/progress manager, and geoprocessing core with a results summary table at the bottom.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Layer boxes -->
  <rect x="20" y="20" width="680" height="64" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="360" y="46" text-anchor="middle" font-size="12" fill="currentColor" opacity="0.5" font-family="sans-serif">CLI Entry Point (Typer / Click)</text>
  <text x="360" y="66" text-anchor="middle" font-size="13" fill="currentColor" font-family="monospace">@app.command()  clip(input_dir, output_dir, quiet)</text>
  <rect x="20" y="108" width="680" height="80" rx="8" fill="none" stroke="#7c6af7" stroke-opacity="0.45" stroke-width="1.5"/>
  <text x="360" y="132" text-anchor="middle" font-size="12" fill="#5b21b6" font-family="sans-serif">Rich Console Layer  (stderr, themed)</text>
  <rect x="36" y="142" width="190" height="34" rx="5" fill="#7c6af7" fill-opacity="0.12"/>
  <text x="131" y="164" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Console(theme=…)</text>
  <rect x="264" y="142" width="192" height="34" rx="5" fill="#7c6af7" fill-opacity="0.12"/>
  <text x="360" y="164" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Progress(transient=True)</text>
  <rect x="494" y="142" width="190" height="34" rx="5" fill="#7c6af7" fill-opacity="0.12"/>
  <text x="589" y="164" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">render_summary()</text>
  <rect x="20" y="212" width="680" height="64" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="360" y="238" text-anchor="middle" font-size="12" fill="currentColor" opacity="0.5" font-family="sans-serif">Geoprocessing Core  (no rich imports)</text>
  <text x="360" y="260" text-anchor="middle" font-size="13" fill="currentColor" font-family="monospace">process_raster_batch() → Iterator[(Path, bool)]</text>
  <!-- Arrows -->
  <line x1="360" y1="84" x2="360" y2="106" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="360" y1="188" x2="360" y2="210" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="360" y1="276" x2="360" y2="296" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5"/>
  <text x="360" y="312" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.45" font-family="sans-serif">results → summary table → exit code 0/1</text>
</svg>

## Step-by-step implementation

### Step 1 — Initialize the Console on stderr with a GIS theme

Rich's `Console` object auto-detects terminal width, color depth, and encoding. Binding it to `stderr` separates diagnostic output from the data stream, so `stdout` remains pipe-safe.

```python
from rich.console import Console
from rich.theme import Theme

gis_theme = Theme({
    "info":    "cyan",
    "warning": "yellow bold",
    "error":   "red bold",
    "crs":     "green",
    "path":    "dim",
})

console = Console(theme=gis_theme, stderr=True)
```

`stderr=True` is the single most important setting for GIS tooling. Pipelines like `my_tool clip . output/ | ogr2ogr …` will break if Rich renders ANSI escape sequences on `stdout`.

### Step 2 — Build a Progress context with geospatial-aware columns

Pre-calculate file counts before entering the `Progress` context so the bar shows a real total rather than an indeterminate spinner. `transient=True` collapses finished tasks from the scrollback, which matters when you chain multiple reprojection, clip, and validation stages.

```python
from rich.progress import (
    Progress, SpinnerColumn, TextColumn,
    BarColumn, TaskProgressColumn, TimeRemainingColumn,
    MofNCompleteColumn,
)

def make_progress() -> Progress:
    return Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=40),
        MofNCompleteColumn(),       # shows "42/1000" alongside the bar
        TaskProgressColumn(),
        TimeRemainingColumn(),
        console=console,
        transient=True,
    )
```

`MofNCompleteColumn` is particularly useful for raster batches where each file may take a different amount of time — seeing "42/1000 files" is more actionable than a percentage alone.

### Step 3 — Bind progress tasks to raster I/O iterators

Keep the processing function ignorant of Rich. Accept a `Progress` instance as a parameter and call `progress.advance()` inside the loop. This makes unit-testing the geoprocessing logic straightforward — pass a no-op progress object in tests.

```python
from pathlib import Path
from typing import Iterator
import rasterio
from rasterio.crs import CRS

def process_raster_batch(
    input_dir: Path,
    output_dir: Path,
    target_epsg: int,
    progress: Progress,
) -> Iterator[tuple[Path, bool]]:
    """Reproject every GeoTIFF in input_dir to target_epsg, yield (path, success)."""
    files = sorted(input_dir.glob("*.tif"))
    task_id = progress.add_task(
        description=f"[crs]Reprojecting → EPSG:{target_epsg}",
        total=len(files),
    )
    target_crs = CRS.from_epsg(target_epsg)

    for src_path in files:
        dest_path = output_dir / f"epsg{target_epsg}_{src_path.name}"
        try:
            with rasterio.open(src_path) as src:
                if src.crs == target_crs:
                    # CRS already matches — copy without transformation
                    dest_path.write_bytes(src_path.read_bytes())
                else:
                    import rasterio.warp as warp
                    transform, width, height = warp.calculate_default_transform(
                        src.crs, target_crs, src.width, src.height, *src.bounds
                    )
                    profile = src.profile.copy()
                    profile.update(crs=target_crs, transform=transform,
                                   width=width, height=height)
                    with rasterio.open(dest_path, "w", **profile) as dst:
                        for band_idx in src.indexes:
                            warp.reproject(
                                source=rasterio.band(src, band_idx),
                                destination=rasterio.band(dst, band_idx),
                                src_crs=src.crs,
                                dst_crs=target_crs,
                                resampling=warp.Resampling.lanczos,
                            )
            yield src_path, True
        except Exception as exc:
            console.log(f"[error]FAIL[/error] [path]{src_path.name}[/path]: {exc}")
            yield src_path, False
        finally:
            progress.advance(task_id)
```

`progress.advance()` is thread-safe, so you can wrap this iterator in a `concurrent.futures.ThreadPoolExecutor` without adding locks around the Rich calls.

### Step 4 — Render a structured summary table after the batch

Never halt the pipeline on the first error. Collect `(Path, bool)` results and render a `rich.table.Table` when the batch completes. This gives operators a single actionable view of what succeeded and what needs investigation.

```python
from rich.table import Table
from rich.panel import Panel

def render_summary(results: list[tuple[Path, bool]]) -> int:
    """Print a summary table and return exit code (0 = all OK, 1 = some failed)."""
    table = Table(title="Batch Reprojection Summary", show_lines=False)
    table.add_column("File",   style="path",  no_wrap=True, max_width=50)
    table.add_column("Status", justify="center", width=8)

    failures = 0
    for path, ok in results:
        table.add_row(path.name, "[info]OK[/info]" if ok else "[error]FAIL[/error]")
        if not ok:
            failures += 1

    console.print(table)
    console.print(Panel(
        f"[info]Total:[/info] {len(results)}  "
        f"[crs]OK:[/crs] {len(results) - failures}  "
        f"[error]Failed:[/error] {failures}",
        border_style="cyan",
    ))
    return 1 if failures else 0
```

For richer CRS-aware column formatting — displaying EPSG authority codes, axis order badges, and projection type labels — see [Customizing Rich tables for coordinate system outputs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/).

### Step 5 — Wire the console layer into the Typer command

Pass `Console` and `Progress` instances from the command handler down into the processing functions. Never import `console` as a module-level global inside geoprocessing modules.

```python
import sys
import typer
from pathlib import Path

app = typer.Typer()

@app.command()
def reproject(
    input_dir:   Path = typer.Argument(..., help="Directory of source GeoTIFFs"),
    output_dir:  Path = typer.Argument(..., help="Destination directory"),
    epsg:        int  = typer.Option(3857,  "--epsg",  help="Target EPSG code"),
    quiet:       bool = typer.Option(False, "--quiet", "-q", help="Suppress progress"),
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    if quiet:
        from rich.progress import Progress as _Progress
        with _Progress(console=Console(quiet=True, stderr=True)) as progress:
            results = list(process_raster_batch(input_dir, output_dir, epsg, progress))
    else:
        with make_progress() as progress:
            results = list(process_raster_batch(input_dir, output_dir, epsg, progress))

    exit_code = render_summary(results)
    raise typer.Exit(code=exit_code)
```

Exit code `0` means all files succeeded; exit code `1` means at least one file failed. This follows POSIX conventions and allows CI pipelines to treat partial failures as build errors. For command dispatch patterns that structure multiple subcommands with shared option groups, see [CLI Subcommand Organization](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/).

## Configuration integration

Rich console behavior should be controllable through the same layered config stack used for the rest of the CLI: environment variables override file-based config, and explicit flags override both.

```python
import os, sys

def build_console() -> Console:
    """
    Precedence: --quiet flag > QUIET_MODE=1 env var > TTY detection > default.
    Force terminal mode when CI=true but the runner supports ANSI (e.g. GitHub Actions).
    """
    force_terminal = (
        os.environ.get("FORCE_COLOR") == "1"
        or os.environ.get("TERM_PROGRAM") in {"iTerm.app", "vscode"}
    )
    quiet = os.environ.get("QUIET_MODE") == "1"
    return Console(
        theme=gis_theme,
        stderr=True,
        force_terminal=force_terminal,
        quiet=quiet,
    )
```

For layered YAML/TOML configuration that governs defaults like `default_epsg`, `log_level`, and `output_format`, [Managing YAML configs for geospatial CLI workflows](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/) shows how to merge file, environment, and flag layers into a single config object that your console layer can read at startup.

## Data-flow diagram: the progress lifecycle

<svg viewBox="0 0 700 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Progress lifecycle: file discovery feeds add_task, the processing loop advances the task, completion triggers render_summary and an exit code" style="width:100%;max-width:700px;display:block;margin:1.5rem auto;">
  <title>Rich Progress lifecycle for a geospatial batch job</title>
  <desc>Flow diagram showing five stages: file discovery, add_task, process loop with advance, exception branch to console.log, and final render_summary returning exit code 0 or 1.</desc>
  <defs>
    <marker id="a2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Node: File discovery -->
  <rect x="215" y="16" width="270" height="44" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="350" y="34" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">File discovery</text>
  <text x="350" y="50" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="monospace">files = list(dir.glob("*.tif"))</text>
  <!-- Arrow down -->
  <line x1="350" y1="60" x2="350" y2="88" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#a2)"/>
  <!-- Node: add_task -->
  <rect x="215" y="90" width="270" height="44" rx="8" fill="#7c6af7" fill-opacity="0.12" stroke="#7c6af7" stroke-opacity="0.45" stroke-width="1.5"/>
  <text x="350" y="108" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Register task</text>
  <text x="350" y="124" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="monospace">progress.add_task(total=len(files))</text>
  <!-- Arrow down -->
  <line x1="350" y1="134" x2="350" y2="162" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#a2)"/>
  <!-- Node: process loop -->
  <rect x="195" y="164" width="310" height="60" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="350" y="184" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Processing loop</text>
  <text x="350" y="200" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="monospace">rasterio.open → warp.reproject</text>
  <text x="350" y="216" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="monospace">progress.advance(task_id)  ← finally</text>
  <!-- Arrow: success path -->
  <line x1="350" y1="224" x2="350" y2="270" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="366" y="252" font-size="10" fill="currentColor" opacity="0.5" font-family="sans-serif">yield (path, True)</text>
  <!-- Arrow: error path (side branch) -->
  <line x1="505" y1="194" x2="580" y2="194" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#a2)"/>
  <rect x="580" y="170" width="104" height="48" rx="6" fill="#ef4444" fill-opacity="0.1" stroke="#ef4444" stroke-opacity="0.4" stroke-width="1.5"/>
  <text x="632" y="190" text-anchor="middle" font-size="11" fill="currentColor" font-family="monospace">console.log</text>
  <text x="632" y="206" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6" font-family="sans-serif">yield (path, False)</text>
  <line x1="632" y1="218" x2="632" y2="284" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5"/>
  <line x1="632" y1="284" x2="506" y2="284" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#a2)"/>
  <!-- Node: render_summary -->
  <rect x="225" y="272" width="250" height="44" rx="8" fill="#7c6af7" fill-opacity="0.12" stroke="#7c6af7" stroke-opacity="0.45" stroke-width="1.5"/>
  <text x="350" y="290" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">render_summary(results)</text>
  <text x="350" y="308" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6" font-family="monospace">rich.table.Table + Panel</text>
  <!-- Arrow down -->
  <line x1="350" y1="316" x2="350" y2="346" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" marker-end="url(#a2)"/>
  <!-- Node: exit code -->
  <rect x="230" y="348" width="240" height="24" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.5"/>
  <text x="350" y="364" text-anchor="middle" font-size="11" fill="currentColor" font-family="monospace">raise typer.Exit(code=0 | 1)</text>
</svg>

## Error handling and gotchas

**CRS mismatch not caught at open time.** `rasterio.open()` succeeds even when the on-disk CRS is missing or inconsistent. Check `src.crs is not None` before passing to `warp.calculate_default_transform`, and emit a `[warning]` console message rather than letting the warp call raise a cryptic PROJ exception.

**Thread safety in `Progress`.** `Progress.advance()` and `Progress.update()` are safe from threads. They are not safe from subprocesses — `multiprocessing.Pool` workers run in separate memory spaces and cannot call the parent's `Progress` directly. Use a `multiprocessing.Queue` to send `(task_id, increment)` tuples back to the main process, which calls `progress.advance()` from a listener thread.

**GDAL driver availability.** On minimal Docker images, GDAL may lack cloud-optimized GeoTIFF (COG) or NetCDF drivers. Catch `rasterio.errors.RasterioIOError` and inspect the message for "no driver" before logging; surface the missing driver name explicitly so the operator knows which GDAL plugin to install.

**Transient progress and scrollback.** With `transient=True`, completed task bars are erased from the terminal. If your pipeline redirects stderr to a file for auditing, the file will contain ANSI escape sequences that erase lines — they appear as garbled output in plain text viewers. Add `force_terminal=False` when `stderr` is not a TTY.

**Windows `conhost` colour depth.** The legacy Windows Console Host (`conhost.exe`) reports limited color support. Rich auto-detects this and downgrades to 8-bit colors, but if colors are critical (e.g., pass/fail badges), force `Console(color_system="256")` on Windows or instruct users to use Windows Terminal.

## Verification

After running a batch, verify the pipeline behaved correctly:

```bash
# Count successfully reprojected files
ls output/ | wc -l

# Confirm all outputs carry the correct CRS
python - <<'PY'
from pathlib import Path
import rasterio

for p in sorted(Path("output").glob("*.tif")):
    with rasterio.open(p) as src:
        epsg = src.crs.to_epsg() if src.crs else None
        status = "OK" if epsg == 3857 else f"UNEXPECTED epsg={epsg}"
        print(f"{p.name}: {status}")
PY
```

Exit code `1` from the CLI means at least one file failed. Wrap the command in your CI pipeline:

```bash
python -m mypackage reproject ./raw ./reprojected --epsg 3857
echo "Exit: $?"   # 0 = all good, 1 = partial failure
```

## Performance notes

Rich's progress rendering adds negligible CPU overhead (microseconds per `advance()` call) compared to rasterio I/O. The dominant bottlenecks are disk throughput and GDAL warping.

- For batches under ~500 files, single-threaded sequential I/O with `transient=True` is typically fastest — no thread-pool overhead.
- For larger batches, use `concurrent.futures.ThreadPoolExecutor` with `max_workers=4–8`. rasterio releases the GIL during reads, so threads help when files are spread across an NFS or S3-backed filesystem.
- For CPU-bound warping (e.g., Lanczos resampling on large rasters), `ProcessPoolExecutor` outperforms threads. Collect results via a `multiprocessing.Queue` and aggregate progress in the main process.
- Memory: `transient=True` does not reduce memory — Rich still tracks completed tasks internally until the `Progress` context exits. For extremely long batches (100 000+ files), call `progress.remove_task(task_id)` after `advance()` to free the internal task record.

## FAQ

<details class="faq-item">
<summary>Is Rich's Progress object thread-safe for concurrent raster processing?</summary>

Yes. `Progress.advance()` and `Progress.update()` acquire an internal lock before modifying the render state, so multiple threads can call them concurrently without corruption. For multiprocessing workers you need an IPC channel (Queue or Manager proxy) because worker processes cannot share the parent's memory.

</details>

<details class="faq-item">
<summary>Why should console output go to stderr rather than stdout?</summary>

Geospatial CLIs frequently pipe their output into other programs — `ogr2ogr`, `gdal_translate`, `jq`, or custom consumers. Mixing ANSI progress bars into `stdout` breaks these pipes. Binding the `Console` to `stderr` (`Console(stderr=True)`) keeps `stdout` clean for GeoJSON, CSV, or binary raster data.

</details>

<details class="faq-item">
<summary>How do I disable progress bars inside GitHub Actions or GitLab CI?</summary>

GitHub Actions sets `CI=true`. Detect this and fall back to plain log lines:

```python
import os, sys

def is_interactive() -> bool:
    return sys.stderr.isatty() and not os.environ.get("CI")

console = Console(stderr=True, force_terminal=is_interactive())
```

Alternatively, pass `--quiet` on the CI command line — the Typer entry point shown above honours this flag.

</details>

<details class="faq-item">
<summary>What does transient=True do, and when should I turn it off?</summary>

`transient=True` removes each progress bar from the terminal display as soon as its task completes. This keeps multi-stage pipelines tidy. Turn it off (`transient=False`) when you want a permanent record of each stage's completion time in the terminal — useful during debugging or live demos.

</details>

<details class="faq-item">
<summary>Can I render CRS metadata tables alongside the progress output?</summary>

Yes. Because `Console` is passed explicitly, you can call `console.print(table)` at any point inside the `Progress` context — Rich will render the table above the live progress bar. For full EPSG column configuration, axis order badges, and overflow handling, see [Customizing Rich tables for coordinate system outputs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/).

</details>

## Related

- [Customizing Rich tables for coordinate system outputs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/) — map `pyproj.CRS` objects into terminal tables with EPSG badges and axis order indicators
- [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) — parent guide covering the full CLI toolcraft stack for Python GIS practitioners
- [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) — type-safe CLI entry points that integrate cleanly with the progress manager patterns shown above
- [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) — comparison of callback-heavy and type-driven dispatch, including how each framework handles progress manager injection
