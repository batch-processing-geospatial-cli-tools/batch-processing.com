---
title: "Adding Auto-Completion to Python Spatial CLI Tools"
description: "Step-by-step guide to enabling shell tab completion in Typer-based Python GIS CLIs, with dynamic completers for file paths, EPSG codes, and spatial formats."
slug: "adding-auto-completion-to-python-spatial-cli-tools"
type: "long_tail"
breadcrumb:
  - label: "CLI Architecture & Design Patterns"
    url: "/cli-architecture-design-patterns/"
  - label: "Argument Parsing with Typer"
    url: "/cli-architecture-design-patterns/argument-parsing-with-typer/"
  - label: "Adding Auto-Completion to Python Spatial CLI Tools"
    url: "/cli-architecture-design-patterns/argument-parsing-with-typer/adding-auto-completion-to-python-spatial-cli-tools/"
datePublished: "2024-03-15"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Adding Auto-Completion to Python Spatial CLI Tools",
      "description": "Step-by-step guide to enabling shell tab completion in Typer-based Python GIS CLIs, with dynamic completers for file paths, EPSG codes, and spatial formats.",
      "datePublished": "2024-03-15",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 2, "name": "Argument Parsing with Typer", "item": "https://batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/"},
        {"@type": "ListItem", "position": 3, "name": "Adding Auto-Completion to Python Spatial CLI Tools", "item": "https://batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/adding-auto-completion-to-python-spatial-cli-tools/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Add Shell Tab Completion to a Typer Spatial CLI",
      "step": [
        {"@type": "HowToStep", "position": 1, "name": "Write lightweight dynamic completer functions", "text": "Define pure functions that return filtered lists of spatial file paths, EPSG codes, or format names within the shell timeout window."},
        {"@type": "HowToStep", "position": 2, "name": "Bind completers to Typer parameters via shell_complete", "text": "Pass each completer as the shell_complete argument on typer.Argument or typer.Option."},
        {"@type": "HowToStep", "position": 3, "name": "Generate and register the shell completion script", "text": "Run --install-completion for interactive use, or --show-completion to export a static script for system-wide deployment."},
        {"@type": "HowToStep", "position": 4, "name": "Verify completion is active", "text": "Source the config file and press TAB after a partial path or flag to confirm suggestions appear."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does TAB completion return nothing even after --install-completion?",
          "acceptedAnswer": {"@type": "Answer", "text": "The most common cause is a missing or unclosed source line in ~/.bashrc or ~/.zshrc. Run `type _spatial_cli_completion` in your shell — if it returns 'not found', the script was not sourced. Also check that shellingham is installed (`pip show shellingham`); without it, Typer cannot detect the active shell."}
        },
        {
          "@type": "Question",
          "name": "Can completer functions import rasterio or geopandas?",
          "acceptedAnswer": {"@type": "Answer", "text": "Avoid it. The shell spawns a fresh Python subprocess for every TAB press, and GDAL driver registration alone can take 200–400 ms on cold starts — well above the shell's completion timeout. Cache any expensive lookups outside the hot path using functools.lru_cache or a pre-built SQLite index."}
        },
        {
          "@type": "Question",
          "name": "How do I distribute completion scripts to a team?",
          "acceptedAnswer": {"@type": "Answer", "text": "Export a static script with --show-completion bash > completions/my_tool.bash, commit it to the repository, and add a post-install step (e.g. a Makefile target or pip post-install hook) that sources the file from /etc/profile.d/ or the user's shell config."}
        }
      ]
    }
  ]
}
</script>

Tab completion in a Typer spatial CLI requires three things: completer functions that resolve paths or EPSG codes in under 200 ms, binding those functions to parameters via `shell_complete`, and registering the generated script in the user's shell config. Install `typer[all]` (which pulls in `shellingham`) and run `--install-completion` to activate. This page is part of the [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) guide under [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/).

## Prerequisites

- Python 3.9+ with `pip install "typer[all]"` — the `[all]` extra includes `shellingham` (shell detection) and `rich` (help formatting)
- A working Typer app; if you are starting from scratch, see [How to Build a Typer CLI for Shapefile Conversion](/cli-architecture-design-patterns/argument-parsing-with-typer/how-to-build-a-typer-cli-for-shapefile-conversion/)
- Bash 4+, Zsh 5+, or Fish 3+ — the three shells Typer's completion engine supports natively

No rasterio, geopandas, or GDAL is needed for completion itself; keep those imports out of completer functions entirely.

## How the Completion Subprocess Works

<svg viewBox="0 0 640 220" role="img" aria-label="Diagram showing how the shell completion subprocess works for a Typer spatial CLI" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;display:block;margin:1.5rem 0">
  <title>Shell completion subprocess flow for a Typer spatial CLI</title>
  <desc>User presses TAB; shell sets COMP_WORDS env var and spawns a fresh Python subprocess running the CLI in completion mode; the completer function returns a list of strings; the subprocess exits and the shell displays the suggestions.</desc>
  <defs>
    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="currentColor" opacity="0.7"/>
    </marker>
  </defs>
  <!-- boxes -->
  <rect x="10" y="80" width="120" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="70" y="100" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">User presses</text>
  <text x="70" y="116" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">TAB</text>
  <rect x="180" y="60" width="140" height="68" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="250" y="84" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Shell sets</text>
  <text x="250" y="100" text-anchor="middle" font-size="11" fill="currentColor" font-family="monospace">COMP_WORDS</text>
  <text x="250" y="116" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">&amp; spawns subprocess</text>
  <rect x="370" y="60" width="140" height="68" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="440" y="84" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Python subprocess</text>
  <text x="440" y="100" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">runs completer fn</text>
  <text x="440" y="116" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">(must finish &lt;200 ms)</text>
  <rect x="560" y="80" width="68" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="594" y="100" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Shell</text>
  <text x="594" y="116" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">shows list</text>
  <!-- arrows -->
  <line x1="130" y1="104" x2="178" y2="104" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.7"/>
  <line x1="320" y1="94" x2="368" y2="94" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.7"/>
  <line x1="510" y1="94" x2="558" y2="94" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.7"/>
  <!-- isolation note -->
  <rect x="370" y="148" width="140" height="34" rx="4" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.4"/>
  <text x="440" y="163" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.8">isolated — no shared</text>
  <text x="440" y="176" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif" opacity="0.8">runtime state</text>
  <line x1="440" y1="128" x2="440" y2="147" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
</svg>

The shell passes the partial command line via environment variables (`COMP_WORDS`, `_TYPER_COMPLETE_ARGS`), spawns your CLI as a subprocess, and collects its stdout within a hard timeout (typically 100–200 ms). Because the subprocess starts cold, any import that triggers GDAL driver registration or loads a large GeoDataFrame will silently blow past that limit — no error, just no suggestions.

## Complete Working Implementation

The following module is self-contained. Copy it to `spatial_cli.py`, install the dependency, and run `python spatial_cli.py --install-completion`.

```python
# spatial_cli.py
from __future__ import annotations

import functools
from pathlib import Path
from typing import List

import typer

app = typer.Typer(
    name="spatial-cli",
    help="Geospatial batch processing toolkit with shell completion.",
    add_completion=True,   # (1) exposes --install-completion and --show-completion
)

# ---------------------------------------------------------------------------
# Completer functions — must be pure, fast, and import-free of heavy GIS libs
# ---------------------------------------------------------------------------

SUPPORTED_FORMATS: List[str] = [
    "GeoTIFF", "Shapefile", "GeoPackage", "NetCDF", "GeoJSON", "FlatGeobuf"
]

# EPSG codes that cover the most common GIS CRS choices;
# extend or replace with a lightweight SQLite lookup for broader coverage.
EPSG_REGISTRY: List[str] = [
    "EPSG:4326",   # WGS 84 geographic
    "EPSG:3857",   # Web Mercator
    "EPSG:32633",  # UTM zone 33N
    "EPSG:32632",  # UTM zone 32N
    "EPSG:26918",  # UTM zone 18N (NAD83)
    "EPSG:27700",  # British National Grid
]

SPATIAL_EXTS = frozenset({".tif", ".tiff", ".shp", ".gpkg", ".geojson", ".nc", ".fgb"})


def complete_formats(ctx: typer.Context, param: typer.CallbackParam, incomplete: str) -> List[str]:  # (2)
    """Return spatial format names that start with the partial input."""
    return [f for f in SUPPORTED_FORMATS if f.lower().startswith(incomplete.lower())]


def complete_crs(ctx: typer.Context, param: typer.CallbackParam, incomplete: str) -> List[str]:
    """Return EPSG codes matching the partial string."""
    return [c for c in EPSG_REGISTRY if incomplete.upper() in c.upper()]


@functools.lru_cache(maxsize=64)   # (3) cache per unique parent-dir string
def _list_spatial_files(parent: str) -> List[str]:
    try:
        return [
            str(p) for p in Path(parent).iterdir()
            if p.suffix.lower() in SPATIAL_EXTS
        ]
    except (PermissionError, NotADirectoryError):
        return []


def complete_paths(ctx: typer.Context, param: typer.CallbackParam, incomplete: str) -> List[str]:
    """Suggest .tif/.shp/.gpkg/.geojson files relative to the partial path."""
    p = Path(incomplete)
    parent = str(p.parent) if p.parent != Path(".") else "."
    candidates = _list_spatial_files(parent)
    return [c for c in candidates if Path(c).name.startswith(p.name)]


# ---------------------------------------------------------------------------
# CLI command
# ---------------------------------------------------------------------------

@app.command()
def process(
    input_path: Path = typer.Argument(
        ...,
        help="Path to the input raster (.tif) or vector (.gpkg, .shp) dataset.",
        shell_complete=complete_paths,   # (4)
    ),
    output_format: str = typer.Option(
        "GeoTIFF",
        "--format", "-f",
        help="Output spatial format.",
        shell_complete=complete_formats,
    ),
    target_crs: str = typer.Option(
        "EPSG:4326",
        "--crs", "-c",
        help="Target coordinate reference system as an EPSG code.",
        shell_complete=complete_crs,
    ),
) -> None:
    """Reproject and convert a spatial dataset to the requested format and CRS."""
    typer.echo(f"Input : {input_path}")
    typer.echo(f"Format: {output_format}")
    typer.echo(f"CRS   : {target_crs}")
    # Replace this block with rasterio.open / pyogrio.read_dataframe logic.


if __name__ == "__main__":
    app()
```

## Step Annotations

**(1) `add_completion=True`** is the default, but setting it explicitly makes the intent clear and is required if you ever construct the app with `add_completion=False` during testing.

**(2) Completer signature** — modern Typer (≥ 0.9) passes `(ctx, param, incomplete)`. Older examples you may find online use only `(incomplete,)`, which still works but skips context access. Prefer the three-argument form for forward compatibility.

**(3) `functools.lru_cache` on `_list_spatial_files`** caches the directory listing between rapid successive TAB presses. The cache key is the parent directory string, so scanning `/data/project/` only triggers one `iterdir()` call per shell session rather than one per keystroke.

**(4) `shell_complete=complete_paths`** replaces the legacy `autocompletion=` keyword used in Click 7 and early Typer versions. Using `autocompletion=` on Typer ≥ 0.9 raises a `DeprecationWarning` and will be removed in a future release.

## Registering the Completion Script

### Interactive install (personal tooling)

```bash
python spatial_cli.py --install-completion
# Restart the shell or run:
source ~/.bashrc   # Bash
source ~/.zshrc    # Zsh
```

Typer uses `shellingham` to detect the active shell automatically and appends the source line to the correct config file.

### Static export (team distribution)

```bash
# Export once and commit the file:
python spatial_cli.py --show-completion bash > completions/spatial_cli.bash
python spatial_cli.py --show-completion zsh  > completions/spatial_cli.zsh

# System-wide activation (Linux):
sudo cp completions/spatial_cli.bash /etc/profile.d/spatial_cli_completion.sh
```

For containerised environments or [configuration-managed deployments](/cli-architecture-design-patterns/configuration-file-management/), source the script from your `Dockerfile`'s shell config rather than relying on `--install-completion` inside the container build.

## Named Gotcha: Missing `shellingham` Breaks Detection

**Symptom:** `--install-completion` exits silently without modifying any shell config file, or raises `ImportError: No module named 'shellingham'`.

**Cause:** Installing `typer` without extras (`pip install typer`) skips `shellingham`. Typer then cannot identify the active shell and writes nothing.

**Fix:**

```bash
pip install "typer[all]"
# Verify shellingham is present:
python -c "import shellingham; print(shellingham.detect_shell())"
# Expected output: ('bash', '/bin/bash') or ('zsh', '/usr/bin/zsh')
```

If you are in a locked virtual environment where you cannot change the install, pass the shell name explicitly:

```bash
python spatial_cli.py --install-completion bash
python spatial_cli.py --install-completion zsh
```

## Verification

After sourcing the config file, confirm that all three parameter types resolve correctly:

```bash
# 1. Spatial file path completion — should list .tif/.gpkg/.shp files in ./data/
python spatial_cli.py process data/<TAB>

# 2. Format completion
python spatial_cli.py process data/input.tif --format Geo<TAB>
# Expected: GeoTIFF  GeoPackage  GeoJSON

# 3. CRS completion
python spatial_cli.py process data/input.tif --crs EPSG:32<TAB>
# Expected: EPSG:3257  EPSG:32633  EPSG:32632

# 4. Smoke-test the completion subprocess directly (Bash):
COMP_WORDS="spatial_cli process data/in" COMP_CWORD=2 \
  _TYPER_COMPLETE_ARGS="process data/in" \
  _SPATIAL_CLI_COMPLETE=bash_complete \
  python spatial_cli.py
```

If step 4 returns no output, the completer function is either raising an unhandled exception or timing out. Add a `try/except Exception` guard inside `complete_paths` and log to `/tmp/comp_debug.log` to capture the error without disturbing the shell.

<details class="faq-item">
<summary>Why does completion work in my terminal but not in a Docker container?</summary>

Containers built with `FROM python:3.x-slim` often lack the Bash `bash-completion` package. Install it in the `Dockerfile` (`apt-get install -y bash-completion`) and ensure your `ENTRYPOINT` or shell config sources `/etc/profile.d/`. Also confirm that `shellingham` can detect the shell inside the container — some minimal images replace `/bin/bash` with `dash`, which Typer does not support for completion.

</details>

<details class="faq-item">
<summary>Can I complete subcommand names as well as flags?</summary>

Yes — Typer generates subcommand completion automatically when you register sub-apps with `app.add_typer(sub_app, name="subcommand")`. No additional `shell_complete` callback is needed; the completion engine introspects the registered command tree at TAB time. For the broader subcommand structure, see [CLI Subcommand Organization](/cli-architecture-design-patterns/cli-subcommand-organization/).

</details>

<details class="faq-item">
<summary>How do I surface EPSG codes from a live pyproj database without blocking the shell?</summary>

Build a one-time index at tool install time rather than at completion time. A post-install script can query `pyproj.database.query_crs_info()`, write all authority codes to a local SQLite file, and then your completer reads from that file with a fast `LIKE` query. A cold SQLite lookup over 6,000 EPSG codes completes in under 5 ms — well within the shell timeout. Refresh the index with a `--rebuild-crs-cache` flag users can run manually after updating `pyproj`.

</details>

---

## Related

- [Argument Parsing with Typer for GIS CLI Tools](/cli-architecture-design-patterns/argument-parsing-with-typer/) — parent guide covering type-safe parameter definitions, validators, and help text generation
- [How to Build a Typer CLI for Shapefile Conversion](/cli-architecture-design-patterns/argument-parsing-with-typer/how-to-build-a-typer-cli-for-shapefile-conversion/) — sibling page that builds the CLI this page adds completion to
- [CLI Subcommand Organization](/cli-architecture-design-patterns/cli-subcommand-organization/) — structuring multi-command tools so completion works across the full command tree
