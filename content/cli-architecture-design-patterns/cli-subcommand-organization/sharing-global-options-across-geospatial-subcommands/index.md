---
title: "Sharing Global Options Across Geospatial Subcommands"
description: "Propagate --crs, --workers, and --config to every subcommand via a Typer context object so global flags resolve once and flow into each command."
slug: "sharing-global-options-across-geospatial-subcommands"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "CLI Subcommand Organization for GIS Toolchains"
    url: "/cli-architecture-design-patterns/cli-subcommand-organization/"
  - label: "Sharing Global Options Across Geospatial Subcommands"
    url: "/cli-architecture-design-patterns/cli-subcommand-organization/sharing-global-options-across-geospatial-subcommands/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Sharing Global Options Across Geospatial Subcommands",
      "description": "Propagate --crs, --workers, and --config to every subcommand via a Typer context object so global flags resolve once and flow into each command.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "CLI Subcommand Organization for GIS Toolchains", "item": "https://batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/"},
        {"@type": "ListItem", "position": 3, "name": "Sharing Global Options Across Geospatial Subcommands", "item": "https://batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/sharing-global-options-across-geospatial-subcommands/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Share Global Options Across Geospatial Typer Subcommands",
      "step": [
        {"@type": "HowToStep", "name": "Define a shared state dataclass", "text": "Create a frozen dataclass that holds the resolved crs, workers, config path, and verbose flag for the whole toolchain."},
        {"@type": "HowToStep", "name": "Resolve options in a root callback", "text": "Declare --crs, --workers, --config, and --verbose on an @app.callback() and store the built state on ctx.obj."},
        {"@type": "HowToStep", "name": "Read ctx.obj in each subcommand", "text": "Add a ctx: typer.Context parameter to every raster and vector subcommand and pull the shared state from ctx.obj."},
        {"@type": "HowToStep", "name": "Guard against a missing callback", "text": "Handle the case where ctx.obj is None so subcommands fail loudly instead of raising AttributeError."},
        {"@type": "HowToStep", "name": "Verify propagation", "text": "Invoke a raster and a vector subcommand with the same global flags and confirm both echo the identical resolved CRS and worker count."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why is ctx.obj None inside my subcommand?",
          "acceptedAnswer": {"@type": "Answer", "text": "ctx.obj is only populated when the root @app.callback() actually runs. It stays None if you assign to ctx.obj in the wrong function, if a subcommand is invoked in a way that bypasses the callback, or if you forgot to set ctx.obj = state inside the callback body. Always assign state in the callback and add a guard that raises a clear usage error when ctx.obj is None."}
        },
        {
          "@type": "Question",
          "name": "How does a subcommand override a global option like --crs?",
          "acceptedAnswer": {"@type": "Answer", "text": "Give the subcommand its own optional --crs that defaults to None. When it is None, fall back to the shared value on ctx.obj; when the user passes it, the local value wins. This keeps a single global default while allowing per-command precedence without duplicating the flag on every command."}
        },
        {
          "@type": "Question",
          "name": "Should I use invoke_without_command on the callback?",
          "acceptedAnswer": {"@type": "Answer", "text": "Only if you want the root command to do something when called with no subcommand, such as printing help or a status summary. If invoke_without_command is True, the callback runs even with no subcommand, so guard against ctx.invoked_subcommand being None before doing subcommand-specific work."}
        },
        {
          "@type": "Question",
          "name": "Where should config-file values fit in the precedence chain?",
          "acceptedAnswer": {"@type": "Answer", "text": "Resolve precedence inside the callback in the order defaults, then config file, then environment variables, then command-line flags, with the flag winning last. Build the final state dataclass once there and every subcommand reads the already-merged result from ctx.obj rather than re-reading the file."}
        }
      ]
    }
  ]
}
</script>

# Sharing Global Options Across Geospatial Subcommands

Share global flags across Typer subcommands by declaring them on a root `@app.callback()`, resolving them once, and storing a state object on `ctx.obj`. Each subcommand then takes a `ctx: typer.Context` parameter and reads `ctx.obj` instead of redeclaring `--crs` or `--workers`. This is part of the [CLI Subcommand Organization for GIS Toolchains](/cli-architecture-design-patterns/cli-subcommand-organization/) guide within the broader [CLI Architecture & Design Patterns for Python GIS](/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install "typer>=0.12" pyogrio rasterio`
- GDAL 3.4+ available to rasterio and pyogrio (system package or conda/mamba)

The pattern here assumes you have already split commands into sub-apps. If you have not, read [CLI Subcommand Organization for GIS Toolchains](/cli-architecture-design-patterns/cli-subcommand-organization/) first, then return to wire shared options through them.

## The Problem: Redeclared Flags Drift Apart

Without a shared mechanism, every subcommand repeats `--crs`, `--workers`, and `--config`. A user must type `warp --crs EPSG:32633` and `dissolve --crs EPSG:32633` separately, and the two defaults inevitably drift when someone edits one command and forgets the other. The fix is to resolve each global option exactly once at the root and let every command downstream consume the same resolved value.

The diagram below shows how a single set of flags on the root callback fans out into both a raster and a vector subcommand through `ctx.obj`.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Global CLI options resolve once in the root callback into a shared state object, which both a raster warp subcommand and a vector dissolve subcommand read from ctx.obj" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Global options flow from the root callback into subcommands via ctx.obj</title>
  <desc>Command-line flags enter a root callback that resolves them into an AppState object stored on ctx dot obj. Two arrows carry that shared state into a raster subcommand and a vector subcommand, which both read the same CRS and worker count.</desc>
  <!-- Flags input -->
  <rect x="20" y="24" width="200" height="90" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="120" y="48" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Global flags</text>
  <text x="120" y="68" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">--crs EPSG:32633</text>
  <text x="120" y="84" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">--workers 4</text>
  <text x="120" y="100" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">--config app.toml</text>
  <!-- Callback -->
  <rect x="270" y="14" width="180" height="110" rx="6" fill="#a78bfa" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="360" y="40" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">@app.callback()</text>
  <text x="360" y="62" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">resolve once:</text>
  <text x="360" y="78" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">defaults then config</text>
  <text x="360" y="94" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">then env then flags</text>
  <text x="360" y="113" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">ctx.obj = state</text>
  <!-- Shared state -->
  <rect x="500" y="34" width="200" height="70" rx="6" fill="#818cf8" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="600" y="60" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">AppState</text>
  <text x="600" y="80" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">crs, workers, verbose</text>
  <text x="600" y="96" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">on ctx.obj</text>
  <!-- arrows to callback -->
  <line x1="220" y1="69" x2="266" y2="69" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="450" y1="69" x2="496" y2="69" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <!-- Subcommands -->
  <rect x="360" y="210" width="220" height="86" rx="6" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="470" y="236" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">raster warp</text>
  <text x="470" y="257" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">ctx: typer.Context</text>
  <text x="470" y="273" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">state = ctx.obj</text>
  <text x="470" y="289" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">rasterio.warp</text>
  <rect x="120" y="210" width="220" height="86" rx="6" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="230" y="236" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">vector dissolve</text>
  <text x="230" y="257" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">ctx: typer.Context</text>
  <text x="230" y="273" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">state = ctx.obj</text>
  <text x="230" y="289" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">pyogrio write</text>
  <!-- arrows from state to subcommands -->
  <line x1="600" y1="104" x2="470" y2="206" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="560" y1="104" x2="230" y2="206" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <defs>
    <marker id="ar" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The script below builds a single Typer app with a root callback that resolves `--crs`, `--workers`, `--config`, and `--verbose`, stores an `AppState` on `ctx.obj`, and exposes one raster and one vector subcommand that both consume the shared values. Copy it to `geotool.py` and run directly:

```python
#!/usr/bin/env python3
"""
Geospatial CLI with global options shared through ctx.obj.

Examples:
    python geotool.py --crs EPSG:32633 --workers 4 raster warp scene.tif out.tif
    python geotool.py --crs EPSG:3857 vector dissolve parcels.gpkg merged.gpkg
"""
from __future__ import annotations

import os
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import typer
from pyproj import CRS

app = typer.Typer(no_args_is_help=True, help="Geospatial toolchain with shared globals")
raster_app = typer.Typer(no_args_is_help=True, help="Raster commands")
vector_app = typer.Typer(no_args_is_help=True, help="Vector commands")
app.add_typer(raster_app, name="raster")
app.add_typer(vector_app, name="vector")


@dataclass(frozen=True)
class AppState:
    """Resolved global options shared by every subcommand."""
    crs: str
    workers: int
    verbose: bool


def _load_config(path: Optional[Path]) -> dict:
    """Read a TOML config file, returning an empty dict when absent."""
    if path is None or not path.exists():
        return {}
    with path.open("rb") as fh:
        return tomllib.load(fh).get("defaults", {})


@app.callback()
def main(
    ctx: typer.Context,
    crs: str = typer.Option("EPSG:4326", "--crs", help="Target CRS for all commands"),
    workers: int = typer.Option(1, "--workers", min=1, help="Worker process count"),
    config: Optional[Path] = typer.Option(None, "--config", help="TOML config file"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose logging"),
) -> None:
    """Resolve global options once and stash them on ctx.obj.

    Precedence is defaults, then config file, then environment, then flags.
    Typer has already applied flags over its own defaults, so we only fill
    from the config/env layers when the caller left a value at its default.
    """
    cfg = _load_config(config)
    resolved_crs = crs
    if resolved_crs == "EPSG:4326":  # untouched Typer default
        resolved_crs = os.environ.get("GEOTOOL_CRS", cfg.get("crs", resolved_crs))

    # Validate the CRS at the boundary so no subcommand sees a bad code.
    try:
        CRS.from_user_input(resolved_crs)
    except Exception:
        typer.secho(f"Invalid CRS: {resolved_crs}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=10)  # 10 = CRS mismatch/invalid

    ctx.obj = AppState(crs=resolved_crs, workers=workers, verbose=verbose)


def get_state(ctx: typer.Context) -> AppState:
    """Fetch shared state, failing loudly if the callback never ran."""
    if ctx.obj is None:
        typer.secho("Global options were not initialised.", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2)  # 2 = usage error
    return ctx.obj


@raster_app.command("warp")
def raster_warp(
    ctx: typer.Context,
    src: Path = typer.Argument(..., exists=True, help="Source GeoTIFF"),
    dst: Path = typer.Argument(..., help="Destination GeoTIFF"),
    crs: Optional[str] = typer.Option(None, "--crs", help="Override global CRS"),
) -> None:
    """Reproject a raster, reading CRS and workers from the shared state."""
    state = get_state(ctx)
    target_crs = crs or state.crs  # local flag wins, else fall back to global
    if state.verbose:
        typer.echo(f"[raster warp] crs={target_crs} workers={state.workers}")

    import rasterio
    from rasterio.warp import calculate_default_transform, reproject, Resampling

    with rasterio.open(src) as ds:
        transform, width, height = calculate_default_transform(
            ds.crs, target_crs, ds.width, ds.height, *ds.bounds
        )
        profile = ds.profile.copy()
        profile.update(crs=target_crs, transform=transform, width=width, height=height)
        with rasterio.open(dst, "w", **profile) as out:
            for band in range(1, ds.count + 1):
                reproject(
                    source=rasterio.band(ds, band),
                    destination=rasterio.band(out, band),
                    dst_crs=target_crs,
                    resampling=Resampling.bilinear,
                    num_threads=state.workers,  # shared worker budget
                )
    typer.echo(f"Reprojected {src.name} -> {dst.name} in {target_crs}")


@vector_app.command("dissolve")
def vector_dissolve(
    ctx: typer.Context,
    src: Path = typer.Argument(..., exists=True, help="Source vector dataset"),
    dst: Path = typer.Argument(..., help="Destination vector dataset"),
    by: str = typer.Option("region", "--by", help="Attribute to dissolve on"),
) -> None:
    """Dissolve features, reprojecting to the shared global CRS first."""
    state = get_state(ctx)
    if state.verbose:
        typer.echo(f"[vector dissolve] crs={state.crs} workers={state.workers}")

    import geopandas as gpd

    gdf = gpd.read_file(src, engine="pyogrio")  # prefer pyogrio over fiona
    gdf = gdf.to_crs(state.crs)                  # same CRS the raster command uses
    dissolved = gdf.dissolve(by=by)
    dissolved.to_file(dst, engine="pyogrio")
    typer.echo(f"Dissolved {len(gdf)} -> {len(dissolved)} features in {state.crs}")


if __name__ == "__main__":
    app()
```

## Step Annotations

1. **`@app.callback()` on the root app** — Typer treats the callback as the code that runs before any subcommand. Declaring `--crs`, `--workers`, `--config`, and `--verbose` here makes them global: they attach to the root command, not to `raster warp` or `vector dissolve`, so the user types them once before the subcommand name.

2. **`ctx.obj = AppState(...)`** — `ctx.obj` is Typer's (and Click's) free-form slot for passing data down the command tree. Assigning the frozen `AppState` dataclass here is what makes the resolved values visible to every subcommand. The dataclass is frozen so no command can mutate the shared globals mid-run.

3. **Precedence resolution inside the callback** — The callback merges layers in the order defaults, config file, environment, then flags. Because Typer has already overlaid the command-line flag onto its own default, the code only reaches for the config or environment value when the flag still equals the untouched default. This is the same precedence chain covered in [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/).

4. **`CRS.from_user_input()` validation** — Validating the CRS once at the boundary means no subcommand ever receives an unparseable code. A bad code exits with domain code `10` (CRS mismatch) instead of surfacing a rasterio traceback three calls deep.

5. **`get_state(ctx)` helper** — Every subcommand calls this instead of touching `ctx.obj` directly. It centralises the None-guard so a subcommand invoked without the callback fails with a clear usage error (exit code `2`) rather than an `AttributeError`.

6. **Local `--crs` on `raster warp`** — The subcommand declares its own optional `--crs` defaulting to `None`. The line `target_crs = crs or state.crs` gives local precedence: pass `--crs` after `warp` to override just that command, otherwise inherit the global. The vector command omits the local override and always uses the shared CRS.

7. **`num_threads=state.workers`** — The shared worker count flows straight into rasterio's `reproject`, so `--workers 4` set once at the root governs raster parallelism without the subcommand ever redeclaring the flag.

## Named Gotcha: `ctx.obj` Is None When the Callback Did Not Run

The most common failure is a subcommand raising `AttributeError: 'NoneType' object has no attribute 'crs'`. That happens because `ctx.obj` is only populated when the root `@app.callback()` actually executes. Two situations trip people up. First, assigning state to the wrong object — for example setting a module-level global inside the callback instead of `ctx.obj`, so the value never travels down the tree. Second, adding `invoke_without_command=True` to the callback and then running the app with no subcommand: the callback runs, but you may branch away before reaching `ctx.obj = state`, leaving it None for a later programmatic invocation.

The fix has two parts. Always assign `ctx.obj = AppState(...)` as the last statement of the callback so it runs on every path, and never read `ctx.obj` directly in a subcommand — route every access through a `get_state(ctx)` helper that raises `typer.Exit(code=2)` when `ctx.obj is None`. If you do enable `invoke_without_command=True` to print a status summary, guard that branch with `if ctx.invoked_subcommand is None:` and still set `ctx.obj` first. This turns a cryptic `AttributeError` into an explicit, testable usage error.

## Verification

Run both subcommands with the same global flags and confirm they report the identical resolved CRS and worker count:

```bash
# Global flags resolve once; both commands should echo EPSG:32633 and workers=4
python geotool.py --crs EPSG:32633 --workers 4 --verbose \
    raster warp scene.tif scene_utm.tif
python geotool.py --crs EPSG:32633 --workers 4 --verbose \
    vector dissolve parcels.gpkg parcels_merged.gpkg

# Local override wins only for the command it is attached to
python geotool.py --crs EPSG:4326 --verbose \
    raster warp scene.tif scene_web.tif --crs EPSG:3857
# -> [raster warp] crs=EPSG:3857 workers=1

# Missing callback path: a bad global CRS exits 10, not a traceback
python geotool.py --crs EPSG:99999 raster warp scene.tif out.tif; echo "exit=$?"
# -> Invalid CRS: EPSG:99999   /   exit=10
```

Matching CRS lines from both the raster and vector runs confirm the global options propagated through `ctx.obj`. A `--verbose` line showing the local `EPSG:3857` on the third run confirms per-command precedence works without disturbing the shared default.

## FAQ

<details class="faq-item">
<summary><span>Why is <code>ctx.obj</code> None inside my subcommand?</span></summary>

`ctx.obj` is only populated when the root `@app.callback()` actually runs. It stays `None` if you assign to the wrong object in the callback, if a subcommand is invoked in a way that bypasses the callback, or if you forgot the `ctx.obj = state` line. Always assign state in the callback and route reads through a helper that raises a clear usage error when `ctx.obj` is None.
</details>

<details class="faq-item">
<summary><span>How does a subcommand override a global option like <code>--crs</code>?</span></summary>

Give the subcommand its own optional `--crs` that defaults to `None`. When it is `None`, fall back to the shared value on `ctx.obj`; when the user passes it, the local value wins via `crs or state.crs`. This keeps one global default while allowing per-command precedence without duplicating the flag on every command.
</details>

<details class="faq-item">
<summary><span>Should I use <code>invoke_without_command</code> on the callback?</span></summary>

Only if you want the root command to do something when called with no subcommand, such as printing a status summary. If `invoke_without_command=True`, the callback runs even with no subcommand, so guard against `ctx.invoked_subcommand` being `None` before doing subcommand-specific work, and still set `ctx.obj` first.
</details>

<details class="faq-item">
<summary>Where should config-file values fit in the precedence chain?</summary>

Resolve precedence inside the callback in the order defaults, then config file, then environment variables, then command-line flags, with the flag winning last. Build the final `AppState` once there so every subcommand reads the already-merged result from `ctx.obj` rather than re-reading the file. See [Environment Variable Sync](/cli-architecture-design-patterns/environment-variable-sync/) for wiring the env layer cleanly.
</details>

---

## Related

- [CLI Subcommand Organization for GIS Toolchains](/cli-architecture-design-patterns/cli-subcommand-organization/) — parent guide covering sub-app layout, command naming, and shared-state patterns for geospatial toolchains
- [Structuring a Multi-Command GDAL CLI with Typer Sub-Apps](/cli-architecture-design-patterns/cli-subcommand-organization/structuring-a-multi-command-gdal-cli-with-typer-sub-apps/) — how to split raster and vector commands into sub-apps before sharing globals through them
