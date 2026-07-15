---
title: "Structuring a Multi-Command GDAL CLI with Typer Sub-Apps"
description: "Organise raster, vector, and inspect commands into separate Typer sub-apps mounted on one root app so each subcommand module stays independently testable."
slug: "structuring-a-multi-command-gdal-cli-with-typer-sub-apps"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "CLI Subcommand Organization for GIS Toolchains"
    url: "/cli-architecture-design-patterns/cli-subcommand-organization/"
  - label: "Structuring a Multi-Command GDAL CLI with Typer Sub-Apps"
    url: "/cli-architecture-design-patterns/cli-subcommand-organization/structuring-a-multi-command-gdal-cli-with-typer-sub-apps/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Structuring a Multi-Command GDAL CLI with Typer Sub-Apps

Split a growing GDAL CLI by giving each command group its own `typer.Typer()` instance in a separate module — `commands/raster.py`, `commands/vector.py`, `commands/inspect.py` — then mount them on one root app with `app.add_typer(raster_app, name="raster")`. That produces namespaced commands such as `mytool raster warp` and `mytool vector reproject` while keeping every module independently importable and testable. It belongs to the [CLI Subcommand Organization](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/) guide, within the wider [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install "typer>=0.12" pyogrio`
- `gdal` from a conda/mamba GDAL package or `python3-gdal` (GDAL 3.4+) for the raster commands

If you are still deciding how each command declares its options and arguments, read [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) first — this page assumes you already know how to annotate a single command and focuses purely on how many commands compose into one tool.

## Why One App Per Group

A single-file CLI is fine at three commands. By the time a GDAL tool grows raster warping, vector reprojection, and CRS inspection, one flat `typer.Typer()` becomes a 600-line module where a syntax error in the vector code stops the raster commands from importing. The fix is to treat each command group as a self-contained package module that exports its own `typer.Typer()` app, and to keep the root app — the one your entry point calls — in a module that nothing else imports.

The diagram below shows the import direction that keeps this clean. Every arrow points toward `main.py`; nothing points back out. That one-way flow is what prevents circular imports.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Package layout for a Typer GDAL CLI: three command modules each export a Typer sub-app that the root main module mounts with add_typer, with all imports pointing toward the root" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Typer sub-app mounting and import direction</title>
  <desc>Three command modules — raster, vector, and inspect — each expose a Typer app. The root main.py module imports all three and mounts them with add_typer under the names raster, vector, and inspect. Arrows show imports flowing from command modules into main.py only.</desc>
  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- command modules -->
  <rect x="20" y="40" width="180" height="58" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="110" y="64" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">commands/raster.py</text>
  <text x="110" y="82" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">raster_app = Typer()</text>
  <rect x="20" y="130" width="180" height="58" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="110" y="154" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">commands/vector.py</text>
  <text x="110" y="172" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">vector_app = Typer()</text>
  <rect x="20" y="220" width="180" height="58" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="110" y="244" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">commands/inspect.py</text>
  <text x="110" y="262" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">inspect_app = Typer()</text>
  <!-- import arrows toward root -->
  <line x1="200" y1="69" x2="330" y2="140" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="200" y1="159" x2="330" y2="159" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="200" y1="249" x2="330" y2="178" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" marker-end="url(#ar)"/>
  <text x="250" y="196" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.65">import</text>
  <!-- root app -->
  <rect x="340" y="118" width="180" height="82" rx="6" fill="#a78bfa" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4"/>
  <text x="430" y="144" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">main.py</text>
  <text x="430" y="163" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">app = Typer()</text>
  <text x="430" y="180" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">app.add_typer(...)</text>
  <!-- mount arrow to CLI tree -->
  <line x1="520" y1="159" x2="560" y2="159" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" marker-end="url(#ar)"/>
  <!-- resulting command tree -->
  <rect x="560" y="66" width="150" height="186" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="635" y="90" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">mytool</text>
  <text x="635" y="120" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">raster warp</text>
  <text x="635" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">vector reproject</text>
  <text x="635" y="180" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">inspect crs</text>
  <text x="635" y="222" text-anchor="middle" font-size="9.5" fill="#15803d" opacity="0.9">namespaced tree</text>
</svg>

## Complete Working Implementation

The package below has four files. Each command module is fully self-contained and exports exactly one `typer.Typer()` app; `main.py` is the only module that knows all three exist.

```python
# mytool/commands/raster.py
"""Raster commands — exports raster_app, imports nothing from the root."""
from pathlib import Path
from typing import Annotated
import typer
from osgeo import gdal

raster_app = typer.Typer(no_args_is_help=True, help="Raster operations")

@raster_app.command("warp")
def warp(
    src: Annotated[Path, typer.Argument(help="Source GeoTIFF")],
    dst: Annotated[Path, typer.Argument(help="Reprojected output")],
    crs: Annotated[str, typer.Option(help="Target CRS")] = "EPSG:3857",
) -> None:
    """Reproject a raster to a web-mercator (EPSG:3857) grid."""
    gdal.UseExceptions()
    out = gdal.Warp(
        str(dst), str(src),
        dstSRS=crs,                 # e.g. "EPSG:3857"
        format="GTiff",
        creationOptions=["TILED=YES", "COMPRESS=LZW"],
        resampleAlg="bilinear",
    )
    if out is None:
        typer.secho(f"gdal.Warp produced no output for {src}", fg="red", err=True)
        raise typer.Exit(code=1)
    out = None                       # trigger GDALClose(), flush to disk
    typer.echo(f"warped {src.name} -> {dst.name} ({crs})")
```

```python
# mytool/commands/vector.py
"""Vector commands — exports vector_app, uses pyogrio for I/O."""
from pathlib import Path
from typing import Annotated
import typer
import geopandas as gpd

vector_app = typer.Typer(no_args_is_help=True, help="Vector operations")

@vector_app.command("reproject")
def reproject(
    src: Annotated[Path, typer.Argument(help="Source vector file")],
    dst: Annotated[Path, typer.Argument(help="Reprojected output")],
    crs: Annotated[str, typer.Option(help="Target CRS")] = "EPSG:3857",
) -> None:
    """Reproject a vector layer, reading and writing through pyogrio."""
    gdf = gpd.read_file(src, engine="pyogrio")
    if gdf.crs is None:
        typer.secho(f"{src} has no CRS; cannot reproject", fg="red", err=True)
        raise typer.Exit(code=10)   # 10 = CRS mismatch/undefined
    out = gdf.to_crs(crs)
    out.to_file(dst, engine="pyogrio")
    typer.echo(f"reprojected {len(out)} features {gdf.crs.to_string()} -> {crs}")
```

```python
# mytool/commands/inspect.py
"""Inspect commands — exports inspect_app, read-only."""
from pathlib import Path
from typing import Annotated
import typer
import geopandas as gpd

inspect_app = typer.Typer(no_args_is_help=True, help="Inspection helpers")

@inspect_app.command("crs")
def crs(
    src: Annotated[Path, typer.Argument(help="Vector or raster file")],
) -> None:
    """Print the authority code of a dataset's CRS."""
    info = gpd.read_file(src, engine="pyogrio", rows=1)
    code = info.crs.to_authority() if info.crs else None
    if code is None:
        typer.secho(f"{src}: no CRS defined", fg="yellow")
        raise typer.Exit(code=10)
    typer.echo(f"{src.name}: {code[0]}:{code[1]}")
```

```python
# mytool/main.py
"""Root app — the ONLY module that imports the sub-apps."""
import typer
from mytool.commands.raster import raster_app
from mytool.commands.vector import vector_app
from mytool.commands.inspect import inspect_app

app = typer.Typer(no_args_is_help=True, help="A multi-command GDAL toolkit")

app.add_typer(raster_app, name="raster")     # -> mytool raster warp
app.add_typer(vector_app, name="vector")     # -> mytool vector reproject
app.add_typer(inspect_app, name="inspect")   # -> mytool inspect crs

def run() -> None:
    """Console-script entry point registered in pyproject.toml."""
    app()

if __name__ == "__main__":
    run()
```

## Step Annotations

1. **One `typer.Typer()` per module** — Each command file constructs its own app object and attaches commands to it with `@raster_app.command(...)`. The module exports that object and nothing else the root needs. This is the whole reason a broken import in `vector.py` cannot take down `raster.py`.

2. **`main.py` imports downward only** — The root imports `raster_app`, `vector_app`, and `inspect_app`; none of those modules import `main.py`. Keeping the arrow one-directional is what avoids the circular import failure described in the gotcha below.

3. **`add_typer(raster_app, name="raster")`** — Mounting a sub-app prefixes its commands with a namespace. The `warp` command defined inside `raster_app` becomes `mytool raster warp`. The name lives at the mount point, so you can rename the namespace without touching the command module.

4. **`no_args_is_help=True` on every app** — Applied to both the root and each sub-app, this makes a bare `mytool`, `mytool raster`, or `mytool vector` print help and exit `0` instead of raising a usage error and exiting `2`.

5. **Domain exit codes** — `warp` exits `1` on a GDAL runtime failure, while `reproject` and `crs` exit `10` when a CRS is missing. Consistent codes let shell wrappers and CI distinguish a genuine data problem from a crash.

6. **`run()` as the entry point** — Registering `mytool = "mytool.main:run"` under `[project.scripts]` gives users the `mytool` command after `pip install`. Loading shared defaults here — for example from a project config file — lets every subcommand inherit them; see [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) for the layering pattern.

## Named Gotcha: The Root App Import Cycle

The most common way this layout breaks is putting the root `app = typer.Typer()` object in the same module as a command that other modules need, then importing back and forth. If `commands/raster.py` does `from mytool.main import app` to register itself, and `main.py` does `from mytool.commands.raster import raster_app`, Python hits a partially initialised module during startup and raises `ImportError: cannot import name 'app' from partially initialized module 'mytool.main'`. On some import orders it fails silently with a sub-app that has zero commands.

The fix is the direction rule shown above: the root app lives alone in `main.py`, and command modules never import it. Each command module owns its own `typer.Typer()` and registers commands against that local object. The root pulls the finished sub-apps in and mounts them. Imports flow one way — from commands into the root — so there is no cycle to trip over.

## Verification

Confirm every sub-app mounted under the expected namespace by walking the `--help` tree. The root help lists the three groups; each group help lists its commands:

```bash
# Root shows the three command groups
mytool --help | grep -E 'raster|vector|inspect'

# Each group resolves to its own commands
mytool raster --help | grep warp
mytool vector --help | grep reproject
mytool inspect --help | grep crs

# A real invocation end to end
mytool raster warp scene.tif scene_3857.tif --crs EPSG:3857
echo "exit: $?"        # 0 on success, 1 on GDAL failure
```

If `mytool raster --help` lists `warp`, the sub-app mounted correctly. A bare `mytool raster` should print the same help and exit `0` — if it exits `2` with a usage error, `no_args_is_help=True` is missing from that group's constructor.

## FAQ

<details class="faq-item">
<summary>Where should the root Typer app object live?</summary>

Put the root app in a dedicated `main.py` that imports each sub-app module. The sub-app modules must never import `main.py`. Keeping imports one-directional prevents the circular import that occurs when a command module and the root both reference each other at module load time.
</details>

<details class="faq-item">
<summary>Why does my group print an error instead of help when run with no arguments?</summary>

By default Typer exits with code `2` and a usage error when a command group is invoked without a subcommand. Pass `no_args_is_help=True` to each `typer.Typer()` constructor so bare invocations like `mytool raster` print the group help text and exit `0` instead.
</details>

<details class="faq-item">
<summary>How do I test one subcommand group in isolation?</summary>

Because each group is its own `typer.Typer()` instance, you can import just `commands.raster` and drive its app with `typer.testing.CliRunner` without loading vector or inspect. This keeps unit tests fast and their imports minimal, and it means a broken vector dependency never blocks raster tests.
</details>

<details class="faq-item">
<summary>Does add_typer change the command names inside a sub-app?</summary>

No. `add_typer(raster_app, name="raster")` only prefixes the namespace. A command defined as `warp` inside `raster_app` becomes `mytool raster warp`. The function names and their own command names are untouched, so you can mount the same sub-app under a different name without editing the commands.
</details>

---

## Related

- [CLI Subcommand Organization](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/) — parent guide covering how to group, name, and namespace commands as a GDAL tool grows
- [Sharing Global Options Across Geospatial Subcommands](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/sharing-global-options-across-geospatial-subcommands/) — pass verbosity, config paths, and CRS defaults down into every mounted sub-app
