---
title: "Layering TOML and Env Config for Raster Pipelines"
description: "Resolve raster pipeline settings across defaults, a TOML file, environment variables, and CLI flags with a deterministic, testable precedence chain."
slug: "layering-toml-and-env-config-for-raster-pipelines"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Configuration File Management for GIS CLI Tools"
    url: "/cli-architecture-design-patterns/configuration-file-management/"
  - label: "Layering TOML and Env Config for Raster Pipelines"
    url: "/cli-architecture-design-patterns/configuration-file-management/layering-toml-and-env-config-for-raster-pipelines/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Layering TOML and Env Config for Raster Pipelines",
      "description": "Resolve raster pipeline settings across defaults, a TOML file, environment variables, and CLI flags with a deterministic, testable precedence chain.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Configuration File Management for GIS CLI Tools", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/"},
        {"@type": "ListItem", "position": 3, "name": "Layering TOML and Env Config for Raster Pipelines", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/layering-toml-and-env-config-for-raster-pipelines/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Layer TOML, environment variables, and CLI flags for a raster pipeline",
      "step": [
        {"@type": "HowToStep", "name": "Define a typed default config", "text": "Declare a dataclass with fields like target_epsg, max_workers, chunk_size, and output_dir carrying the built-in defaults."},
        {"@type": "HowToStep", "name": "Read the TOML table", "text": "Parse pyproject.toml or a standalone file with tomllib and pull the tool.mytool table if it exists."},
        {"@type": "HowToStep", "name": "Overlay prefixed environment variables", "text": "Scan os.environ for MYTOOL_ prefixed keys and coerce each string to the target field type."},
        {"@type": "HowToStep", "name": "Apply explicit CLI overrides last", "text": "Merge only the flags the user actually passed so unset flags never clobber lower layers."},
        {"@type": "HowToStep", "name": "Print the resolved config", "text": "Emit the final dataclass with per-field provenance so the effective settings are auditable before the run starts."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does tomllib read integers correctly but environment variables do not?",
          "acceptedAnswer": {"@type": "Answer", "text": "tomllib parses TOML types natively, so an unquoted 4 becomes a Python int and a quoted \"4\" stays a str. Environment variables are always strings, so MYTOOL_MAX_WORKERS=4 arrives as the string '4'. You must coerce env values to each dataclass field's declared type before merging, or comparisons and arithmetic downstream will misbehave."}
        },
        {
          "@type": "Question",
          "name": "How do I stop unset CLI flags from overwriting my TOML values?",
          "acceptedAnswer": {"@type": "Answer", "text": "Never default your CLI flags to the config defaults. Default them to None and merge only the keys whose value is not None. That way a flag the user omitted contributes nothing to the final layer and the TOML or env value survives as the resolved setting."}
        },
        {
          "@type": "Question",
          "name": "Should the TOML file live in pyproject.toml or a separate file?",
          "acceptedAnswer": {"@type": "Answer", "text": "Both work with the same loader. Reusing pyproject.toml under a tool.mytool table keeps project-scoped defaults with the code, while a standalone raster.toml suits per-run or per-dataset overrides. Resolve the standalone file after pyproject so it wins, keeping the defaults-to-file-to-env-to-flag order intact."}
        },
        {
          "@type": "Question",
          "name": "How can I tell which layer supplied each final value?",
          "acceptedAnswer": {"@type": "Answer", "text": "Track provenance while you merge. Record the source name alongside each field as later layers overwrite earlier ones, then print field, value, and source together. This turns a silent CRS mismatch into a one-line answer about whether the value came from the default, the TOML file, an env var, or a flag."}
        }
      ]
    }
  ]
}
</script>

# Layering TOML and Env Config for Raster Pipelines

To layer configuration for a raster CLI, resolve settings in a fixed order: built-in defaults, then a `[tool.mytool]` TOML table read with `tomllib`, then `MYTOOL_`-prefixed environment variables, then explicit command-line flags. Each layer overwrites only the keys it actually supplies, and the last writer wins per field. This page is part of the [Configuration File Management for GIS CLI Tools](/cli-architecture-design-patterns/configuration-file-management/) guide within the broader CLI Architecture & Design Patterns reference.

The hard part is not reading a file. It is making precedence deterministic and testable so a `target_epsg` set in a deployment env var never gets silently reset by a stale default, and so a single `--max-workers` flag on the command line always wins.

## Prerequisites

- Python 3.11 or later — `tomllib` is in the standard library from 3.11; on 3.10 install `tomli` and import it as `tomllib`
- No third-party parser needed for reading; `tomllib` is read-only by design
- GDAL / rasterio only matters at run time — the loader here is pure standard library, which keeps it trivial to unit-test without a raster fixture

For the wider file-versus-flag trade-offs, start with the [Configuration File Management for GIS CLI Tools](/cli-architecture-design-patterns/configuration-file-management/) overview. This page focuses narrowly on the TOML-plus-env precedence chain rather than file format choice.

## The Precedence Chain

Configuration resolution is a fold over four layers. Each layer is a partial mapping — it may set some fields and stay silent on others. You start from a fully-populated defaults object and apply each subsequent layer as an overwrite of only its present keys. The diagram shows how a single field, `target_epsg`, threads through the four layers and where the winning value comes from.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Configuration precedence chain resolving target_epsg across four layers: defaults, TOML file, environment variables, and CLI flags, with CLI flags winning" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Precedence chain: defaults, TOML, env, flags</title>
  <desc>Four stacked layers from lowest to highest priority. Defaults set target_epsg to 4326, the TOML file overrides it to 3857, an environment variable is silent, and a CLI flag sets 32633 which becomes the resolved value.</desc>
  <defs>
    <marker id="down" markerWidth="8" markerHeight="8" refX="4" refY="6" orient="auto">
      <path d="M0,0 L8,0 L4,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
  <!-- axis label -->
  <text x="28" y="49" font-size="10.5" fill="currentColor" opacity="0.7" text-anchor="middle" transform="rotate(90 28 49)">lowest priority</text>
  <text x="28" y="283" font-size="10.5" fill="currentColor" opacity="0.7" text-anchor="middle" transform="rotate(90 28 283)">highest priority</text>
  <!-- Layer 1: defaults -->
  <rect x="70" y="20" width="560" height="58" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.2"/>
  <text x="90" y="44" font-size="12" font-weight="600" fill="currentColor">1. Defaults (dataclass)</text>
  <text x="90" y="64" font-size="10.5" fill="currentColor" opacity="0.8">target_epsg = 4326</text>
  <text x="610" y="55" text-anchor="end" font-size="10.5" fill="currentColor" opacity="0.6">baseline</text>
  <line x1="350" y1="78" x2="350" y2="96" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#down)"/>
  <!-- Layer 2: TOML -->
  <rect x="70" y="98" width="560" height="58" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="90" y="122" font-size="12" font-weight="600" fill="currentColor">2. TOML [tool.mytool]</text>
  <text x="90" y="142" font-size="10.5" fill="currentColor" opacity="0.8">target_epsg = 3857</text>
  <text x="610" y="133" text-anchor="end" font-size="10.5" fill="currentColor" opacity="0.6">overwrites default</text>
  <line x1="350" y1="156" x2="350" y2="174" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#down)"/>
  <!-- Layer 3: env -->
  <rect x="70" y="176" width="560" height="58" rx="6" fill="#a78bfa" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="90" y="200" font-size="12" font-weight="600" fill="currentColor">3. Env MYTOOL_TARGET_EPSG</text>
  <text x="90" y="220" font-size="10.5" fill="currentColor" opacity="0.8">(unset — layer is silent)</text>
  <text x="610" y="211" text-anchor="end" font-size="10.5" fill="currentColor" opacity="0.6">no change</text>
  <line x1="350" y1="234" x2="350" y2="252" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#down)"/>
  <!-- Layer 4: flags -->
  <rect x="70" y="254" width="560" height="58" rx="6" fill="#15803d" fill-opacity="0.1" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="90" y="278" font-size="12" font-weight="600" fill="currentColor">4. CLI flag --target-epsg</text>
  <text x="90" y="298" font-size="10.5" fill="currentColor" opacity="0.85">target_epsg = 32633  →  resolved</text>
  <text x="610" y="289" text-anchor="end" font-size="10.5" fill="#15803d" opacity="0.9">wins</text>
</svg>

## Complete Working Implementation

The loader below is self-contained standard library. It reads a `[tool.mytool]` table from a TOML file, overlays `MYTOOL_`-prefixed environment variables with type coercion, then applies only the CLI overrides the caller passed. It also records where each field's final value came from:

```python
#!/usr/bin/env python3
"""
Layered configuration for a raster pipeline CLI.
Order (lowest to highest): defaults -> TOML -> env -> CLI flags.
Requires Python 3.11+ for tomllib.
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Any


ENV_PREFIX = "MYTOOL_"
TOML_TABLE = ("tool", "mytool")


@dataclass(frozen=True)
class RasterConfig:
    target_epsg: int = 4326          # output CRS as a bare EPSG code
    max_workers: int = 4             # parallel warp workers
    chunk_size: int = 512            # tile edge in pixels for windowed reads
    output_dir: Path = Path("./out")  # where reprojected rasters land
    overwrite: bool = False          # replace existing outputs


def _coerce(field_type: Any, raw: str) -> Any:
    """Coerce a raw string (from env) to the dataclass field's type.

    Environment values are ALWAYS strings; TOML values are already typed.
    bool needs special handling because bool("0") is True in Python.
    """
    if field_type is bool:
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    if field_type is int:
        return int(raw)
    if field_type is Path:
        return Path(raw)
    return raw  # str fields pass through unchanged


def _load_toml(path: Path) -> dict[str, Any]:
    """Return the [tool.mytool] table, or {} if the file/table is absent."""
    if not path.is_file():
        return {}
    with path.open("rb") as fh:          # tomllib requires binary mode
        doc = tomllib.load(fh)
    table: Any = doc
    for key in TOML_TABLE:
        table = table.get(key, {}) if isinstance(table, dict) else {}
    return table if isinstance(table, dict) else {}


def _load_env() -> dict[str, str]:
    """Collect MYTOOL_-prefixed vars, lowercased to field names."""
    out: dict[str, str] = {}
    for key, value in os.environ.items():
        if key.startswith(ENV_PREFIX):
            out[key[len(ENV_PREFIX):].lower()] = value
    return out


def load_config(
    toml_path: Path = Path("pyproject.toml"),
    cli_overrides: dict[str, Any] | None = None,
) -> tuple[RasterConfig, dict[str, str]]:
    """Resolve config across all four layers.

    Returns the final RasterConfig plus a provenance map recording which
    layer supplied each field's winning value.
    """
    field_types = {f.name: f.type for f in fields(RasterConfig)}
    valid = set(field_types)

    config = RasterConfig()                      # layer 1: defaults
    provenance = {name: "default" for name in valid}

    # layer 2: TOML — values are already correctly typed by tomllib
    for name, value in _load_toml(toml_path).items():
        if name in valid:
            coerced = Path(value) if field_types[name] is Path else value
            config = replace(config, **{name: coerced})
            provenance[name] = "toml"

    # layer 3: env — every value is a string, so coerce per field type
    for name, raw in _load_env().items():
        if name in valid:
            config = replace(config, **{name: _coerce(field_types[name], raw)})
            provenance[name] = "env"

    # layer 4: CLI flags — merge ONLY keys the user actually set (not None)
    for name, value in (cli_overrides or {}).items():
        if name in valid and value is not None:
            config = replace(config, **{name: value})
            provenance[name] = "flag"

    return config, provenance


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Raster pipeline runner")
    parser.add_argument("--config", type=Path, default=Path("pyproject.toml"))
    # CLI flags DEFAULT TO None so an unset flag never clobbers lower layers.
    parser.add_argument("--target-epsg", type=int, default=None)
    parser.add_argument("--max-workers", type=int, default=None)
    parser.add_argument("--chunk-size", type=int, default=None)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--overwrite", action="store_true", default=None)
    args = parser.parse_args()

    overrides = {
        "target_epsg": args.target_epsg,
        "max_workers": args.max_workers,
        "chunk_size": args.chunk_size,
        "output_dir": args.output_dir,
        "overwrite": args.overwrite,
    }
    cfg, prov = load_config(args.config, overrides)

    print("Resolved raster pipeline configuration:")
    for f in fields(cfg):
        print(f"  {f.name:<12} = {getattr(cfg, f.name)!r:<20} (from {prov[f.name]})")
```

A matching `pyproject.toml` fragment the loader reads:

```toml
[tool.mytool]
target_epsg = 3857
max_workers = 8
output_dir = "./reprojected"
```

## Step Annotations

1. **`@dataclass(frozen=True)` with typed defaults** — The dataclass is both the schema and the defaults layer. Freezing it forces every layer to produce a *new* config via `dataclasses.replace`, which makes each overwrite explicit and keeps the merge free of hidden mutation. The field types (`int`, `Path`, `bool`) drive coercion later.

2. **`_coerce` handles the string-to-type gap** — TOML gives you real types, but `os.environ` values are always strings. This function maps each raw string to its field's declared type. The `bool` branch is the load-bearing one: `bool("0")` is `True` in Python, so a naive cast would treat `MYTOOL_OVERWRITE=0` as enabling overwrite.

3. **`_load_toml` opens in binary mode** — `tomllib.load` requires a file opened with `"rb"`; passing a text handle raises `TypeError`. Walking the `("tool", "mytool")` path with `.get(..., {})` means a missing file or missing table yields an empty dict rather than an exception, so the layer simply contributes nothing.

4. **`_load_env` strips the prefix and lowercases** — `MYTOOL_MAX_WORKERS` becomes `max_workers`, aligning with the dataclass field name. Namespacing with `MYTOOL_` avoids collisions with unrelated environment variables such as `GDAL_NUM_THREADS`, a point covered in depth by [Environment Variable Sync](/cli-architecture-design-patterns/environment-variable-sync/).

5. **CLI flags default to `None`** — The merge applies a flag only when its value is not `None`. This is what makes an *omitted* `--max-workers` leave the TOML value intact instead of resetting it. Coupling the parser with a typed config layer is exactly the boundary [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) is built to enforce; here plain `argparse` mirrors the same discipline.

6. **The provenance map** — Each layer updates `provenance[name]` as it overwrites a field. Printing field, value, and source together turns "why is my output CRS wrong?" into a one-line answer.

## Named Gotcha: Environment Values Are Always Strings

The single most common failure is trusting that an environment variable arrives with the type you wrote in TOML. It does not. Set `MYTOOL_MAX_WORKERS=8` and, without coercion, `config.max_workers` is the string `"8"` — so `range(config.max_workers)` raises `TypeError` and `config.max_workers > 4` raises on the comparison. The subtler trap is boolean flags: `MYTOOL_OVERWRITE=0` is meant to *disable* overwrite, but `bool("0")` is `True`, so the pipeline clobbers existing rasters.

The fix is the `_coerce` function above. It routes `int` fields through `int()`, `Path` fields through `Path()`, and treats only the explicit truthy tokens `1`, `true`, `yes`, and `on` as `True` for booleans. TOML values skip coercion because `tomllib` already types them — an unquoted `target_epsg = 3857` is an `int`, while a quoted `"3857"` would stay a `str`, which is itself a reason to keep EPSG codes unquoted in your TOML.

## Verification

Run the module with a layered setup and confirm each field resolves from the layer you expect:

```bash
# TOML sets max_workers=8; env overrides target_epsg; a flag overrides chunk_size.
export MYTOOL_TARGET_EPSG=32633
python config_loader.py --chunk-size 1024

# Expected output:
#   target_epsg  = 32633                (from env)
#   max_workers  = 8                    (from toml)
#   chunk_size   = 1024                 (from flag)
#   output_dir   = PosixPath('reprojected')  (from toml)
#   overwrite    = False                (from default)
```

For an automated regression check that precedence never silently changes, assert on the resolved values directly:

```python
import os
from pathlib import Path
from config_loader import load_config

os.environ["MYTOOL_TARGET_EPSG"] = "32633"
cfg, prov = load_config(
    toml_path=Path("pyproject.toml"),
    cli_overrides={"chunk_size": 1024, "max_workers": None},
)

assert cfg.target_epsg == 32633 and prov["target_epsg"] == "env"
assert cfg.chunk_size == 1024 and prov["chunk_size"] == "flag"
assert prov["max_workers"] == "toml"      # unset flag did NOT overwrite
assert isinstance(cfg.max_workers, int)   # coercion held
print("precedence chain verified")
```

The type assertion is the important one: it catches the string-coercion regression before it reaches GDAL, where a mistyped `max_workers` surfaces as an opaque worker-pool error rather than a config bug.

## FAQ

<details class="faq-item">
<summary>Why does tomllib read integers correctly but environment variables do not?</summary>

`tomllib` parses TOML types natively, so an unquoted `4` becomes a Python `int` and a quoted `"4"` stays a `str`. Environment variables are always strings, so `MYTOOL_MAX_WORKERS=4` arrives as the string `'4'`. You must coerce env values to each dataclass field's declared type before merging, or comparisons and arithmetic downstream will misbehave.
</details>

<details class="faq-item">
<summary>How do I stop unset CLI flags from overwriting my TOML values?</summary>

Never default your CLI flags to the config defaults. Default them to `None` and merge only the keys whose value is not `None`. That way a flag the user omitted contributes nothing to the final layer and the TOML or env value survives as the resolved setting.
</details>

<details class="faq-item">
<summary>Should the TOML file live in pyproject.toml or a separate file?</summary>

Both work with the same loader. Reusing `pyproject.toml` under a `[tool.mytool]` table keeps project-scoped defaults with the code, while a standalone `raster.toml` suits per-run or per-dataset overrides. Resolve the standalone file after `pyproject.toml` so it wins, keeping the defaults-to-file-to-env-to-flag order intact.
</details>

<details class="faq-item">
<summary>How can I tell which layer supplied each final value?</summary>

Track provenance while you merge. Record the source name alongside each field as later layers overwrite earlier ones, then print field, value, and source together. This turns a silent CRS mismatch into a one-line answer about whether the value came from the default, the TOML file, an env var, or a flag.
</details>

---

## Related

- [Configuration File Management for GIS CLI Tools](/cli-architecture-design-patterns/configuration-file-management/) — parent guide covering file formats, precedence, and reload strategies for geospatial CLI tools
- [Managing YAML Configs for Geospatial CLI Workflows](/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/) — the YAML counterpart when your pipeline needs anchors, comments, or nested profiles instead of TOML
