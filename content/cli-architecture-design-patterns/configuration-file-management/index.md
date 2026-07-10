---
title: "Configuration File Management for GIS CLI Tools"
description: "Configuration management for Python GIS CLIs using Pydantic Settings, TOML, and YAML — strict schemas, deterministic precedence chains, and fail-fast validation."
slug: "configuration-file-management"
type: "topic"
breadcrumb: "Configuration File Management"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
[
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Configuration File Management for GIS CLI Tools",
    "description": "Learn how to implement production-ready configuration file management for Python GIS CLIs using Pydantic Settings, TOML, and YAML — with strict schemas, deterministic precedence chains, and fail-fast validation.",
    "datePublished": "2024-03-15",
    "dateModified": "2026-06-23",
    "author": {"@type": "Organization", "name": "batch-processing.com"},
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 2, "name": "Configuration File Management", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/"}
      ]
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": "Implement Configuration File Management for GIS CLI Tools",
    "step": [
      {"@type": "HowToStep", "position": 1, "name": "Define strict, geospatial-aware schemas"},
      {"@type": "HowToStep", "position": 2, "name": "Establish a deterministic precedence chain"},
      {"@type": "HowToStep", "position": 3, "name": "Implement fail-fast validation"},
      {"@type": "HowToStep", "position": 4, "name": "Inject validated context into subcommands"},
      {"@type": "HowToStep", "position": 5, "name": "Support immutable batch overrides"}
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Should I use TOML or YAML for GIS CLI configuration files?",
        "acceptedAnswer": {"@type": "Answer", "text": "TOML is the modern default: Python 3.11+ includes tomllib in the standard library, its syntax is unambiguous, and it maps cleanly to Pydantic models. YAML is worth choosing when pipeline orchestrators like Airflow or GitLab CI already expect it, or when your config includes multi-line strings such as WKT CRS definitions."}
      },
      {
        "@type": "Question",
        "name": "How do I override a nested config value from an environment variable?",
        "acceptedAnswer": {"@type": "Answer", "text": "With pydantic-settings and env_nested_delimiter='__', set GEOCLI__CRS__TARGET=EPSG:3857 to override the crs.target field. The double-underscore maps to nested model keys; the prefix (GEOCLI_) prevents clashes with other tools."}
      },
      {
        "@type": "Question",
        "name": "What is the safest place to validate CRS strings in the config loader?",
        "acceptedAnswer": {"@type": "Answer", "text": "Validate inside a @field_validator on the Pydantic model, before the model instance is ever returned to the CLI command. This guarantees that every code path that constructs a config object gets the same guard, even in test fixtures."}
      },
      {
        "@type": "Question",
        "name": "How do I prevent a runtime override from mutating the base config?",
        "acceptedAnswer": {"@type": "Answer", "text": "Use model_config = SettingsConfigDict(frozen=True) on your BaseSettings subclass. Merging overrides at construction time then freezing the instance prevents any downstream code from silently modifying shared state across parallel workers."}
      },
      {
        "@type": "Question",
        "name": "Can I share the same config schema across both TOML and YAML sources?",
        "acceptedAnswer": {"@type": "Answer", "text": "Yes. Parse either format into a plain Python dict first, then pass that dict to your Pydantic model's constructor. The schema remains format-agnostic; only the file-reading line changes."}
      }
    ]
  }
]
</script>

Geospatial CLIs that orchestrate batch coordinate transformations, raster tile generation, and cloud storage synchronisation break down fast when parameters are scattered across hardcoded defaults, ad-hoc environment variables, and undocumented shell wrappers. A single, schema-validated configuration file — with a deterministic precedence chain from defaults through file to environment variable to CLI flag — is the cure. This guide is part of the [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) reference and focuses specifically on the mechanics of loading, validating, and distributing that configuration within a Python GIS tool.

## Prerequisites

- Python 3.11+ (standard-library `tomllib` and improved `pathlib` ergonomics)
- `pydantic>=2.0` and `pydantic-settings>=2.0`
- `pyyaml>=6.0` if your pipeline uses YAML rather than TOML
- GDAL/rasterio or GeoPandas in your virtual environment (field validators need to resolve CRS strings)
- Familiarity with [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) to understand how CLI flags feed into the precedence chain

```bash
pip install "pydantic>=2.0" "pydantic-settings>=2.0" pyyaml typer
```

## Problem Framing

A raster batch job runs for four hours before crashing because `target_crs` defaulted silently to `EPSG:4326` instead of `EPSG:32632`. The operator had set `GEOCLI_TARGET_CRS` in the environment but mis-typed the prefix. Nothing validated the value at startup; the error surfaced only when GDAL attempted a coordinate transformation on file 40,000 of 100,000.

Three compounding failures produced this outcome: no CRS validation at parse time, no explicit precedence contract between the environment variable and the config file, and no operator-visible summary of the resolved configuration before the job began. The patterns below fix all three.

## Core Resolution Architecture

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 740 340" role="img" aria-label="Configuration resolution precedence diagram for GIS CLI tools" style="max-width:100%;height:auto;display:block;margin:2rem auto">
  <title>Configuration Resolution Precedence</title>
  <desc>A layered stack showing four configuration sources — defaults, config file, environment variables, CLI flags — merging left-to-right into a validated GeoBatchConfig object that feeds the CLI subcommand.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Layer boxes -->
  <rect x="10" y="60" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
  <text x="75" y="86" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit" font-weight="600">Defaults</text>
  <text x="75" y="104" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">code-level</text>
  <rect x="160" y="60" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
  <text x="225" y="86" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit" font-weight="600">Config File</text>
  <text x="225" y="104" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">config.toml / .yaml</text>
  <rect x="310" y="60" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="375" y="86" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit" font-weight="600">Env Vars</text>
  <text x="375" y="104" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">GEOCLI__CRS__TARGET</text>
  <rect x="460" y="60" width="130" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="525" y="86" text-anchor="middle" font-size="12" fill="currentColor" font-family="inherit" font-weight="600">CLI Flags</text>
  <text x="525" y="104" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">--crs-target EPSG:3857</text>
  <!-- Arrows to merge point -->
  <line x1="140" y1="90" x2="156" y2="90" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <line x1="290" y1="90" x2="308" y2="90" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <line x1="440" y1="90" x2="458" y2="90" stroke="currentColor" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>
  <!-- Priority label -->
  <text x="75" y="148" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.5">lowest priority</text>
  <text x="525" y="148" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.5">highest priority</text>
  <line x1="75" y1="155" x2="525" y2="155" stroke="currentColor" stroke-width="1" opacity="0.25" stroke-dasharray="4 4"/>
  <!-- Arrow on priority line -->
  <line x1="490" y1="155" x2="524" y2="155" stroke="currentColor" stroke-width="1.5" opacity="0.4" marker-end="url(#arrow)"/>
  <!-- Validated config box -->
  <rect x="610" y="40" width="120" height="100" rx="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.9"/>
  <text x="670" y="68" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit" font-weight="700">GeoBatchConfig</text>
  <text x="670" y="86" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.75">validated</text>
  <text x="670" y="102" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.75">frozen</text>
  <text x="670" y="118" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.75">typed</text>
  <!-- Arrow from CLI flags box to validated config -->
  <line x1="590" y1="90" x2="608" y2="90" stroke="currentColor" stroke-width="2" opacity="0.7" marker-end="url(#arrow)"/>
  <!-- Pydantic-settings label -->
  <text x="370" y="210" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit" opacity="0.6">pydantic-settings resolves precedence automatically</text>
  <!-- Subcommand box -->
  <rect x="610" y="200" width="120" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="670" y="222" text-anchor="middle" font-size="11" fill="currentColor" font-family="inherit" font-weight="600">CLI Subcommand</text>
  <text x="670" y="240" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">receives typed config</text>
  <!-- Arrow from config to subcommand -->
  <line x1="670" y1="140" x2="670" y2="198" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow)"/>
  <!-- Validation step annotation -->
  <rect x="460" y="270" width="130" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
  <text x="525" y="288" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit">@field_validator</text>
  <text x="525" y="304" text-anchor="middle" font-size="10" fill="currentColor" font-family="inherit" opacity="0.7">CRS · paths · formats</text>
  <line x1="525" y1="270" x2="645" y2="200" stroke="currentColor" stroke-width="1" opacity="0.3" stroke-dasharray="3 3"/>
</svg>

## Step-by-Step Implementation

### Step 1: Define Strict, Geospatial-Aware Schemas

Model every configuration parameter as a Pydantic model. Geospatial CLIs require domain-specific validation: CRS strings must resolve to valid EPSG codes, spatial extents must follow `minx, miny, maxx, maxy` ordering, and GDAL configuration keys must map to recognised driver settings. Use Pydantic v2's `@field_validator` and `@model_validator` decorators to catch malformed inputs before they reach the processing engine.

```python
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class CRSConfig(BaseModel):
    source: str = Field(default="EPSG:4326", description="Source CRS")
    target: str = Field(default="EPSG:3857", description="Target CRS")

    @field_validator("source", "target")
    @classmethod
    def validate_epsg_format(cls, v: str) -> str:
        """Reject any CRS that is not an explicit EPSG code."""
        if not v.upper().startswith("EPSG:"):
            raise ValueError(
                f"CRS '{v}' must use EPSG:<code> format (e.g. EPSG:4326)"
            )
        code = v.split(":")[1]
        if not code.isdigit():
            raise ValueError(f"EPSG code must be numeric, got '{code}'")
        return v.upper()


class RasterConfig(BaseModel):
    tile_size: tuple[int, int] = (256, 256)
    compression: Literal["LZW", "DEFLATE", "ZSTD"] = "ZSTD"
    nodata: float | None = None
    overview_levels: list[int] = Field(default_factory=lambda: [2, 4, 8, 16])

    @model_validator(mode="after")
    def tile_size_must_be_power_of_two(self) -> "RasterConfig":
        for dim in self.tile_size:
            if dim <= 0 or (dim & (dim - 1)) != 0:
                raise ValueError(
                    f"tile_size dimensions must be powers of two, got {dim}"
                )
        return self


class GeoBatchConfig(BaseModel):
    crs: CRSConfig = Field(default_factory=CRSConfig)
    raster: RasterConfig = Field(default_factory=RasterConfig)
    output_dir: Path = Path("./output")
    max_workers: int = Field(default=4, ge=1, le=32)
    input_glob: str = "**/*.tif"

    @field_validator("output_dir")
    @classmethod
    def ensure_output_exists(cls, v: Path) -> Path:
        v.mkdir(parents=True, exist_ok=True)
        return v
```

### Step 2: Establish a Deterministic Precedence Chain

The `pydantic-settings` `BaseSettings` class resolves the four-layer chain automatically. Subclass it rather than `BaseModel`, configure an `env_prefix` to namespace all environment variables, and use `env_nested_delimiter="__"` so that `GEOCLI__CRS__TARGET=EPSG:32632` maps to `crs.target`.

```python
from typing import Any
from pydantic_settings import BaseSettings, SettingsConfigDict


class GeoBatchSettings(BaseSettings):
    """
    Resolution order (highest priority last wins):
      1. Code defaults on each Field(default=...)
      2. Values from the TOML/YAML file passed at construction
      3. Environment variables with the GEOCLI_ prefix
      4. CLI flag overrides injected as constructor kwargs
    """
    model_config = SettingsConfigDict(
        env_prefix="GEOCLI_",
        env_nested_delimiter="__",
        extra="ignore",    # silently drop unknown keys from old config files
        frozen=True,       # prevent accidental mutation in multi-worker pipelines
    )

    crs: CRSConfig = Field(default_factory=CRSConfig)
    raster: RasterConfig = Field(default_factory=RasterConfig)
    output_dir: Path = Path("./output")
    max_workers: int = Field(default=4, ge=1, le=32)
    input_glob: str = "**/*.tif"

    @field_validator("output_dir")
    @classmethod
    def ensure_output_exists(cls, v: Path) -> Path:
        v.mkdir(parents=True, exist_ok=True)
        return v
```

### Step 3: Implement the Config Loader

Parse the config file into a plain dict, merge CLI overrides on top, then hand everything to `GeoBatchSettings`. Pydantic Settings handles environment variable injection automatically at that construction point.

```python
import tomllib
from pathlib import Path
from typing import Any

import yaml  # pyyaml
from pydantic import ValidationError

from .schema import CRSConfig, GeoBatchSettings


def _read_file(path: Path) -> dict[str, Any]:
    """Read TOML or YAML config file into a plain dict."""
    suffix = path.suffix.lower()
    if suffix == ".toml":
        with open(path, "rb") as f:
            return tomllib.load(f)
    elif suffix in {".yaml", ".yml"}:
        with open(path) as f:
            return yaml.safe_load(f) or {}
    raise ValueError(f"Unsupported config format: {suffix!r}. Use .toml or .yaml")


def load_config(
    config_path: Path | None = None,
    overrides: dict[str, Any] | None = None,
) -> GeoBatchSettings:
    """
    Load and validate configuration with strict precedence:
      file values < environment variables < overrides (CLI flags)

    Raises ValidationError immediately on invalid values so the caller
    can exit(1) before any expensive I/O begins.
    """
    file_values: dict[str, Any] = {}
    if config_path is not None and config_path.exists():
        file_values = _read_file(config_path)

    # CLI overrides win over both file values and env vars.
    # Env var injection happens inside GeoBatchSettings.__init__.
    merged = {**file_values, **(overrides or {})}
    return GeoBatchSettings(**merged)
```

### Step 4: Wire the Loader into a Typer Command

Use [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) to declare the `--config` option and any per-invocation override flags. Build the `overrides` dict from whatever flags were explicitly set (check for `None` rather than a falsy default), then call `load_config` at the very start of the command body.

```python
import sys
from pathlib import Path
from typing import Annotated

import typer
from pydantic import ValidationError
from rich.console import Console

from .config import load_config
from .schema import GeoBatchSettings

app = typer.Typer()
err_console = Console(stderr=True)


@app.command()
def process(
    config: Annotated[
        Path,
        typer.Option("--config", "-c", help="Path to config.toml or config.yaml"),
    ] = Path("config.toml"),
    crs_target: Annotated[
        str | None,
        typer.Option("--crs-target", help="Override target CRS (e.g. EPSG:32632)"),
    ] = None,
    workers: Annotated[
        int | None,
        typer.Option("--workers", help="Override max parallel workers"),
    ] = None,
) -> None:
    overrides: dict = {}
    if crs_target is not None:
        # Nested override: rebuild the crs sub-dict so pydantic-settings
        # receives a complete mapping, not a partial one.
        overrides["crs"] = {"source": "EPSG:4326", "target": crs_target}
    if workers is not None:
        overrides["max_workers"] = workers

    try:
        cfg: GeoBatchSettings = load_config(
            config if config.exists() else None,
            overrides,
        )
    except ValidationError as exc:
        # Translate pydantic's internal error trace into a single readable line.
        first = exc.errors()[0]
        location = " → ".join(str(loc) for loc in first["loc"])
        err_console.print(
            f"[bold red]Config error[/bold red] [{location}]: {first['msg']}",
        )
        raise typer.Exit(code=1)

    typer.echo(f"CRS: {cfg.crs.source} → {cfg.crs.target}")
    typer.echo(f"Output: {cfg.output_dir.resolve()!s} | Workers: {cfg.max_workers}")
    # Proceed to batch processing...
```

### Step 5: Support Immutable Batch Overrides

Batch pipelines (Airflow, Prefect, GitHub Actions matrix jobs) inject job-specific parameters at runtime. Because `GeoBatchSettings` is frozen, a pipeline runner cannot accidentally mutate a shared config object across workers. To create a per-job variant, construct a fresh instance by merging the base file values with the job-specific overrides:

```python
from typing import Any

from .config import load_config
from .schema import GeoBatchSettings


def make_job_config(
    base: Path,
    job_overrides: dict[str, Any],
) -> GeoBatchSettings:
    """
    Return a new, validated, frozen config for a single batch job.
    The base file's values remain unchanged; job_overrides win on collision.
    """
    return load_config(config_path=base, overrides=job_overrides)


# Example: Airflow task calling this for each input CRS zone
job_cfg = make_job_config(
    base=Path("/pipelines/config.toml"),
    job_overrides={
        "crs": {"source": "EPSG:4326", "target": "EPSG:32632"},
        "output_dir": "/outputs/zone-32632",
    },
)
```

## Configuration Integration

The double-underscore delimiter used by `pydantic-settings` maps directly to nested model keys. The full environment variable surface for `GeoBatchSettings` is:

| Environment variable | Mapped field | Example value |
|---|---|---|
| `GEOCLI__CRS__SOURCE` | `crs.source` | `EPSG:4326` |
| `GEOCLI__CRS__TARGET` | `crs.target` | `EPSG:32632` |
| `GEOCLI__RASTER__COMPRESSION` | `raster.compression` | `DEFLATE` |
| `GEOCLI__RASTER__TILE_SIZE` | `raster.tile_size` | `[512, 512]` |
| `GEOCLI__RASTER__NODATA` | `raster.nodata` | `-9999.0` |
| `GEOCLI__MAX_WORKERS` | `max_workers` | `8` |
| `GEOCLI__OUTPUT_DIR` | `output_dir` | `/mnt/output` |

Document this surface in your CLI's `--help` output by adding it to the Typer app epilog:

```python
app = typer.Typer(
    epilog=(
        "Environment variable prefix: GEOCLI_\\n"
        "Nested keys use double-underscore: GEOCLI__CRS__TARGET=EPSG:32632"
    )
)
```

For teams working with YAML-based CI pipelines, [Managing YAML configs for geospatial CLI workflows](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/) covers multi-environment deployment patterns and schema migration.

## Error Handling and Gotchas

### CRS String Not Validated Until Field Access

The most common failure mode is passing a CRS-like string (`"WGS84"`, `"4326"`, `"+proj=..."`) that passes the `EPSG:` prefix check but then fails inside GDAL at transformation time. Make the validator more defensive by explicitly checking that the numeric portion is within the valid EPSG range (1024–32767 for projected, 4001–4999 for geographic), or call `pyproj.CRS.from_epsg(code)` inside the validator to force immediate resolution:

```python
from pyproj import CRS
from pyproj.exceptions import CRSError

@field_validator("source", "target")
@classmethod
def validate_and_resolve_crs(cls, v: str) -> str:
    if not v.upper().startswith("EPSG:"):
        raise ValueError(f"CRS must use EPSG:<code> format, got {v!r}")
    code = v.split(":")[1]
    try:
        CRS.from_epsg(int(code))  # raises CRSError if unknown
    except (CRSError, ValueError) as exc:
        raise ValueError(f"Unknown EPSG code {code}: {exc}") from exc
    return v.upper()
```

### `extra="ignore"` Silently Drops Renamed Keys

Changing a key name in a new release (e.g. `workers` → `max_workers`) while keeping `extra="ignore"` means old config files load without error, silently falling back to the code default. During a major version migration, switch temporarily to `extra="forbid"` and emit a deprecation warning listing every dropped key, then revert after one release cycle.

### Output Directory Created Before Validation Completes

The `ensure_output_exists` validator calls `Path.mkdir()` as a side effect. If a later field fails validation, `ValidationError` is raised but the directory has already been created. For strictly clean failure semantics, defer the `mkdir` call to the CLI command body, after `load_config` returns successfully.

### TOML Integer vs Float for `nodata`

TOML has no `null` type; to represent an absent `nodata`, use a sentinel like `-9999.0` and document it, or use a TOML optional table section. In YAML, `null` or `~` maps naturally to `None` in Python. If you need to support both formats, ensure your `RasterConfig.nodata` field is typed `float | None` with a sentinel default, and add a validator that converts `-9999.0` back to `None` for consistency.

### Frozen Model Cannot Be Deep-Copied With Standard `copy.deepcopy`

When passing `GeoBatchSettings` instances across process boundaries (multiprocessing), `copy.deepcopy` will raise `TypeError` on frozen models. Serialise to dict first with `cfg.model_dump()`, pass the dict, then reconstruct on the receiving side with `GeoBatchSettings(**data)`.

## Verification

After calling `load_config`, log the resolved configuration before any batch I/O begins. This creates an audit trail and surfaces misconfiguration immediately:

```python
import json
import logging

logger = logging.getLogger(__name__)


def log_resolved_config(cfg: GeoBatchSettings) -> None:
    """Emit the full resolved configuration as structured JSON to stdout."""
    payload = cfg.model_dump(mode="json")
    # Convert Path objects to strings for JSON serialisation
    payload["output_dir"] = str(cfg.output_dir)
    logger.info("resolved_config", extra={"config": payload})
    # Human-readable summary to terminal
    typer.echo(f"Config: CRS {cfg.crs.source}→{cfg.crs.target} | "
               f"workers={cfg.max_workers} | output={cfg.output_dir}")
```

Confirm the precedence chain is working with a quick shell test:

```bash
# 1. Baseline: load from file
python -m mygeotool process --config config.toml

# 2. Override CRS via env var; should print EPSG:32632
GEOCLI__CRS__TARGET=EPSG:32632 python -m mygeotool process --config config.toml

# 3. CLI flag beats env var; should print EPSG:27700
GEOCLI__CRS__TARGET=EPSG:32632 python -m mygeotool process --config config.toml \
  --crs-target EPSG:27700

# 4. Invalid CRS; must exit with code 1 and a readable error
python -m mygeotool process --crs-target "WGS84"
echo "Exit code: $?"  # expect: Exit code: 1
```

The [environment variable synchronisation patterns in Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/) complement this verification approach with tooling for diffing resolved configuration against expected values in CI.

## Performance Notes

- `GeoBatchSettings` construction is negligible compared to GDAL I/O — even with `pyproj.CRS.from_epsg` calls inside validators, expect under 5 ms for a full config load.
- The `frozen=True` setting adds no runtime overhead; it attaches a `__setattr__` guard at class creation time only.
- If you are constructing tens of thousands of per-tile job configs (not recommended — construct once and pass down), consider using `GeoBatchConfig` (plain `BaseModel`, non-settings) as the frozen data carrier and constructing `GeoBatchSettings` once at startup.
- Prefer `model_dump()` over `dict()` for serialisation — the former respects mode, alias, and exclude parameters correctly in Pydantic v2.

## FAQ

<details class="faq-item">
<summary>Should I use TOML or YAML for GIS CLI configuration files?</summary>

TOML is the modern default: Python 3.11+ includes `tomllib` in the standard library, its syntax is unambiguous, and it maps cleanly to Pydantic models. Choose YAML when pipeline orchestrators like Airflow or GitLab CI already expect it, or when your config includes multi-line strings such as WKT CRS definitions.
</details>

<details class="faq-item">
<summary>How do I override a nested config value from an environment variable?</summary>

With `pydantic-settings` and `env_nested_delimiter="__"`, set `GEOCLI__CRS__TARGET=EPSG:3857` to override `crs.target`. The double-underscore maps to nested model keys; the prefix (`GEOCLI_`) prevents clashes with other tools on the same host.
</details>

<details class="faq-item">
<summary>What is the safest place to validate CRS strings in the config loader?</summary>

Validate inside a `@field_validator` on the Pydantic model, before the model instance is ever returned to the CLI command. This guarantees that every code path that constructs a config object — including test fixtures — gets the same guard.
</details>

<details class="faq-item">
<summary>How do I prevent a runtime override from mutating the base config?</summary>

Set `model_config = SettingsConfigDict(frozen=True)` on your `BaseSettings` subclass. Merging overrides at construction time then freezing the instance prevents any downstream code from silently modifying shared state across parallel workers.
</details>

<details class="faq-item">
<summary>Can I share the same config schema across both TOML and YAML sources?</summary>

Yes. Parse either format into a plain Python dict first using `tomllib` or `yaml.safe_load`, then pass that dict to your Pydantic model's constructor. The schema remains format-agnostic; only the file-reading line changes.
</details>

## Related

- [Managing YAML configs for geospatial CLI workflows](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/managing-yaml-configs-for-geospatial-cli-workflows/) — schema validation patterns for multi-environment YAML pipelines
- [Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/) — synchronise and audit environment variable state across deployment targets
- [CLI Subcommand Organisation](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/) — structure validated config injection across a multi-command Typer application
- [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) — parent guide covering the full lifecycle of production Python GIS CLI tooling
