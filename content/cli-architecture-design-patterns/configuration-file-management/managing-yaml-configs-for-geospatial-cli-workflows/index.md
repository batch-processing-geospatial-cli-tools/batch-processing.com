---
title: "Managing YAML Configs for Geospatial CLI Workflows"
description: "Load, validate, and apply YAML configs in Python GIS CLIs using PyYAML and Pydantic v2 — schema enforcement, CRS validation, GDAL env injection, and override chains."
slug: "managing-yaml-configs-for-geospatial-cli-workflows"
type: "long_tail"
breadcrumb: "Managing YAML Configs"
datePublished: "2025-03-10"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
[
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Managing YAML Configs for Geospatial CLI Workflows",
    "description": "How to load, validate, and apply YAML configuration files in Python GIS CLIs using PyYAML and Pydantic v2 — covering schema enforcement, CRS validation, GDAL env injection, and multi-environment override chains.",
    "datePublished": "2025-03-10",
    "dateModified": "2026-06-23",
    "author": {"@type": "Organization", "name": "batch-processing.com"}
  },
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
      {"@type": "ListItem", "position": 2, "name": "Configuration File Management", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/"},
      {"@type": "ListItem", "position": 3, "name": "Managing YAML Configs for Geospatial CLI Workflows", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/"}
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": "How to Manage YAML Configs for Geospatial CLI Workflows",
    "step": [
      {"@type": "HowToStep", "position": 1, "text": "Install PyYAML, Pydantic v2, and Click into your project environment."},
      {"@type": "HowToStep", "position": 2, "text": "Define nested Pydantic models for GdalEnv, SpatialParams, and BatchConfig with field-level validators for EPSG codes and path resolution."},
      {"@type": "HowToStep", "position": 3, "text": "Load the YAML file with yaml.safe_load and pass the resulting dict into BatchConfig for validation."},
      {"@type": "HowToStep", "position": 4, "text": "Apply CLI flag overrides into the raw dict before constructing the model so that the flag wins the precedence chain."},
      {"@type": "HowToStep", "position": 5, "text": "Call apply_gdal_env() to inject GDAL_CACHEMAX and GDAL_NUM_THREADS before any rasterio or GDAL I/O."},
      {"@type": "HowToStep", "position": 6, "text": "Log config.model_dump_json() at startup so CI logs capture the exact runtime parameters used for each batch run."}
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Why use PyYAML instead of tomllib for geospatial CLIs?",
        "acceptedAnswer": {"@type": "Answer", "text": "YAML's multi-line strings and inline comments make it well-suited for documenting spatial parameters such as bounding boxes, PROJ strings, and glob patterns. TOML is preferable for flat key-value configs, but YAML wins when the config tree is deeply nested or frequently edited by non-developers."}
      },
      {
        "@type": "Question",
        "name": "How do I override a nested YAML key from a Click CLI flag?",
        "acceptedAnswer": {"@type": "Answer", "text": "Read the YAML into a plain dict with yaml.safe_load, then mutate the relevant nested key before passing the dict to your Pydantic model. This keeps Pydantic as the single validation gateway and ensures CLI flags always win the precedence chain."}
      },
      {
        "@type": "Question",
        "name": "When should I call apply_gdal_env() relative to rasterio imports?",
        "acceptedAnswer": {"@type": "Answer", "text": "Call apply_gdal_env() before any rasterio.open(), osgeo.gdal, or pyogrio operation. GDAL reads environment variables at the point of first use, so injecting them after a dataset has been opened has no effect on that handle."}
      },
      {
        "@type": "Question",
        "name": "Can a Pydantic validator check that a path glob actually matches files?",
        "acceptedAnswer": {"@type": "Answer", "text": "Yes, but do this in a @model_validator(mode='after') rather than a field_validator, because the glob needs both the workspace and the input_glob fields to be resolved first. Raise a ValueError listing the zero-match pattern so the operator sees a clear error message before the batch job starts."}
      },
      {
        "@type": "Question",
        "name": "How do I handle YAML configs that were written for an older schema version?",
        "acceptedAnswer": {"@type": "Answer", "text": "Add a schema_version key with a default of 1. In a @model_validator(mode='before') check the version and remap any legacy keys to their new names before Pydantic validates the rest of the model. This preserves backward compatibility without forking your validation logic."}
      }
    ]
  }
]
</script>

# Managing YAML Configs for Geospatial CLI Workflows

Use `PyYAML` with `Pydantic` v2 to load, validate, and apply a YAML config in a Python GIS CLI: parse the file with `yaml.safe_load`, construct a typed `BatchConfig` model, apply GDAL environment variables before any I/O, and inject CLI flag overrides into the raw dict before model construction so that the flag always wins. This self-contained pattern — part of the [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) guide — prevents silent CRS errors and coordinate corruptions that only surface after hours of raster processing.

## Prerequisites

```bash
pip install "pyyaml>=6.0" "pydantic>=2.0" "click>=8.1"
```

You need Python 3.11+, a working GDAL installation visible to the shell, and a basic grasp of [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/). If you are still choosing between Click and Typer for your project, review [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) before committing to the CLI layer shown here.

## Config Precedence: How the Override Chain Works

Before writing any code it helps to see how the four layers compose. CLI flags override environment variables, which override the YAML file, which overrides schema defaults — the same four-layer model described in [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/#core-resolution-architecture).

<svg viewBox="0 0 640 220" role="img" aria-label="Configuration precedence chain: CLI flags override env vars, which override YAML file, which override schema defaults" xmlns="http://www.w3.org/2000/svg" style="max-width:100%; height:auto; display:block; margin:1.5rem auto;" >
  <title>Configuration override precedence for geospatial CLI workflows</title>
  <desc>Four stacked layers from top (highest priority) to bottom (lowest): CLI flags, Environment variables, YAML config file, and Pydantic schema defaults. Arrows show each layer overrides the one below it.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Layer boxes -->
  <rect x="160" y="12"  width="320" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.9"/>
  <rect x="160" y="62"  width="320" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.75"/>
  <rect x="160" y="112" width="320" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <rect x="160" y="162" width="320" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
  <!-- Labels -->
  <text x="320" y="35"  text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">CLI flags  (highest priority)</text>
  <text x="320" y="85"  text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor">Environment variables</text>
  <text x="320" y="135" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor">YAML config file</text>
  <text x="320" y="185" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" opacity="0.7">Pydantic schema defaults  (lowest priority)</text>
  <!-- Override arrows on the right -->
  <line x1="500" y1="48"  x2="500" y2="62"  stroke="currentColor" stroke-width="1.5" opacity="0.55" marker-end="url(#arrow)"/>
  <line x1="500" y1="98"  x2="500" y2="112" stroke="currentColor" stroke-width="1.5" opacity="0.55" marker-end="url(#arrow)"/>
  <line x1="500" y1="148" x2="500" y2="162" stroke="currentColor" stroke-width="1.5" opacity="0.55" marker-end="url(#arrow)"/>
  <!-- Side labels -->
  <text x="520" y="58"  font-size="10" font-family="inherit" fill="currentColor" opacity="0.55">overrides</text>
  <text x="520" y="108" font-size="10" font-family="inherit" fill="currentColor" opacity="0.55">overrides</text>
  <text x="520" y="158" font-size="10" font-family="inherit" fill="currentColor" opacity="0.55">overrides</text>
</svg>

The implementation below encodes this chain directly: CLI flag values are merged into the raw dict before Pydantic ever sees it, so the model has no special-case logic for "did the user pass `--threads`?".

## Complete Working Implementation

The YAML file your team authors looks like this:

```yaml
# pipeline.yaml
workspace: /data/rasters
input_glob: "**/*.tif"
output_dir: /data/output

gdal:
  GDAL_CACHEMAX: 512
  GDAL_NUM_THREADS: 8
  OGR_ENABLE_PARTIAL_REPROJECTION: true

spatial:
  src_crs: "EPSG:4326"
  dst_crs: "EPSG:3857"
  resampling: bilinear
  tile_size: 512
```

The Python module that loads and validates it:

```python
#!/usr/bin/env python3
"""geo_pipeline.py — validated YAML config loader for geospatial batch CLIs."""
import glob
import os
from pathlib import Path
from typing import List, Optional

import click
import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator


# ── Schema models ─────────────────────────────────────────────────────────────

class GdalEnv(BaseModel):
    """GDAL/OGR runtime settings injected via os.environ before any I/O."""
    GDAL_CACHEMAX: int = Field(default=256, ge=64, le=4096,
                               description="Raster block cache in MB")
    GDAL_NUM_THREADS: int = Field(default=4, ge=1, le=64)
    OGR_ENABLE_PARTIAL_REPROJECTION: bool = Field(default=True)


class SpatialParams(BaseModel):
    src_crs: str = Field(default="EPSG:4326")
    dst_crs: str = Field(default="EPSG:3857")
    resampling: str = Field(default="bilinear")
    tile_size: int = Field(default=512, ge=128, le=4096)

    @field_validator("src_crs", "dst_crs")
    @classmethod
    def validate_crs(cls, v: str) -> str:
        if not (v.upper().startswith("EPSG:") or v.upper().startswith("PROJ:")):
            raise ValueError(f"CRS must begin with EPSG: or PROJ:, got {v!r}")
        return v

    @field_validator("resampling")
    @classmethod
    def validate_resampling(cls, v: str) -> str:
        valid = {"nearest", "bilinear", "cubic", "cubicspline", "lanczos",
                 "average", "mode"}
        if v.lower() not in valid:
            raise ValueError(f"resampling must be one of {sorted(valid)}")
        return v.lower()


class BatchConfig(BaseModel):
    workspace: Path
    input_glob: str
    output_dir: Path
    gdal: GdalEnv = Field(default_factory=GdalEnv)
    spatial: SpatialParams = Field(default_factory=SpatialParams)

    @field_validator("workspace", "output_dir", mode="before")
    @classmethod
    def resolve_paths(cls, v: object) -> Path:
        return Path(str(v)).expanduser().resolve()

    def apply_gdal_env(self) -> None:
        """Inject GDAL settings into os.environ before any rasterio or GDAL call."""
        for key, value in self.gdal.model_dump().items():
            os.environ[key] = str(value)

    def resolve_inputs(self) -> List[Path]:
        """Expand input_glob relative to workspace into a sorted, deduplicated list."""
        pattern = str(self.workspace / self.input_glob)
        return sorted({Path(p) for p in glob.glob(pattern, recursive=True)})


# ── CLI entry-point ────────────────────────────────────────────────────────────

@click.command()
@click.option(
    "--config", "cfg_path",
    type=click.Path(exists=True, path_type=Path),
    required=True,
    help="Path to the YAML pipeline config file.",
)
@click.option(
    "--threads", type=int, default=None,
    help="Override GDAL_NUM_THREADS from the config file.",
)
@click.option(
    "--dst-crs", "dst_crs", default=None,
    help="Override spatial.dst_crs (e.g. EPSG:32633).",
)
def run_pipeline(cfg_path: Path, threads: Optional[int], dst_crs: Optional[str]) -> None:
    """Load, validate, and execute a geospatial batch pipeline from a YAML config."""
    with cfg_path.open("r") as fh:
        raw: dict = yaml.safe_load(fh)

    # ① Merge CLI overrides into raw dict BEFORE constructing the model.
    #    This is the key pattern: the model never needs to know about Click.
    if threads is not None:
        raw.setdefault("gdal", {})["GDAL_NUM_THREADS"] = threads
    if dst_crs is not None:
        raw.setdefault("spatial", {})["dst_crs"] = dst_crs

    # ② Validate everything in one shot — fail fast with a clear message.
    try:
        config = BatchConfig(**raw)
    except ValidationError as exc:
        click.echo(f"Config validation failed:\n{exc}", err=True)
        raise click.exceptions.Exit(code=2)

    # ③ Inject GDAL env before any I/O (rasterio, pyogrio, osgeo.gdal).
    config.apply_gdal_env()

    # ④ Audit log: print the resolved config so CI logs are self-documenting.
    click.echo(config.model_dump_json(indent=2))

    # ⑤ Resolve input files and abort early if the glob matches nothing.
    inputs = config.resolve_inputs()
    if not inputs:
        click.echo(
            f"No files matched '{config.input_glob}' under {config.workspace}",
            err=True,
        )
        raise click.exceptions.Exit(code=2)

    click.echo(
        f"Processing {len(inputs)} files: "
        f"{config.spatial.src_crs} → {config.spatial.dst_crs} "
        f"@ {config.spatial.resampling} resampling"
    )
    # ⑥ Pipeline execution continues here with fully validated config.


if __name__ == "__main__":
    run_pipeline()
```

## Step Annotations

**① Merge CLI overrides before model construction.** `raw.setdefault("gdal", {})["GDAL_NUM_THREADS"] = threads` mutates the raw dict so the Pydantic model sees a single consistent input. This avoids the anti-pattern of building a model and then patching it — a patched model may bypass validators.

**② Single validation gateway.** Constructing `BatchConfig(**raw)` is the only place validation runs. Catching `ValidationError` here and printing it before calling `raise click.exceptions.Exit(code=2)` gives the operator an actionable error on stderr and returns a POSIX-compliant exit code (2 = usage error).

**③ `apply_gdal_env()` before any I/O.** GDAL reads its configuration variables at the time a dataset handle is opened, not at import time. Calling this method before `rasterio.open()` or any `pyogrio` read guarantees that `GDAL_CACHEMAX` and `GDAL_NUM_THREADS` take effect on every I/O call in the process.

**④ Audit log with `model_dump_json()`.** Printing the full resolved config to stdout at startup means every CI log contains a complete record of the exact parameters used — CRS strings, thread counts, cache sizes. This is essential for debugging spatial discrepancies in distributed pipelines.

**⑤ Glob resolution in `resolve_inputs()`.** `glob.glob(pattern, recursive=True)` with the `**` wildcard finds GeoTIFFs in nested subdirectories. Wrapping the result in a set before sorting deduplicates paths that could appear twice when patterns overlap.

**⑥ `field_validator` for CRS strings.** Checking that `src_crs` and `dst_crs` begin with `EPSG:` or `PROJ:` at parse time prevents GDAL from silently falling back to WGS84 when it encounters an unrecognised authority string — a failure mode that produces geometrically wrong output with no error.

## Named Gotcha: GDAL Environment Variables Set After Dataset Open Have No Effect

The most common failure when adopting this pattern is placing `apply_gdal_env()` after the first `rasterio.open()` call, or inside a lazy-loading code path that triggers after the module initialises its GDAL context.

```python
# WRONG — GDAL_CACHEMAX is ignored for this handle
with rasterio.open(src) as ds:
    config.apply_gdal_env()   # too late; cache is already allocated
    data = ds.read()

# CORRECT — inject before any open() call
config.apply_gdal_env()
with rasterio.open(src) as ds:
    data = ds.read()
```

The fix is always to call `apply_gdal_env()` immediately after model construction and before any code that touches rasterio, GDAL, or `pyogrio`. A unit test that mocks `os.environ` and checks the injected values before calling `rasterio.open()` will catch regressions during CI.

## Verification Snippet

After running the pipeline, verify that GDAL received the correct settings and that the output matches the expected CRS:

```bash
# 1. Confirm GDAL env variables were injected (visible in process env)
python - <<'EOF'
import os, yaml, pydantic
# Quick smoke-test: construct config and check env after apply
from geo_pipeline import BatchConfig
import yaml
raw = yaml.safe_load(open("pipeline.yaml"))
cfg = BatchConfig(**raw)
cfg.apply_gdal_env()
assert os.environ["GDAL_CACHEMAX"] == str(cfg.gdal.GDAL_CACHEMAX)
print("GDAL env OK:", os.environ["GDAL_CACHEMAX"], "MB")
EOF

# 2. Check that an output GeoTIFF is in the expected CRS (requires GDAL CLI tools)
gdalinfo output/tile_0001.tif | grep -E "EPSG|CoordSys"
```

For a deeper test that validates CRS round-trips and resampling fidelity, load the output with `rasterio` and assert `ds.crs.to_epsg() == 3857`.

## FAQ

<details class="faq-item">
<summary>Why use PyYAML instead of tomllib for geospatial CLIs?</summary>

YAML's multi-line strings and inline comments make it readable when documenting spatial parameters such as bounding boxes, PROJ strings, and glob patterns that span many characters. `tomllib` (Python 3.11+) is a good choice for flat key-value configurations, but YAML is the ecosystem default for tools like GDAL's own virtual format files and many open-source GIS utilities, so operators are already familiar with its syntax.

</details>

<details class="faq-item">
<summary>How do I override a nested YAML key from a Click flag without breaking validation?</summary>

Mutate the raw dict before constructing the model: `raw.setdefault("spatial", {})["dst_crs"] = cli_value`. Pydantic then sees one consistent input dict and validates the overridden value the same way it validates a file-sourced value. Never build the model and then mutate its fields — this bypasses validators.

</details>

<details class="faq-item">
<summary>When exactly should apply_gdal_env() be called?</summary>

Immediately after `BatchConfig(**raw)` succeeds and before any call that touches rasterio, `pyogrio`, or `osgeo.gdal`. GDAL reads environment variables when it first allocates a resource (cache block, dataset handle, driver registry). Injecting after that point has no effect on already-opened handles.

</details>

<details class="faq-item">
<summary>Can a Pydantic validator check that the input glob actually matches files?</summary>

Yes — use a `@model_validator(mode="after")` (not `field_validator`) because the check needs both `workspace` and `input_glob` to be resolved. Raise `ValueError` listing the zero-match pattern so the operator sees it before the batch job allocates any workers.

</details>

<details class="faq-item">
<summary>How do I handle YAML configs written for an older schema version?</summary>

Add `schema_version: int = Field(default=1)` to your model. In a `@model_validator(mode="before")` inspect the raw dict and remap legacy keys — for example, renaming a top-level `crs` string to `spatial.src_crs` — before Pydantic validates anything. This keeps migration logic isolated and testable without forking the validation code.

</details>

## Related

- [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) — the parent guide covering TOML vs YAML, schema evolution, and `pydantic-settings` environment-variable precedence
- [Managing YAML configs for geospatial CLI workflows](/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/) — you are here
- [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) — choosing the right CLI framework before wiring in a config loader
- [Handling Missing Dependencies Gracefully in Click Apps](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/handling-missing-dependencies-gracefully-in-click-apps/) — how to guard optional GDAL/rasterio imports that your config may activate
