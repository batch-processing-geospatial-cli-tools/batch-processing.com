# Managing YAML Configs for Geospatial CLI Workflows

Managing YAML configs for geospatial CLI workflows requires enforcing strict schema validation, separating environment-specific overrides from static spatial parameters, and implementing deterministic fallback chains. By combining `PyYAML` with a validation layer like `Pydantic` and leveraging environment-aware path resolution, you can build reproducible GIS pipelines that handle coordinate reference systems, GDAL/OGR drivers, and batch file globbing without runtime surprises. The core principle is treating your configuration as a version-controlled contract rather than a loose key-value store, which prevents silent failures when processing terabytes of raster or vector data across distributed environments.

## Architecture & Precedence Rules

Geospatial batch processing demands configuration files that express nested spatial parameters (bounding boxes, CRS definitions, tiling grids, driver options) while remaining human-readable. YAML’s hierarchical structure maps cleanly to Python dictionaries, making it ideal for defining complex processing chains. Effective [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) in this domain means validating every loaded document against a strict schema before it touches GDAL, rasterio, or geopandas.

Without validation, a typo in an EPSG code or a malformed path glob can cascade into corrupted outputs or silent coordinate shifts. Modern Python GIS CLIs should parse YAML into typed models, resolve relative paths to absolute system paths, and inject GDAL environment variables before any I/O occurs. This approach aligns with established [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) where configuration precedence follows a strict hierarchy:

1. **CLI Flags** (highest priority, explicit user intent)
2. **Environment Variables** (CI/CD or deployment overrides)
3. **YAML Config** (project defaults and spatial parameters)
4. **Hardcoded Defaults** (fallbacks baked into the schema)

This cascade ensures that local development uses sensible defaults while production deployments can safely override thread counts, cache limits, or output directories without modifying version-controlled files.

## Production-Ready Implementation

The following example demonstrates a validated, environment-aware pattern using `click`, `pyyaml`, and `pydantic` (v2). It loads a YAML config, validates spatial parameters, resolves paths, applies GDAL runtime settings, and prepares a batch execution context.

```python
import os
import glob
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator, ValidationError
import yaml
import click

class GdalEnv(BaseModel):
    """GDAL/OGR runtime environment overrides."""
    GDAL_CACHEMAX: int = Field(default=256, description="MB of RAM cache")
    GDAL_NUM_THREADS: int = Field(default=4, description="Parallel processing threads")
    OGR_ENABLE_PARTIAL_REPROJECTION: bool = Field(default=True)

class SpatialParams(BaseModel):
    src_crs: str = Field(default="EPSG:4326")
    dst_crs: str = Field(default="EPSG:3857")
    resampling: str = Field(default="bilinear")
    tile_size: int = Field(default=512, ge=128, le=4096)

    @field_validator("src_crs", "dst_crs")
    @classmethod
    def validate_crs(cls, v: str) -> str:
        if not (v.startswith("EPSG:") or v.startswith("PROJ:")):
            raise ValueError("CRS must be a valid EPSG or PROJ string")
        return v

class BatchConfig(BaseModel):
    workspace: Path
    input_glob: str
    output_dir: Path
    gdal: GdalEnv = Field(default_factory=GdalEnv)
    spatial: SpatialParams = Field(default_factory=SpatialParams)

    @field_validator("workspace", "output_dir")
    @classmethod
    def resolve_paths(cls, v: Path) -> Path:
        return v.resolve()

    def apply_gdal_env(self) -> None:
        """Inject GDAL configuration before any raster/vector I/O."""
        for key, value in self.gdal.model_dump().items():
            os.environ[key] = str(value)

    def resolve_inputs(self) -> List[Path]:
        pattern = str(self.workspace / self.input_glob)
        return sorted(Path(p) for p in glob.glob(pattern))

@click.command()
@click.option("--config", "cfg_path", type=click.Path(exists=True), required=True)
@click.option("--threads", type=int, default=None, help="Override GDAL_NUM_THREADS")
def run_pipeline(cfg_path: str, threads: Optional[int] = None) -> None:
    """Load, validate, and execute a geospatial batch pipeline."""
    with open(cfg_path, "r") as f:
        raw = yaml.safe_load(f)

    # Apply CLI overrides into the raw dict before validation
    if threads is not None:
        raw.setdefault("gdal", {})["GDAL_NUM_THREADS"] = threads

    try:
        config = BatchConfig(**raw)
    except ValidationError as e:
        click.echo(f"Configuration validation failed:\n{e}", err=True)
        raise click.Abort()

    config.apply_gdal_env()
    inputs = config.resolve_inputs()

    if not inputs:
        click.echo("No input files matched the glob pattern.", err=True)
        raise click.Abort()

    click.echo(f"Processing {len(inputs)} files with {config.spatial.resampling} resampling.")
    # Pipeline execution logic follows here
```

## Validation & Fallback Strategies

Schema validation is your first line of defense against silent data corruption. When working with spatial data, you must enforce constraints that match the underlying C++ libraries. For example, GDAL’s [configuration options](https://gdal.org/user/configoptions.html) dictate memory allocation, thread behavior, and driver fallbacks. Injecting these via `os.environ` before calling `rasterio.open()` or `osgeo.ogr` ensures consistent behavior across local machines, CI runners, and cloud instances.

Pydantic’s `Field` constraints (`ge`, `le`, `pattern`) catch invalid tile sizes, malformed CRS strings, or out-of-range cache values at parse time rather than during expensive raster operations. You can extend this by adding custom validators that verify file existence, check disk space, or validate bounding box coordinates against known extents.

Fallback chains should be explicit and logged. When a YAML key is missing, the schema default activates. When an environment variable is set, it should override both YAML and defaults. Implement a lightweight audit logger that prints the resolved configuration tree at startup:

```python
import logging
log = logging.getLogger(__name__)
log.info("Resolved config: %s", config.model_dump_json(indent=2))
```

This practice eliminates the "works on my machine" problem by making the exact runtime parameters visible in CI logs and production dashboards.

## Testing & CI Integration

Treat configuration files as test fixtures. Store sample YAML files in a `tests/fixtures/` directory and write unit tests that assert:
- Invalid CRS strings raise `ValidationError`
- Missing required keys fail fast
- Path resolution correctly expands `~` and relative directories
- CLI flags successfully override nested YAML values

Use `pytest` with `pydantic`’s `model_validate()` to test edge cases without invoking heavy GIS libraries. For end-to-end validation, run your CLI against a small synthetic dataset in GitHub Actions or GitLab CI. This catches driver incompatibilities, permission issues, and globbing mismatches before they reach production.

By enforcing strict schemas, isolating environment overrides, and logging resolved states, you transform YAML from a fragile text file into a deterministic control plane for geospatial processing. This architecture scales cleanly from single-machine scripts to distributed cloud pipelines, ensuring that every raster and vector operation executes with predictable, auditable parameters.