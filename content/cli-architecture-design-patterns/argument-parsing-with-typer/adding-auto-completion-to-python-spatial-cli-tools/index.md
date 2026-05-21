# Adding Auto-Completion to Python Spatial CLI Tools

Adding auto-completion to Python spatial CLI tools requires generating shell-specific completion scripts from your argument parser and registering them in the user’s environment. When building geospatial utilities, static suggestions rarely suffice. You need dynamic completers that resolve file paths, coordinate reference systems (CRS), and spatial formats on-the-fly. Using Typer—which inherits Click’s completion engine—you can enable this with a single `install` command or by exporting a static script. The workflow follows a predictable pattern: define your CLI with custom completion functions, generate the shell integration script, and source it in the target shell’s configuration file. This approach aligns with modern [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) that prioritize developer ergonomics and reduce command-line friction.

## How Completion Engines Handle Geospatial Context

Shell completion intercepts the `TAB` keypress, parses the current command line, and returns a filtered list of suggestions. Typer delegates this to Click’s underlying completion system, which supports Bash, Zsh, and Fish out of the box. For spatial workflows, this means you can surface context-aware suggestions without blocking the main execution thread. The completion engine runs in a separate, ephemeral Python subprocess, so your completer functions must be lightweight and avoid heavy I/O like loading large GeoDataFrames or initializing GDAL drivers.

Because the subprocess inherits the parent environment but not its runtime state, completer functions must be entirely self-contained. They receive an `incomplete` string representing the user’s partial input and must return a list of strings before the shell’s default timeout (typically 100–200ms). This constraint is critical for geospatial tooling, where directory scans or CRS lookups can easily exceed acceptable latency.

## Step 1: Build Lightweight Dynamic Completers

Spatial CLI tools often require domain-specific suggestions. A batch processing command should prioritize `.tif`, `.shp`, or `.gpkg` files, while a projection flag should suggest valid EPSG codes. Typer accepts callable completers that filter suggestions based on the `incomplete` parameter.

```python
# spatial_cli.py
from pathlib import Path
from typing import List
import os

# Lightweight spatial registry for demonstration
SUPPORTED_FORMATS = ["GeoTIFF", "Shapefile", "GeoPackage", "NetCDF", "GeoJSON"]
EPSG_REGISTRY = ["EPSG:4326", "EPSG:3857", "EPSG:32633", "EPSG:26918"]

def complete_formats(incomplete: str) -> List[str]:
    """Filter spatial formats by partial match."""
    return [fmt for fmt in SUPPORTED_FORMATS if incomplete.lower() in fmt.lower()]

def complete_crs(incomplete: str) -> List[str]:
    """Filter EPSG codes by partial match."""
    return [code for code in EPSG_REGISTRY if incomplete.upper() in code.upper()]

def complete_paths(incomplete: str) -> List[str]:
    """Suggest existing spatial files in the current directory."""
    p = Path(incomplete)
    parent = p.parent if p.parent != Path(".") else Path(".")
    if not parent.is_dir():
        return []
    spatial_exts = {".tif", ".tiff", ".shp", ".gpkg", ".geojson", ".nc"}
    try:
        return [
            str(child) for child in parent.iterdir()
            if child.suffix.lower() in spatial_exts
            and incomplete.lower() in child.name.lower()
        ]
    except PermissionError:
        return []
```

**Performance note:** Avoid network calls or heavy `pyproj`/`rasterio` initialization inside completer functions. If you need to query a remote CRS registry or index a directory with thousands of files, cache the results using `functools.lru_cache` or a lightweight SQLite index. The shell expects near-instantaneous responses.

## Step 2: Bind Completers to Typer Parameters

Once your functions are defined, attach them to Typer parameters using the `shell_complete` argument. This replaces the legacy `autocompletion` parameter in Click 8.1+ and ensures forward compatibility across modern Python environments.

```python
import typer

app = typer.Typer(help="Geospatial batch processing toolkit")

@app.command()
def process(
    input_path: Path = typer.Argument(
        ..., help="Input raster or vector dataset", shell_complete=complete_paths
    ),
    output_format: str = typer.Option(
        "GeoTIFF", "--format", "-f", shell_complete=complete_formats
    ),
    target_crs: str = typer.Option(
        "EPSG:4326", "--crs", "-c", shell_complete=complete_crs
    ),
):
    """Batch convert and reproject spatial datasets."""
    typer.echo(f"Processing {input_path} -> {output_format} ({target_crs})")
    # Insert geopandas/rasterio logic here

if __name__ == "__main__":
    app()
```

This structure keeps your [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) implementation clean while decoupling completion logic from business logic. Each completer runs independently, allowing you to swap out registries or add validation layers without touching the core command. You can also attach multiple completers to a single option if your workflow supports chained arguments.

## Step 3: Generate & Register Shell Scripts

After defining your CLI, you must generate the shell-specific completion script and register it. Typer provides two primary methods: interactive installation and static export.

### Interactive Installation
Run the built-in install command to auto-detect your active shell and append the completion hook to your shell configuration:
```bash
python spatial_cli.py install
```
The command detects your shell, generates the appropriate completion wrapper, and reloads the configuration. This is ideal for local development and personal tooling.

### Static Export
Generate a standalone script that you can distribute, version-control, or deploy system-wide:
```bash
# Bash
python spatial_cli.py --install-completion bash > ~/.spatial_cli_completions.bash
echo "source ~/.spatial_cli_completions.bash" >> ~/.bashrc

# Zsh
python spatial_cli.py --install-completion zsh > ~/.spatial_cli_completions.zsh
echo "source ~/.spatial_cli_completions.zsh" >> ~/.zshrc
```
After exporting, run `source ~/.bashrc` (or your shell’s equivalent) to activate completions immediately. Verify the integration by typing `spatial_cli process <TAB>` and confirming that spatial file paths appear. For containerized environments or CI runners, place the sourced script in `/etc/profile.d/` to ensure global availability.

## Spatial-Specific Troubleshooting & Optimization

Even with correct implementation, shell completion can fail silently in geospatial environments. Use these guidelines to maintain reliability:

- **Handle missing dependencies gracefully:** If your completer relies on `pyproj` or `fiona`, wrap imports in `try/except` blocks. Shell completion runs in isolated subprocesses and will fail if optional dependencies aren’t installed. Refer to the official [Click Shell Completion documentation](https://click.palletsprojects.com/en/8.1.x/shell-completion/) for subprocess behavior details.
- **Respect shell quoting rules:** Spatial file paths often contain spaces or special characters. Typer’s completion engine automatically escapes paths, but ensure your completer returns raw strings without extra quotes.
- **Cache expensive lookups:** Querying a large EPSG database or scanning a directory with thousands of `.shp` files will exceed shell timeout limits. Use `functools.lru_cache` to store results between `TAB` presses.
- **Test across shells:** Bash, Zsh, and Fish parse completion scripts differently. Always validate your CLI in all three environments before releasing. The [Typer Shell Completion Guide](https://typer.tiangolo.com/tutorial/options-autocompletion/) outlines environment-specific quirks and debugging steps.
- **Keep completers stateless:** The completion engine spawns a fresh Python process for every `TAB` press. Avoid relying on global state, environment variables, or mutable singletons.

Adding auto-completion to Python spatial CLI tools transforms verbose, error-prone commands into intuitive workflows. By leveraging Typer’s dynamic completion hooks, respecting subprocess isolation, and following shell-specific registration steps, you can deliver professional-grade tooling that scales from local development to enterprise GIS pipelines.