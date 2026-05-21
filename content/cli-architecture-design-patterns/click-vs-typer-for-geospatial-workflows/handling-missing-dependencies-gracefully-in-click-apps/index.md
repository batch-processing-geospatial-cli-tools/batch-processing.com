# Handling Missing Dependencies Gracefully in Click Apps

Handling missing dependencies gracefully in Click apps requires deferring heavy imports until command execution, wrapping them in structured `try/except` blocks, and routing failures to explicit fallback paths or degraded execution modes. By isolating C-compiled geospatial libraries behind lazy loaders and leveraging Click’s built-in exception hierarchy, you prevent startup crashes while preserving CLI discoverability, tab completion, and help text generation for batch processing pipelines.

## Why Geospatial CLIs Crash Before Argument Parsing

Geospatial Python ecosystems depend heavily on compiled extensions (`rasterio`, `GDAL`, `shapely`, `fiona`, `pyproj`). When these packages are imported at the module level, the Python interpreter immediately attempts to load their underlying shared libraries (`.so`, `.dll`, `.dylib`). If the host environment lacks system-level dependencies or ABI-compatible wheels, Python raises an `ImportError` or `OSError` before Click can initialize its command router.

This startup failure breaks three critical developer workflows:
- **Help text & subcommand discovery:** `--help` fails, blocking onboarding and self-documentation.
- **Shell completion:** Autocompletion scripts crash, degrading UX for power users.
- **Container portability:** Lightweight base images cannot run core utilities without pulling multi-gigabyte GIS wheels.

Deferring imports until the exact command that requires them is invoked aligns with established [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) that prioritize resilience in distributed batch environments. It also decouples environment provisioning from CLI routing, allowing teams to ship a single binary that adapts to available system libraries.

## Core Strategy: Lazy Loading + Structured Error Routing

A production-ready approach combines three techniques:

1. **Lazy import functions:** Wrap heavy dependencies in dedicated loader functions. This isolates `ImportError` to runtime rather than parse-time.
2. **Click exception routing:** Convert raw Python exceptions into `click.UsageError` or `click.ClickException` ([official Click exception docs](https://click.palletsprojects.com/en/8.1.x/api/#click.ClickException)). This ensures failures surface as clean, actionable CLI messages instead of unhandled tracebacks.
3. **Graceful degradation:** Provide pure-Python fallbacks for lightweight operations (e.g., metadata inspection, path validation) so the CLI remains partially functional when heavy GIS stacks are absent.

## Production-Ready Implementation

The following pattern demonstrates a complete Click group that handles missing `geopandas` and `rasterio` gracefully. It uses lazy loaders, explicit error routing, and a fallback command for environments without compiled GIS bindings.

```python
import sys
import click

@click.group()
@click.version_option("2.1.0")
def gis_batch():
    """Geospatial batch processing toolkit with graceful dependency fallbacks."""
    pass

def _load_geopandas():
    """Lazy import with explicit, actionable error messaging."""
    try:
        import geopandas as gpd
        return gpd
    except ImportError as e:
        raise click.UsageError(
            f"Missing dependency: {e}. Install via: pip install geopandas"
        )

def _load_rasterio():
    """Lazy import with environment-aware installation hints."""
    try:
        import rasterio
        return rasterio
    except ImportError as e:
        raise click.UsageError(
            f"Missing dependency: {e}. "
            f"Install via: pip install rasterio (or conda install rasterio for GDAL bindings)"
        )

@gis_batch.command()
@click.argument("input_raster", type=click.Path(exists=True))
@click.option("--threshold", "-t", type=float, default=0.5, help="Binarization threshold")
@click.option("--output", "-o", type=click.Path(), required=True)
def raster_to_vector(input_raster, threshold, output):
    """Convert raster masks to vector polygons (requires rasterio + geopandas)."""
    rasterio = _load_rasterio()
    gpd = _load_geopandas()

    try:
        with rasterio.open(input_raster) as src:
            data = src.read(1)
            # Placeholder processing logic
            print(f"Processing {input_raster} at threshold {threshold} -> {output}")
    except Exception as e:
        raise click.ClickException(f"Raster processing failed: {e}")

@gis_batch.command()
@click.argument("path", type=click.Path(exists=True))
def inspect(path):
    """Lightweight metadata inspection using pure-Python fallbacks."""
    # No heavy imports required; works in minimal environments
    import os
    stat = os.stat(path)
    print(f"File: {path} | Size: {stat.st_size} bytes | Modified: {stat.st_mtime}")
```

## Implementing Degraded Execution Modes

When full GIS stacks are unavailable, CLIs should degrade intelligently rather than fail completely. Implement degraded modes by:

- **Checking `sys.modules` before loading:** Use `if "rasterio" in sys.modules:` to skip redundant imports in long-running daemon processes.
- **Providing `--dry-run` flags:** Allow users to validate arguments, paths, and configurations without triggering heavy computation.
- **Falling back to standard library tools:** Use `os`, `pathlib`, `json`, or `xml.etree.ElementTree` for metadata parsing when `GDAL`/`pyproj` are missing.
- **Caching import results:** Store successfully loaded modules in a module-level cache dictionary to avoid repeated `try/except` overhead in command loops.

For dynamic loading scenarios where package names are determined at runtime, Python’s `importlib` ([official documentation](https://docs.python.org/3/library/importlib.html)) provides a safe alternative to bare `import` statements, though `try/except` remains the most readable pattern for CLI entry points.

## Testing & Containerization Strategy

Validate graceful degradation across environments using these practices:

1. **Isolated test matrices:** Run `pytest` with `tox` or GitHub Actions across Python 3.9–3.12, explicitly uninstalling heavy dependencies in specific jobs to verify fallback paths.
2. **Mock import failures:** Use `unittest.mock.patch.dict(sys.modules, {"rasterio": None})` to simulate missing packages without modifying the host environment.
3. **Multi-stage Docker builds:** 
 - Stage 1: Install system dependencies (`libgdal-dev`, `proj-bin`, `geos`) and compile wheels.
 - Stage 2: Copy only the CLI entry point and pure-Python dependencies into an `alpine` or `slim` base image.
 - Verify `--help` and fallback commands execute successfully in the minimal image.
4. **CI linting for top-level imports:** Enforce `flake8` or `ruff` rules that flag module-level imports of known-heavy packages (`ruff check --select=I001` combined with custom import-order rules).

## Framework Context: Click vs Typer for GIS Workflows

While Click provides mature exception routing and explicit command grouping, some teams prefer type-hint-driven frameworks for geospatial pipelines. When evaluating [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/), note that both support lazy loading, but Click’s `click.UsageError` and `click.ClickException` hierarchy offers finer-grained control over exit codes and user-facing error formatting. Typer relies on FastAPI/Pydantic validation, which can introduce additional import overhead at startup. For internal tooling and DevOps pipelines where startup latency and minimal footprint matter, Click’s explicit lazy-loading pattern remains the most predictable choice.