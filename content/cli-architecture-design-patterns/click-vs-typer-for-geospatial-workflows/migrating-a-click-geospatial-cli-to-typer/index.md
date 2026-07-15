---
title: "Migrating a Click Geospatial CLI to Typer"
description: "Port a Click-based GDAL command group to Typer incrementally: map decorators to type hints, preserve exit codes, and keep shell completion working during the switch."
slug: "migrating-a-click-geospatial-cli-to-typer"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Click vs Typer for Geospatial Workflows"
    url: "/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/"
  - label: "Migrating a Click Geospatial CLI to Typer"
    url: "/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/migrating-a-click-geospatial-cli-to-typer/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Migrating a Click Geospatial CLI to Typer

Migrate a Click GIS CLI to Typer command-by-command rather than in one rewrite: Typer is built on Click, so a Typer app can mount your existing Click group with `typer.main.get_command` and keep serving unported commands unchanged. For each command you port, replace `@click.option`/`@click.argument` decorators with type-hinted parameters, convert `ctx.exit(code)` to `raise typer.Exit(code)` to preserve exit codes, and confirm behaviour with `CliRunner`. This walkthrough belongs to the [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) guide, part of the broader [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later (for the `X | None` and `list[...]` hints used below)
- `pip install "typer>=0.12" click` — Typer pulls Click in as a dependency
- A GDAL install providing `osgeo.gdal` (GDAL 3.4+ from conda-forge or `python3-gdal`)
- An existing Click CLI whose parsing you already understand; the type-hint conventions carry over from [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/)

The migration touches only the command-definition layer. Your reprojection logic, GDAL calls, and error taxonomy stay exactly as they are — you are swapping the parser, not the engine.

## The Migration Path: Mount, Then Port

The safe strategy is not "convert everything" but "mount, then port one command at a time". A Typer application compiles down to a Click `Command`, and the reverse is available too: `typer.main.get_command(typer_app)` hands you a Click object, while a raw Click group can be attached to a Typer app with `app.add_typer(...)` after wrapping it in a small `typer.Typer` shim, or served directly through a combined root group. The diagram below shows how the old and new command sets coexist under a single entry point during the transition.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Incremental migration: a single CLI entry point routes the reproject command to new Typer code while validate and info stay mounted as Click commands" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Incremental Click-to-Typer migration under one entry point</title>
  <desc>A root CLI box at the top branches to three commands. The reproject command points to a green ported Typer implementation; the validate and info commands point to an amber mounted Click group. A dashed arrow shows commands moving from Click to Typer over time.</desc>
  <!-- Root -->
  <rect x="280" y="20" width="160" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.4"/>
  <text x="360" y="40" text-anchor="middle" font-size="12" fill="currentColor">gis (root Typer app)</text>
  <text x="360" y="56" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">single entry point</text>
  <!-- Branch lines -->
  <line x1="330" y1="66" x2="150" y2="120" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#am)"/>
  <line x1="360" y1="66" x2="360" y2="120" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#am)"/>
  <line x1="390" y1="66" x2="570" y2="120" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#am)"/>
  <!-- Command boxes -->
  <rect x="70" y="120" width="160" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.7" stroke-width="1.3"/>
  <text x="150" y="144" text-anchor="middle" font-size="11" fill="currentColor">reproject (ported)</text>
  <rect x="280" y="120" width="160" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.7" stroke-width="1.3"/>
  <text x="360" y="144" text-anchor="middle" font-size="11" fill="currentColor">validate (mounted)</text>
  <rect x="490" y="120" width="160" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.7" stroke-width="1.3"/>
  <text x="570" y="144" text-anchor="middle" font-size="11" fill="currentColor">info (mounted)</text>
  <!-- Implementation layer -->
  <rect x="70" y="215" width="160" height="52" rx="6" fill="currentColor" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="150" y="237" text-anchor="middle" font-size="10.5" fill="currentColor">Typer type hints</text>
  <text x="150" y="253" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">typer.Option / Argument</text>
  <rect x="385" y="215" width="265" height="52" rx="6" fill="currentColor" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="517" y="237" text-anchor="middle" font-size="10.5" fill="currentColor">legacy Click group</text>
  <text x="517" y="253" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">typer.main.get_command bridge</text>
  <!-- Impl links -->
  <line x1="150" y1="160" x2="150" y2="215" stroke="#15803d" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#am)"/>
  <line x1="360" y1="160" x2="470" y2="215" stroke="#a78bfa" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#am)"/>
  <line x1="570" y1="160" x2="560" y2="215" stroke="#a78bfa" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#am)"/>
  <!-- Migration direction -->
  <line x1="470" y1="292" x2="230" y2="292" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#am)"/>
  <text x="350" y="285" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">commands move left over time</text>
  <defs>
    <marker id="am" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
</svg>

## Before: The Click Command

Here is the `reproject` command as it exists in the Click CLI. It takes a variadic list of input rasters, a required target CRS option, and an output directory, and it uses domain exit codes: `2` for usage errors, `10` for a CRS the driver rejects, `12` for a partial batch failure.

```python
# gis_cli/click_app.py  — BEFORE
import sys
from pathlib import Path

import click
from osgeo import gdal

gdal.UseExceptions()

@click.group()
def cli() -> None:
    """Legacy GDAL command group."""

@cli.command()
@click.argument("sources", nargs=-1, type=click.Path(exists=True, path_type=Path))
@click.option("--crs", "target_crs", required=True, help="Target CRS, e.g. EPSG:32633")
@click.option(
    "--out-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("./reprojected"),
    show_default=True,
    help="Output directory for warped rasters.",
)
@click.option("--overwrite/--no-overwrite", default=False, help="Replace existing outputs.")
def reproject(sources: tuple[Path, ...], target_crs: str, out_dir: Path, overwrite: bool) -> None:
    """Reproject one or more GeoTIFFs to TARGET_CRS."""
    if not sources:
        click.echo("No source rasters given.", err=True)
        sys.exit(2)  # usage error

    out_dir.mkdir(parents=True, exist_ok=True)
    failures = 0
    for src in sources:
        dst = out_dir / f"{src.stem}_{target_crs.replace(':', '_')}.tif"
        if dst.exists() and not overwrite:
            click.echo(f"skip (exists): {dst.name}")
            continue
        try:
            ds = gdal.Warp(str(dst), str(src), dstSRS=target_crs, format="GTiff")
            if ds is None:
                raise RuntimeError("gdal.Warp returned no dataset")
            ds = None  # trigger GDALClose()
            click.echo(f"ok: {dst.name}")
        except RuntimeError as exc:
            failures += 1
            click.echo(f"fail: {src.name}: {exc}", err=True)

    if failures == len(sources):
        sys.exit(10)  # every file rejected the CRS
    if failures:
        sys.exit(12)  # partial batch failure

if __name__ == "__main__":
    cli()
```

## After: The Typer Command

The same command, ported to Typer. Every decorator becomes a type-hinted parameter with a `typer.Option`/`typer.Argument` default, `sys.exit(code)` becomes `raise typer.Exit(code)`, and the `nargs=-1` variadic becomes `list[Path]`. Crucially, the still-unported commands are mounted from the old Click group so nothing else breaks.

```python
# gis_cli/typer_app.py  — AFTER
from pathlib import Path
from typing import Annotated

import typer
from osgeo import gdal

from gis_cli.click_app import cli as legacy_click_group  # commands not yet ported

gdal.UseExceptions()

app = typer.Typer(help="GDAL command group (Typer).", no_args_is_help=True)

@app.command()
def reproject(
    sources: Annotated[
        list[Path],
        typer.Argument(exists=True, help="One or more source GeoTIFFs."),
    ],
    target_crs: Annotated[
        str, typer.Option("--crs", help="Target CRS, e.g. EPSG:32633")
    ],
    out_dir: Annotated[
        Path,
        typer.Option("--out-dir", file_okay=False, help="Output directory."),
    ] = Path("./reprojected"),
    overwrite: Annotated[
        bool, typer.Option("--overwrite/--no-overwrite", help="Replace existing outputs.")
    ] = False,
) -> None:
    """Reproject one or more GeoTIFFs to the target CRS."""
    if not sources:
        typer.echo("No source rasters given.", err=True)
        raise typer.Exit(2)  # usage error — same code as before

    out_dir.mkdir(parents=True, exist_ok=True)
    failures = 0
    for src in sources:
        dst = out_dir / f"{src.stem}_{target_crs.replace(':', '_')}.tif"
        if dst.exists() and not overwrite:
            typer.echo(f"skip (exists): {dst.name}")
            continue
        try:
            ds = gdal.Warp(str(dst), str(src), dstSRS=target_crs, format="GTiff")
            if ds is None:
                raise RuntimeError("gdal.Warp returned no dataset")
            ds = None  # trigger GDALClose()
            typer.echo(f"ok: {dst.name}")
        except RuntimeError as exc:
            failures += 1
            typer.echo(f"fail: {src.name}: {exc}", err=True)

    if failures == len(sources):
        raise typer.Exit(10)   # every file rejected the CRS
    if failures:
        raise typer.Exit(12)   # partial batch failure

# Mount the not-yet-ported Click commands so the whole app keeps working.
# typer.main.get_command(app) -> Click object for the Typer commands;
# we merge that with the legacy Click group under one root.
typer_as_click = typer.main.get_command(app)

root = typer.main.get_group(app) if hasattr(typer.main, "get_group") else typer_as_click
for name, cmd in legacy_click_group.commands.items():
    if name not in root.commands:      # never shadow a ported command
        root.commands[name] = cmd

if __name__ == "__main__":
    root()
```

## Step Annotations

1. **`@click.argument("sources", nargs=-1)` becomes `list[Path]`** — Typer derives multiplicity from the annotation, not a keyword. A `list[Path]` parameter with a `typer.Argument` default accepts any number of values; there is no `nargs` to pass. This is the mapping to internalise before touching any other parameter.

2. **`@click.option("--crs", "target_crs", required=True)` becomes an `Annotated[str, typer.Option("--crs", ...)]` with no default** — a parameter without a default value is required in Typer. Passing the explicit `"--crs"` string preserves the flag name; without it Typer would derive `--target-crs` from the Python name and silently change your public interface.

3. **`show_default=True` disappears** — Typer shows defaults automatically for optional parameters, so the flag is dropped. The `default=Path("./reprojected")` moves to the parameter's `= Path(...)` default in the signature.

4. **`--overwrite/--no-overwrite` boolean flag** — Click's slash syntax works unchanged when passed as the first argument to `typer.Option`. Typer recognises the `/` and builds the paired on/off flags identically.

5. **`sys.exit(code)` becomes `raise typer.Exit(code)`** — this is the load-bearing substitution for behaviour preservation. `typer.Exit` carries the integer straight to the process exit status, so `2`, `10`, and `12` remain exactly what callers and CI pipelines match on. Never leave a bare `sys.exit` inside a Typer command: it works but bypasses Typer's result-handling and complicates testing with `CliRunner`.

6. **`typer.main.get_command(app)` and merging `legacy_click_group.commands`** — because Typer compiles to Click, both command sets are plain Click `Command` objects living in a `.commands` dict. Copying the legacy entries into the root group mounts them under one entry point. The `if name not in root.commands` guard guarantees a ported command always wins over its legacy twin, so you can port `reproject` and delete the old one later without a flag day.

## Named Gotcha: The Callback Signature Changes Between Click and Typer

The most common breakage during this port is a group-level callback that used the Click `@click.pass_context` idiom to stash shared state (a config path, a `--verbose` flag, a pyproj `Transformer`) on `ctx.obj`. In Click the callback receives a `Context` as its first positional parameter. In Typer, the group callback is an ordinary function whose parameters are parsed as options; if you keep a bare `ctx` parameter, Typer tries to turn it into a CLI option and raises a type error at import time, because `click.Context` is not a supported parameter type.

The fix is to annotate the context explicitly so Typer injects it instead of parsing it:

```python
@app.callback()
def main(
    ctx: typer.Context,   # explicit annotation -> injected, not parsed
    verbose: Annotated[bool, typer.Option("--verbose")] = False,
) -> None:
    ctx.obj = {"verbose": verbose}
```

Typer special-cases a parameter annotated as `typer.Context` (an alias of `click.Context`) and passes the live context through untouched, so `ctx.obj` assignment and downstream `ctx.obj["verbose"]` reads keep working exactly as they did under Click. Miss the annotation and the app will not even import.

## Verification

Test the ported command against the Click baseline with `typer.testing.CliRunner`. It wraps Click's runner, so `result.exit_code` reports the same integers your `raise typer.Exit(code)` calls produce. Assert on the exit codes that carry domain meaning and confirm `--help` still lists every command — both ported and mounted:

```python
# tests/test_reproject_migration.py
from typer.testing import CliRunner

from gis_cli.typer_app import app

runner = CliRunner()

def test_usage_error_exit_code() -> None:
    # No SOURCES given -> usage error, exit code 2 (unchanged from Click).
    result = runner.invoke(app, ["reproject", "--crs", "EPSG:32633"])
    assert result.exit_code == 2
    assert "No source rasters" in result.output

def test_help_lists_all_commands() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "reproject" in result.output   # ported Typer command
    assert "validate" in result.output    # still mounted from Click
```

Run the suite and a manual completion check side by side:

```bash
pytest tests/test_reproject_migration.py -q

# Shell completion is shared because Typer compiles to Click:
python -m gis_cli.typer_app --install-completion bash
python -m gis_cli.typer_app reproject --crs EPSG:4326 ./tiles/*.tif
echo "exit code: $?"   # expect 0 on full success, 12 on partial failure
```

Matching exit codes from `CliRunner` and a `--help` listing that still contains the mounted commands confirm the migration preserved behaviour. For the broader testing harness these assertions plug into, see [Testing Click Commands with CliRunner for GIS Tools](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/testing-click-commands-with-clirunner-for-gis-tools/).

## FAQ

<details class="faq-item">
<summary>Do I have to rewrite the whole CLI in one commit?</summary>

No. Typer is built on Click, so a Typer app can mount an existing Click group with `typer.main.get_command` and `add_typer`. Port one command at a time, keep the rest running as Click, and ship each command independently.
</details>

<details class="faq-item">
<summary>How do I keep exit codes identical after migrating to Typer?</summary>

Replace `ctx.exit(code)` and `sys.exit(code)` with `raise typer.Exit(code)`. `typer.Exit` propagates the integer to the process exit status unchanged, so domain codes like `10` for a CRS mismatch and `2` for a usage error survive the port.
</details>

<details class="faq-item">
<summary>What happens to a Click nargs=-1 variadic argument in Typer?</summary>

A Click argument with `nargs=-1` becomes a parameter typed as `list[Path]` with a `typer.Argument` default in Typer. Typer reads the number of values from the type annotation, so there is no `nargs` keyword to pass.
</details>

<details class="faq-item">
<summary>Will shell completion keep working during the migration?</summary>

Yes. Because Typer compiles to a Click command object, the completion machinery is shared. Ported Typer commands and mounted Click commands both appear under the same `--install-completion` hook, so a single installed completion script covers the whole app.
</details>

---

## Related

- [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) — parent guide weighing the two parsers for GDAL and pyproj command groups
- [Testing Click Commands with CliRunner for GIS Tools](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/testing-click-commands-with-clirunner-for-gis-tools/) — assert exit codes and output for both Click and Typer commands during the port
