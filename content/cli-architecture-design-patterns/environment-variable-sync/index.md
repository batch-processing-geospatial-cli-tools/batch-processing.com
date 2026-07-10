---
title: "Environment Variable Sync for Python GIS CLI Tools"
description: "Schema-driven validation, cross-platform path normalization, and subprocess propagation patterns for synchronizing environment variables in Python geospatial CLIs."
slug: "environment-variable-sync"
type: "topic"
breadcrumb: "Environment Variable Sync"
datePublished: "2024-11-12"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Environment Variable Sync for Python GIS CLI Tools",
      "description": "Schema-driven validation, cross-platform path normalization, and subprocess propagation patterns for synchronizing environment variables in Python geospatial CLIs.",
      "datePublished": "2024-11-12",
      "dateModified": "2026-06-23",
      "author": { "@type": "Organization", "name": "batch-processing.com" },
      "publisher": { "@type": "Organization", "name": "batch-processing.com" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/" },
        { "@type": "ListItem", "position": 2, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/" },
        { "@type": "ListItem", "position": 3, "name": "Environment Variable Sync", "item": "https://batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/" }
      ]
    },
    {
      "@type": "HowTo",
      "name": "Synchronize Environment Variables in a Python GIS CLI",
      "step": [
        { "@type": "HowToStep", "position": 1, "name": "Define a typed pydantic-settings schema", "text": "Map every required and optional variable to a typed model with GIS-specific path validators." },
        { "@type": "HowToStep", "position": 2, "name": "Establish load precedence", "text": "Read shell environment first, then .env files, then CI/CD secret managers." },
        { "@type": "HowToStep", "position": 3, "name": "Validate and coerce types", "text": "Convert strings to Path objects, integers, and booleans; reject malformed values before entering the processing loop." },
        { "@type": "HowToStep", "position": 4, "name": "Normalize geospatial library paths", "text": "Resolve GDAL_DATA, PROJ_LIB, and CPL_DEBUG to absolute, cross-platform paths and write them back to os.environ." },
        { "@type": "HowToStep", "position": 5, "name": "Propagate to subprocesses and batch workers", "text": "Pass env explicitly via subprocess.run(env=...) and serialize config into worker context dictionaries." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does rasterio fail to open files after I set PROJ_LIB at runtime?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "PROJ initializes its data directory once during import. If you set PROJ_LIB after import rasterio, the change has no effect. Set environment variables before any import of rasterio, pyproj, or fiona."
          }
        },
        {
          "@type": "Question",
          "name": "Should I use pydantic-settings or python-dotenv for environment sync?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Use pydantic-settings when you need type coercion, nested model validation, and path existence checks. Use python-dotenv alone only for trivial scripts; it provides no type safety."
          }
        },
        {
          "@type": "Question",
          "name": "How do I prevent .env values from overwriting CI secrets?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Pass env_ignore_empty=True and override=False to BaseSettings so that existing shell variables take precedence over .env entries."
          }
        },
        {
          "@type": "Question",
          "name": "Do child processes spawned with subprocess.run inherit os.environ mutations?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "On POSIX, yes; on Windows with spawn start method, the environment is serialized and sent to the child, so mutations made after process creation are not reflected. Always pass env=os.environ.copy() explicitly."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use environment variable sync with Typer CLI options?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Load and validate the config in a Typer callback decorated with @app.callback(invoke_without_command=True), then store the resolved GISRuntimeConfig on the typer.Context object for subcommand access."
          }
        }
      ]
    }
  ]
}
</script>

# Environment Variable Sync for Python GIS CLI Tools

Schema-driven environment variable sync gives your Python GIS CLI a validated, normalized configuration layer before any GDAL driver opens a file — eliminating the silent CRS mismatches, `libproj` segfaults, and credential leaks that plague unmanaged environment inheritance.

This page is part of the [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) guide.

---

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Environment variable sync pipeline: shell env, .env file, and CI secrets feed into a pydantic-settings schema, which normalizes GIS paths and exports to os.environ, then propagates to subprocesses and batch workers" style="width:100%;max-width:760px;display:block;margin:2rem auto;">
  <title>Environment variable sync pipeline for GIS CLI tools</title>
  <desc>Three source layers — shell environment, .env file, and CI secret manager — feed into a pydantic-settings schema validator. Validated config normalizes GDAL_DATA and PROJ_LIB paths and writes them to os.environ. os.environ then propagates to spawned subprocesses and distributed batch workers.</desc>
  <defs>
    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Source boxes -->
  <rect x="10" y="30" width="150" height="44" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="85" y="49" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">Shell env</text>
  <text x="85" y="65" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">$GDAL_DATA, $AWS_*</text>
  <rect x="10" y="100" width="150" height="44" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="85" y="119" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">.env file</text>
  <text x="85" y="135" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">dev overrides only</text>
  <rect x="10" y="170" width="150" height="44" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="85" y="189" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">CI secret manager</text>
  <text x="85" y="205" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">Vault / SSM / GH Secrets</text>
  <!-- Arrows to schema -->
  <line x1="160" y1="52" x2="235" y2="110" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#arrowhead)"/>
  <line x1="160" y1="122" x2="235" y2="122" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#arrowhead)"/>
  <line x1="160" y1="192" x2="235" y2="132" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#arrowhead)"/>
  <!-- Schema validation box -->
  <rect x="240" y="80" width="180" height="84" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.6" stroke-width="2"/>
  <text x="330" y="103" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="700">pydantic-settings</text>
  <text x="330" y="120" text-anchor="middle" font-size="11" fill="currentColor" font-family="system-ui,sans-serif">GISRuntimeConfig</text>
  <text x="330" y="137" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">type coercion + path</text>
  <text x="330" y="152" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">existence validation</text>
  <!-- Arrow to os.environ -->
  <line x1="420" y1="122" x2="490" y2="122" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#arrowhead)"/>
  <!-- os.environ box -->
  <rect x="495" y="95" width="130" height="54" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="560" y="118" text-anchor="middle" font-size="12" fill="currentColor" font-family="system-ui,sans-serif" font-weight="600">os.environ</text>
  <text x="560" y="135" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.7">normalized paths</text>
  <!-- Arrows to consumers -->
  <line x1="625" y1="112" x2="695" y2="72" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#arrowhead)"/>
  <line x1="625" y1="132" x2="695" y2="172" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#arrowhead)"/>
  <!-- Consumer boxes -->
  <rect x="700" y="44" width="50" height="40" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="725" y="61" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">sub-</text>
  <text x="725" y="75" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">process</text>
  <rect x="700" y="150" width="50" height="40" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="725" y="167" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">batch</text>
  <text x="725" y="181" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif">worker</text>
  <!-- Precedence label -->
  <text x="85" y="256" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.6">lowest precedence</text>
  <line x1="20" y1="244" x2="150" y2="244" stroke="currentColor" stroke-opacity="0.3" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="560" y="256" text-anchor="middle" font-size="10" fill="currentColor" font-family="system-ui,sans-serif" opacity="0.6">exported to C bindings</text>
  <line x1="495" y1="244" x2="625" y2="244" stroke="currentColor" stroke-opacity="0.3" stroke-width="1" stroke-dasharray="4,3"/>
</svg>

## Prerequisites

- **Python 3.9+** — required for `pathlib.Path` type coercion in validators and `subprocess` keyword arguments used throughout this guide.
- **`pydantic-settings>=2.0`** — provides `BaseSettings` with `.env` parsing, type coercion, and source priority control: `pip install "pydantic-settings>=2.0"`.
- **`python-dotenv>=1.0`** — transitive dependency of `pydantic-settings`; no separate install needed.
- **Geospatial stack** — `rasterio`, `geopandas`, or `pyproj` (all rely on GDAL/PROJ C libraries whose runtime behavior is controlled by the variables managed here).
- **CI/CD awareness** — basic understanding of how GitHub Actions, GitLab CI, or Jenkins inject secrets as environment variables.

For CLI framework choices that interact directly with this configuration layer, compare the trade-offs in [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/).

```bash
pip install "pydantic-settings>=2.0" "typer[all]" rasterio geopandas pyproj
```

## Problem Framing

A GIS pipeline processes 40,000 GeoTIFF tiles. Halfway through, `rasterio.open()` raises `NotGeoreferencedWarning` on every file because `GDAL_DATA` pointed to the wrong directory — one that the developer's machine had but the CI container did not. The job logs 40,000 warnings before completing with corrupt CRS metadata baked into the output tiles. Root cause: the tool inherited a stale `GDAL_DATA` from the shell without validating it, and no error surfaced until reviewing outputs the next morning.

Environment variable sync is the pattern that catches this at startup, not hours later.

## Step-by-Step Implementation

### Step 1: Define a Typed Schema

Create a `GISRuntimeConfig` class that models every variable your tool reads. Mark critical paths as validated `Path` objects; use conservative safe defaults for performance knobs.

```python
import os
from pathlib import Path
from typing import Optional

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class GISRuntimeConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Shell env takes priority over .env; prevents CI secrets from
        # being silently overwritten by stale developer .env files.
        env_ignore_empty=True,
        extra="ignore",
    )

    # ── GIS library paths ──────────────────────────────────────────────────
    gdal_data: Optional[Path] = None       # GDAL_DATA
    proj_lib: Optional[Path] = None        # PROJ_LIB

    # ── Batch processing ───────────────────────────────────────────────────
    max_parallel_workers: int = 4
    gdal_cachemax: int = 512               # MB; GDAL internal block cache
    enable_cpl_debug: bool = False         # verbose GDAL driver logging

    # ── Cloud / credentials (never logged) ────────────────────────────────
    aws_region: str = "us-east-1"
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None

    @field_validator("gdal_data", "proj_lib", mode="before")
    @classmethod
    def resolve_gis_paths(cls, v: Optional[str]) -> Optional[Path]:
        """Expand ~ and symlinks; reject paths that do not exist."""
        if not v:
            return None
        p = Path(v).expanduser().resolve()
        if not p.exists():
            raise ValueError(f"GIS library path not found on disk: {p}")
        return p

    @model_validator(mode="after")
    def warn_missing_optional_paths(self) -> "GISRuntimeConfig":
        """Emit a warning (not an error) when recommended paths are absent."""
        import warnings
        for name, value in [("GDAL_DATA", self.gdal_data), ("PROJ_LIB", self.proj_lib)]:
            if value is None:
                warnings.warn(
                    f"{name} not set — GDAL/PROJ will use compiled-in defaults, "
                    "which may differ between environments.",
                    RuntimeWarning,
                    stacklevel=2,
                )
        return self
```

The `field_validator` runs during instantiation and converts the raw string from the environment into an absolute `Path`. If the path does not exist, `pydantic` raises a `ValidationError` with a clear message before the CLI enters its processing loop — not hours later when a GDAL segfault surfaces.

### Step 2: Load and Export to `os.environ`

After validation, write the resolved values back to `os.environ` so that downstream C extensions (GDAL, PROJ, GEOS) pick them up through their own environment reads.

```python
def load_and_sync_config(env_file: Path = Path(".env")) -> GISRuntimeConfig:
    """
    Load, validate, and sync environment variables for GIS C bindings.

    Call this once at CLI startup, before any import of rasterio / pyproj,
    to guarantee the correct GDAL_DATA and PROJ_LIB are in place.
    """
    config = GISRuntimeConfig(_env_file=str(env_file))

    # Export validated paths so GDAL/PROJ C libs pick them up.
    if config.gdal_data:
        os.environ["GDAL_DATA"] = str(config.gdal_data)
    if config.proj_lib:
        os.environ["PROJ_LIB"] = str(config.proj_lib)

    # GDAL block cache — affects raster tile throughput significantly.
    os.environ["GDAL_CACHEMAX"] = str(config.gdal_cachemax)

    # Verbose GDAL driver logging; only enable when debugging driver issues.
    if config.enable_cpl_debug:
        os.environ["CPL_DEBUG"] = "ON"

    return config
```

### Step 3: Wire into the CLI Entry Point

Use a [Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) callback to synchronize the environment before any subcommand executes. Storing the config on `ctx.obj` gives every subcommand access without global state.

```python
import typer
from pathlib import Path

app = typer.Typer(name="geo-pipeline", add_completion=True)


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    env_file: Path = typer.Option(
        Path(".env"),
        "--env-file",
        envvar="GEO_ENV_FILE",
        help="Path to .env file. Shell variables always take precedence.",
        exists=False,   # allow non-existent; handled inside load_and_sync_config
    ),
) -> None:
    """Geo-pipeline: reproducible spatial batch processing."""
    ctx.ensure_object(dict)
    ctx.obj["config"] = load_and_sync_config(env_file=env_file)


@app.command()
def reproject(
    ctx: typer.Context,
    input_path: Path = typer.Argument(..., help="Input GeoTIFF (EPSG:4326)"),
    target_epsg: int = typer.Option(3857, "--epsg", help="Target CRS as EPSG integer"),
    output_dir: Path = typer.Option(Path("./output"), "--out-dir"),
) -> None:
    """Reproject a GeoTIFF; config is already synced from callback."""
    import rasterio
    from rasterio.warp import calculate_default_transform, reproject, Resampling
    from rasterio.crs import CRS

    config: GISRuntimeConfig = ctx.obj["config"]
    output_dir.mkdir(parents=True, exist_ok=True)
    dest = output_dir / f"{input_path.stem}_epsg{target_epsg}.tif"
    dst_crs = CRS.from_epsg(target_epsg)

    with rasterio.open(input_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds
        )
        kwargs = src.meta.copy()
        kwargs.update({"crs": dst_crs, "transform": transform, "width": width, "height": height})

        with rasterio.open(dest, "w", **kwargs) as dst:
            for band_idx in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band_idx),
                    destination=rasterio.band(dst, band_idx),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=dst_crs,
                    resampling=Resampling.lanczos,
                    num_threads=config.max_parallel_workers,
                )

    typer.echo(f"Reprojected → {dest}")
```

The `--env-file` flag itself accepts an `envvar="GEO_ENV_FILE"` override, so the sync layer can even locate its own configuration file from the environment — a useful bootstrapping pattern for containerized deployments.

## Configuration Integration

Environment variable sync occupies the second layer in the standard precedence chain. The table below shows how each source maps to `pydantic-settings` behaviour.

| Source | pydantic-settings mechanism | Typical use |
|---|---|---|
| CLI flags | `typer.Option` passed explicitly to the function | One-off overrides during debugging |
| Shell `export` | `os.environ` read at `BaseSettings` init | Developer workstations, CI runners |
| `.env` file | `SettingsConfigDict(env_file=".env")` | Local development; must be `.gitignore`d |
| Coded defaults | Field default values in the model | Safe non-sensitive fallbacks only |

Setting `env_ignore_empty=True` ensures that an empty `GDAL_DATA=""` exported by a misconfigured CI profile does not shadow a meaningful value coming from a later source. The [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) pattern extends this chain upward with TOML/YAML file sources for project-level defaults.

## Error Handling & Gotchas

**`PROJ_LIB` must be set before `import rasterio`.**
PROJ reads its data directory once during the shared-library load triggered by the first import. Setting `PROJ_LIB` after `import rasterio` has no effect; the library has already initialized with the wrong (or absent) path. Always call `load_and_sync_config()` before importing any geospatial library.

**Windows `spawn` does not inherit `os.environ` mutations.**
On Linux, forked child processes inherit the parent's environment automatically. On Windows (and macOS with the `spawn` multiprocessing start method), the child serializes the parent environment at the time `Process.start()` is called — not at definition time. Mutating `os.environ` after that point is invisible to the child. Pass `env=os.environ.copy()` explicitly to `subprocess.run()` or use `multiprocessing.pool.Pool(initializer=load_and_sync_config)` to re-run the sync inside each worker.

**Stale `.env` files overwrite CI secrets.**
`pydantic-settings` by default lets `.env` values override shell variables when both are present. Set `env_ignore_empty=True` and keep `override=False` (the default) to ensure that CI-injected secrets always take precedence.

**`GDAL_CACHEMAX` units differ between GDAL versions.**
In GDAL < 3.4, `GDAL_CACHEMAX` is interpreted as bytes if the value exceeds 100, and as a percentage if it is ≤ 100. In GDAL ≥ 3.4, it is always bytes. Always suffix with `MB` explicitly or check `gdal.GetCacheMax()` at startup to verify the value was parsed as intended.

```python
from osgeo import gdal

actual_cache_mb = gdal.GetCacheMax() // (1024 * 1024)
if actual_cache_mb < 256:
    raise RuntimeError(
        f"GDAL block cache is only {actual_cache_mb} MB — "
        "check GDAL_CACHEMAX units for your GDAL version."
    )
```

## Subprocess & Worker Propagation

When your CLI spawns `gdal_translate`, `ogr2ogr`, or custom processing binaries, pass the validated environment explicitly rather than relying on implicit inheritance.

```python
import subprocess
import os
from typing import Optional


def run_gdal_translate(
    src_path: Path,
    dst_path: Path,
    target_epsg: int = 4326,
    extra_env: Optional[dict[str, str]] = None,
) -> subprocess.CompletedProcess[str]:
    """
    Invoke gdal_translate as a subprocess with validated env propagation.

    Always builds env from os.environ.copy() so that load_and_sync_config()
    mutations (GDAL_DATA, PROJ_LIB, GDAL_CACHEMAX) are included.
    """
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    cmd = [
        "gdal_translate",
        "-a_srs", f"EPSG:{target_epsg}",
        "-of", "GTiff",
        "-co", "COMPRESS=LZW",
        "-co", "TILED=YES",
        str(src_path),
        str(dst_path),
    ]

    return subprocess.run(
        cmd,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
```

For distributed batch workers running under Celery or Dask, serialize the validated config dictionary and call `load_and_sync_config()` inside the worker initializer so each process boots with a consistent GDAL/PROJ state.

```python
import multiprocessing
from typing import Any


def _worker_init(env_overrides: dict[str, str]) -> None:
    """
    Worker initializer: apply env overrides then sync GIS paths.
    Called once per worker process before any task executes.
    """
    os.environ.update(env_overrides)
    load_and_sync_config()


def process_raster_batch(
    tile_paths: list[Path],
    target_epsg: int,
    config: GISRuntimeConfig,
) -> list[Any]:
    overrides: dict[str, str] = {}
    if config.gdal_data:
        overrides["GDAL_DATA"] = str(config.gdal_data)
    if config.proj_lib:
        overrides["PROJ_LIB"] = str(config.proj_lib)
    overrides["GDAL_CACHEMAX"] = str(config.gdal_cachemax)

    with multiprocessing.Pool(
        processes=config.max_parallel_workers,
        initializer=_worker_init,
        initargs=(overrides,),
    ) as pool:
        return pool.map(
            lambda p: run_gdal_translate(p, p.with_suffix(".out.tif"), target_epsg),
            tile_paths,
        )
```

## Security Considerations

Environment variables are visible in process listings (`/proc/<pid>/environ` on Linux), crash dumps, and container inspection tools. A responsible sync layer masks sensitive values before they reach any logging framework.

```python
import logging
import re

_SENSITIVE_PATTERN = re.compile(
    r"(key|secret|token|password|credential|auth)", re.IGNORECASE
)


def log_config_summary(config: GISRuntimeConfig) -> None:
    """Log the resolved configuration, redacting credential fields."""
    logger = logging.getLogger("geo-pipeline.config")
    for field_name, value in config.model_dump().items():
        if _SENSITIVE_PATTERN.search(field_name):
            logger.info("  %s = [REDACTED]", field_name.upper())
        else:
            logger.info("  %s = %s", field_name.upper(), value)
```

Additional practices for production pipelines:

- Prefer short-lived IAM role credentials over static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pairs; inject them via AWS STS at job start time.
- Never commit `.env` files containing real credentials; add `.env` to `.gitignore` and document the expected variables in a `.env.example` file.
- Use a startup health check command (`geo-pipeline config check`) to print the redacted summary and verify path accessibility before launching a long batch job.

## Verification

Add a `config check` subcommand that validates and prints the full resolved state. Exit code `2` on any validation failure follows the [POSIX convention](https://man.openbsd.org/sysexits) for misuse / configuration errors.

```python
@app.command(name="config-check")
def config_check(ctx: typer.Context) -> None:
    """Print resolved GIS configuration and validate all paths. Exit 2 on failure."""
    import sys

    config: GISRuntimeConfig = ctx.obj["config"]
    all_ok = True

    checks = [
        ("GDAL_DATA", config.gdal_data),
        ("PROJ_LIB", config.proj_lib),
    ]
    for var_name, path in checks:
        if path is None:
            typer.echo(f"  {var_name}: NOT SET (using GDAL/PROJ compiled-in default)")
        elif path.exists():
            typer.echo(f"  {var_name}: {path} ✓")
        else:
            typer.echo(f"  {var_name}: {path} — PATH MISSING", err=True)
            all_ok = False

    typer.echo(f"  MAX_PARALLEL_WORKERS: {config.max_parallel_workers}")
    typer.echo(f"  GDAL_CACHEMAX: {config.gdal_cachemax} MB")

    if not all_ok:
        raise typer.Exit(code=2)
```

Run verification before any batch job:

```bash
geo-pipeline config-check
# Expected output (all paths present):
#   GDAL_DATA: /usr/share/gdal ✓
#   PROJ_LIB: /usr/share/proj ✓
#   MAX_PARALLEL_WORKERS: 4
#   GDAL_CACHEMAX: 512 MB
```

A non-zero exit code from `config-check` can be used as a CI gate step to prevent misconfigured workers from consuming expensive spot instances.

## Performance Notes

- **`GDAL_CACHEMAX`** is the single highest-impact environment variable for raster throughput. A 512 MB cache reduces tile re-read overhead by roughly 40% for workloads that process spatially clustered tiles. Values above physical RAM cause thrashing; set it to no more than 25% of available worker RAM.
- **`GDAL_NUM_THREADS=ALL_CPUS`** enables multi-threaded compression (LZW, DEFLATE) inside `rasterio.open(..., mode="w")`. Combine this with `max_parallel_workers` tuned to leave headroom for the OS I/O scheduler.
- **`PROJ_NETWORK=ON`** allows PROJ to download datum shift grids on demand from CDN. In CI environments with no outbound internet, set `PROJ_NETWORK=OFF` explicitly to avoid hanging network timeouts during CRS transformations.
- Serializing and deserializing the config dictionary for each worker adds negligible overhead (microseconds per worker) compared to GDAL file-open costs. Prefer explicit initialization over relying on `fork` semantics, which vary by platform and Python version.

## FAQ

<details class="faq-item">
<summary>Why does rasterio fail to open files after I set PROJ_LIB at runtime?</summary>

PROJ reads its data directory once during the shared-library initialization triggered by `import rasterio` (or `import pyproj`). Setting `PROJ_LIB` after the import has no effect — the library has already found (or failed to find) its data directory. Always call `load_and_sync_config()` before any geospatial library import. In practice, place the sync call at the very top of your CLI entry point module, before all other imports.

</details>

<details class="faq-item">
<summary>Should I use pydantic-settings or plain python-dotenv?</summary>

`pydantic-settings` when you need type coercion, nested model validation, and the `field_validator` path-existence checks demonstrated in this guide. `python-dotenv` alone when you have a trivial script with no type-safety requirements and do not need cross-platform path normalization. For any tool that will run in CI or be used by more than one developer, `pydantic-settings` pays for itself immediately through explicit `ValidationError` messages.

</details>

<details class="faq-item">
<summary>How do I prevent .env values from overwriting CI secrets?</summary>

`pydantic-settings` respects the shell environment over `.env` by default when `env_ignore_empty=True` is set. A CI runner injects secrets as shell variables before your process starts; those shell variables appear in `os.environ` at process start and take precedence over `.env` file entries. The `env_ignore_empty=True` option additionally prevents an empty `GDAL_DATA=""` from silently shadowing a meaningful value.

</details>

<details class="faq-item">
<summary>Do child processes spawned with subprocess.run inherit os.environ mutations?</summary>

On POSIX (Linux/macOS with `fork`), yes — forked children inherit the parent's full environment as it existed at fork time. On Windows, or when using the `spawn` start method (the macOS default since Python 3.8), the child serializes the environment at `Process.start()` time. Mutations after that are invisible to the child. Always pass `env=os.environ.copy()` explicitly to `subprocess.run()` to be portable across platforms.

</details>

<details class="faq-item">
<summary>Can I override GDAL_DATA per subcommand without mutating the global os.environ?</summary>

Yes. Build a modified copy of the environment dict for that specific `subprocess.run()` call:

```python
per_job_env = os.environ.copy()
per_job_env["GDAL_DATA"] = str(override_path)
subprocess.run(cmd, env=per_job_env, check=True)
```

The parent process's `os.environ` remains unchanged, and the override is scoped to that one subprocess invocation. For `multiprocessing.Pool` workers, use the `initializer` pattern shown earlier in this page.

</details>

---

## Related

- [Managing GDAL and PROJ Environment Variables Across Shells](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/managing-gdal-and-proj-env-vars-across-shells/) — keep `GDAL_DATA`, `PROJ_LIB`, and `GDAL_CACHEMAX` consistent across bash, zsh, Docker, and CI.
- [Loading .env Files in a Geospatial CLI](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/loading-dotenv-files-in-a-geospatial-cli/) — load a `.env` before rasterio imports so GDAL and PROJ variables take effect without leaking secrets.
- [Configuration File Management for GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) — extend the precedence chain with TOML/YAML project-level config files that layer beneath environment variables.
- [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) — wire CLI flags into the top of the precedence chain so explicit user arguments always override synced environment values.
- [Click vs Typer for Geospatial Workflows](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) — framework comparison that influences how you expose `--env-file` and config-check subcommands.
- [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) — parent guide covering the full configuration layer, subcommand organization, and observability patterns for production GIS toolchains.
