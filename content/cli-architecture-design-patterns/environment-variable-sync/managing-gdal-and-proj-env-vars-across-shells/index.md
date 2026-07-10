---
title: "Managing GDAL and PROJ Environment Variables Across Shells"
description: "Keep GDAL_DATA, PROJ_LIB, and GDAL_CACHEMAX consistent across bash, zsh, Docker, and CI so a geospatial CLI behaves identically in every environment."
slug: "managing-gdal-and-proj-env-vars-across-shells"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Environment Variable Sync for Python GIS CLI Tools"
    url: "/cli-architecture-design-patterns/environment-variable-sync/"
  - label: "Managing GDAL and PROJ Environment Variables Across Shells"
    url: "/cli-architecture-design-patterns/environment-variable-sync/managing-gdal-and-proj-env-vars-across-shells/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Managing GDAL and PROJ Environment Variables Across Shells",
      "description": "Keep GDAL_DATA, PROJ_LIB, and GDAL_CACHEMAX consistent across bash, zsh, Docker, and CI so a geospatial CLI behaves identically in every environment.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Environment Variable Sync for Python GIS CLI Tools", "item": "https://batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/"},
        {"@type": "ListItem", "position": 3, "name": "Managing GDAL and PROJ Environment Variables Across Shells", "item": "https://batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/managing-gdal-and-proj-env-vars-across-shells/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Keep GDAL and PROJ environment variables consistent across shells",
      "step": [
        {"@type": "HowToStep", "name": "Detect the real data directories", "text": "Resolve GDAL_DATA and PROJ_DATA at runtime from pyproj.datadir.get_data_dir() and rasterio._env.GDALDataFinder rather than hardcoding paths."},
        {"@type": "HowToStep", "name": "Set os.environ defaults before GDAL initialises", "text": "Assign the detected paths to os.environ with setdefault before importing osgeo.gdal so the C library reads correct values on first use."},
        {"@type": "HowToStep", "name": "Mirror the paths as shell exports", "text": "Emit equivalent export lines for bash and zsh so interactive shells, Docker images, and CI runners share one source of truth."},
        {"@type": "HowToStep", "name": "Verify the resolved directories", "text": "Run projinfo EPSG:4326 and print the resolved dirs to confirm proj.db is found and datum shifts resolve correctly."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why do GDAL_DATA and PROJ_LIB differ between bash and zsh?",
          "acceptedAnswer": {"@type": "Answer", "text": "Each shell sources a different startup file. A path exported in .bashrc is invisible to a zsh login shell that only reads .zshrc, and neither is read by a non-interactive CI runner or a Docker RUN step. When one environment picks up a conda proj.db and another picks up the system one, the same CLI resolves coordinates differently. Detecting the paths in Python removes the dependency on any single shell startup file."}
        },
        {
          "@type": "Question",
          "name": "What causes PROJ: proj_create: Cannot find proj.db?",
          "acceptedAnswer": {"@type": "Answer", "text": "PROJ cannot locate its proj.db grid and CRS database because PROJ_DATA (formerly PROJ_LIB) points at a directory that does not contain the file, or is unset while the library default path is wrong. This usually happens after a conda environment change or a Docker layer that installed a different GDAL build. Setting PROJ_DATA to the value returned by pyproj.datadir.get_data_dir() resolves it."}
        },
        {
          "@type": "Question",
          "name": "Should I use PROJ_LIB or PROJ_DATA?",
          "acceptedAnswer": {"@type": "Answer", "text": "PROJ 9 reads PROJ_DATA and treats PROJ_LIB as a deprecated alias that still works for backward compatibility. On mixed fleets where some machines run PROJ 6 to 8 and others run PROJ 9, set both variables to the same directory so every version finds proj.db. The helper in this guide writes both."}
        },
        {
          "@type": "Question",
          "name": "Why does GDAL_CACHEMAX behave differently on two machines?",
          "acceptedAnswer": {"@type": "Answer", "text": "GDAL_CACHEMAX interprets a bare number as megabytes on some builds and as a percentage of RAM on older ones, so 512 can mean 512 MB or 512 percent depending on the version. Always append an explicit unit such as 512MB to remove the ambiguity, and set the same value in every shell and container so raster block caching performs identically."}
        }
      ]
    }
  ]
}
</script>

# Managing GDAL and PROJ Environment Variables Across Shells

Your GDAL and PROJ variables differ between shells because each shell sources a different startup file, and a Docker or CI environment sources none of them. The fix is to stop hardcoding paths in `.bashrc` and instead detect the correct directories at runtime with `pyproj.datadir.get_data_dir()` and rasterio, then set `os.environ` defaults before `osgeo.gdal` initialises. This page is part of the [Environment Variable Sync for Python GIS CLI Tools](/cli-architecture-design-patterns/environment-variable-sync/) guide within the broader [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install pyproj rasterio` (both bundle a matching PROJ/GDAL build)
- A system or conda GDAL 3.4+ install; the helper works with either

If your paths already live in a config file, pair this with [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) so the detected values become documented defaults rather than hidden shell state.

## What Each Variable Controls

Five variables decide whether a geospatial CLI behaves identically everywhere. When any of them drift between shells, the tool produces different numbers from the same input:

- **`GDAL_DATA`** points at GDAL's support files: EPSG CSV tables, driver templates, and coordinate-system definitions. If it is wrong, `gdal.Warp` fails to look up authority codes.
- **`PROJ_DATA`** (formerly **`PROJ_LIB`**) points at the directory holding `proj.db`, the SQLite database of CRS definitions and datum-shift grids. A wrong value is the direct cause of `PROJ: proj_create: Cannot find proj.db`.
- **`GDAL_CACHEMAX`** sizes the raster block cache. A bare `512` means megabytes on modern builds but percent-of-RAM on older ones, so always write `512MB`.
- **`GDAL_NUM_THREADS`** caps GDAL's internal worker threads. Left at `ALL_CPUS`, it oversubscribes the CPU when a CLI already runs its own worker pool.
- **`CPL_DEBUG`** toggles verbose driver and VSI logging. Setting it to `ON` prints exactly which `proj.db` and data directory the library resolved, which is the fastest way to diagnose a mismatch.

A mismatch on `PROJ_DATA` is the most damaging: if two shells resolve two different `proj.db` files, a transform from `EPSG:4326` to `EPSG:32633` can apply a different datum-shift grid on each machine, so identical inputs yield coordinates that disagree by metres. The library rarely errors; it silently returns the wrong answer.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram showing bash, zsh, Docker and CI each resolving a different proj.db, versus a Python runtime detector that feeds one consistent path to every environment" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Divergent proj.db resolution versus a single runtime detector</title>
  <desc>On the left, four environments named bash, zsh, Docker and CI point to two different proj.db locations, producing inconsistent datum shifts. On the right, a runtime detector reads pyproj and rasterio once and exports one path to all four environments.</desc>
  <!-- Left panel: divergence -->
  <rect x="10" y="10" width="330" height="320" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="175" y="36" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">Hardcoded per shell</text>
  <!-- shells -->
  <rect x="34" y="56" width="82" height="34" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1"/>
  <text x="75" y="77" text-anchor="middle" font-size="11" fill="currentColor">.bashrc</text>
  <rect x="126" y="56" width="82" height="34" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1"/>
  <text x="167" y="77" text-anchor="middle" font-size="11" fill="currentColor">.zshrc</text>
  <rect x="218" y="56" width="86" height="34" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1"/>
  <text x="261" y="77" text-anchor="middle" font-size="11" fill="currentColor">Docker/CI</text>
  <!-- arrows to two dbs -->
  <line x1="75" y1="90" x2="105" y2="150" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.3" marker-end="url(#a1)"/>
  <line x1="167" y1="90" x2="110" y2="150" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.3" marker-end="url(#a1)"/>
  <line x1="261" y1="90" x2="245" y2="150" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.3" marker-end="url(#a1)"/>
  <!-- two db boxes -->
  <rect x="40" y="152" width="130" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="105" y="169" text-anchor="middle" font-size="10" fill="currentColor">conda proj.db</text>
  <text x="105" y="184" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">PROJ 9.x grids</text>
  <rect x="190" y="152" width="120" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="250" y="169" text-anchor="middle" font-size="10" fill="currentColor">system proj.db</text>
  <text x="250" y="184" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">PROJ 6.x grids</text>
  <text x="175" y="238" text-anchor="middle" font-size="20" fill="#c0392b" opacity="0.85">&#9889;</text>
  <text x="175" y="262" text-anchor="middle" font-size="10.5" fill="#c0392b" opacity="0.9">Cannot find proj.db</text>
  <text x="175" y="280" text-anchor="middle" font-size="10.5" fill="#c0392b" opacity="0.9">or wrong datum shift</text>
  <!-- Right panel: detector -->
  <rect x="380" y="10" width="330" height="320" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="545" y="36" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor" opacity="0.9">Detected at runtime</text>
  <!-- detector box -->
  <rect x="430" y="56" width="230" height="46" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="545" y="76" text-anchor="middle" font-size="11" fill="currentColor">sync_geo_env()</text>
  <text x="545" y="91" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">pyproj + rasterio detect paths</text>
  <!-- single db -->
  <line x1="545" y1="102" x2="545" y2="150" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.4" marker-end="url(#a2)"/>
  <rect x="470" y="152" width="150" height="40" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="545" y="169" text-anchor="middle" font-size="10" fill="currentColor">one resolved proj.db</text>
  <text x="545" y="184" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">os.environ + exports</text>
  <!-- fan out to consumers -->
  <line x1="500" y1="192" x2="455" y2="238" stroke="#15803d" stroke-opacity="0.5" stroke-width="1.2" marker-end="url(#a2)"/>
  <line x1="545" y1="192" x2="545" y2="238" stroke="#15803d" stroke-opacity="0.5" stroke-width="1.2" marker-end="url(#a2)"/>
  <line x1="590" y1="192" x2="635" y2="238" stroke="#15803d" stroke-opacity="0.5" stroke-width="1.2" marker-end="url(#a2)"/>
  <rect x="415" y="240" width="80" height="30" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1"/>
  <text x="455" y="259" text-anchor="middle" font-size="10" fill="currentColor">bash/zsh</text>
  <rect x="505" y="240" width="80" height="30" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1"/>
  <text x="545" y="259" text-anchor="middle" font-size="10" fill="currentColor">Docker</text>
  <rect x="595" y="240" width="80" height="30" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1"/>
  <text x="635" y="259" text-anchor="middle" font-size="10" fill="currentColor">CI</text>
  <text x="545" y="298" text-anchor="middle" font-size="20" fill="#15803d" opacity="0.85">&#10003;</text>
  <text x="545" y="318" text-anchor="middle" font-size="10.5" fill="#15803d" opacity="0.9">identical results everywhere</text>
  <defs>
    <marker id="a1" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#c0392b" opacity="0.55"/>
    </marker>
    <marker id="a2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#15803d" opacity="0.6"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The module below is the centerpiece. It detects the correct data directories from the installed Python packages, sets `os.environ` defaults *before* GDAL is imported, and can emit the equivalent shell exports. Save it as `geo_env.py` and import it as the first line of your CLI entry point:

```python
"""geo_env.py — detect and pin GDAL/PROJ paths before GDAL initialises.

Import this module BEFORE any `from osgeo import gdal` or `import rasterio`,
so os.environ is authoritative when the C libraries read their config.
"""
from __future__ import annotations

import os
from pathlib import Path


def _detect_proj_data() -> Path | None:
    """Return the directory that actually contains proj.db.

    pyproj bundles a matching PROJ build and knows where its data lives,
    so this is the single most reliable source of the correct path.
    """
    try:
        from pyproj.datadir import get_data_dir
    except ImportError:
        return None
    candidate = Path(get_data_dir())
    return candidate if (candidate / "proj.db").is_file() else candidate


def _detect_gdal_data() -> Path | None:
    """Return GDAL's support-file directory as rasterio resolves it."""
    try:
        from rasterio._env import GDALDataFinder
    except ImportError:
        return None
    found = GDALDataFinder().search()
    return Path(found) if found else None


def sync_geo_env(cache_mb: int = 512, num_threads: int = 1) -> dict[str, str]:
    """Set GDAL/PROJ env defaults from detected paths. Returns what was set.

    Uses setdefault so an operator-provided value (from a flag, .env file,
    or CI secret) always wins over auto-detection.
    """
    resolved: dict[str, str] = {}

    proj_dir = _detect_proj_data()
    if proj_dir is not None:
        # PROJ 9 reads PROJ_DATA; PROJ_LIB is the legacy alias. Set both so
        # mixed fleets (PROJ 6-8 and PROJ 9) all find proj.db.
        for key in ("PROJ_DATA", "PROJ_LIB"):
            os.environ.setdefault(key, str(proj_dir))
            resolved[key] = os.environ[key]

    gdal_dir = _detect_gdal_data()
    if gdal_dir is not None:
        os.environ.setdefault("GDAL_DATA", str(gdal_dir))
        resolved["GDAL_DATA"] = os.environ["GDAL_DATA"]

    # Always carry an explicit unit — a bare "512" is MB on new builds but
    # percent-of-RAM on old ones. "512MB" is unambiguous everywhere.
    os.environ.setdefault("GDAL_CACHEMAX", f"{cache_mb}MB")
    os.environ.setdefault("GDAL_NUM_THREADS", str(num_threads))
    resolved["GDAL_CACHEMAX"] = os.environ["GDAL_CACHEMAX"]
    resolved["GDAL_NUM_THREADS"] = os.environ["GDAL_NUM_THREADS"]
    return resolved


def as_shell_exports(resolved: dict[str, str]) -> str:
    """Render the resolved env as bash/zsh `export` lines for `eval`."""
    return "\n".join(f'export {k}="{v}"' for k, v in resolved.items())


if __name__ == "__main__":
    # `eval "$(python geo_env.py)"` pins the same paths in an interactive shell.
    print(as_shell_exports(sync_geo_env()))
```

The equivalent shell snippet, for a `.bashrc`/`.zshrc` or a Docker `ENV` layer, derives the paths from the same Python source of truth rather than hardcoding a guess:

```bash
# Pin GDAL/PROJ paths in any POSIX shell from the installed Python packages.
# Works in bash and zsh; drop into a Dockerfile RUN or a CI setup step.
eval "$(python -m geo_env)"

# Or resolve directly without the module, e.g. in a minimal container:
export PROJ_DATA="$(python -c 'import pyproj.datadir as d; print(d.get_data_dir())')"
export PROJ_LIB="$PROJ_DATA"
export GDAL_DATA="$(python -c 'from rasterio._env import GDALDataFinder as G; print(G().search())')"
export GDAL_CACHEMAX="512MB"
export GDAL_NUM_THREADS="1"
```

## Step Annotations

1. **`_detect_proj_data()` reads pyproj first** — pyproj ships with a PROJ build and exposes `get_data_dir()`, which returns the directory PROJ itself would use. This is more reliable than probing filesystem locations because it reflects the exact package that will run the transforms.

2. **`_detect_gdal_data()` uses rasterio's finder** — rasterio's `GDALDataFinder().search()` walks the same resolution order GDAL uses internally, so the returned directory matches the driver that your CLI actually loads, whether it came from conda or the system package.

3. **`setdefault`, not assignment** — every write uses `os.environ.setdefault` so an explicitly provided value always wins. An operator can still override any path with a `--gdal-data` flag or an entry loaded from a `.env` file, keeping detection as the fallback rather than a hard override.

4. **Both `PROJ_DATA` and `PROJ_LIB`** — PROJ 9 reads `PROJ_DATA` and treats `PROJ_LIB` as a deprecated alias. Writing both means a machine still on PROJ 6–8 and a machine on PROJ 9 resolve the identical `proj.db`, which is the whole point of syncing across environments.

5. **`GDAL_CACHEMAX` carries a unit** — the helper writes `512MB`, never a bare number, so the raster block cache is sized identically on every build and you avoid the percent-versus-megabytes ambiguity that silently changes memory behaviour.

6. **Import order is load-bearing** — `sync_geo_env()` must run before `from osgeo import gdal`. GDAL reads these variables when its driver registry initialises on first use; setting them afterward has no effect for the current process.

## Named Gotcha: conda and system GDAL put proj.db in different places

The single most common cause of `PROJ: proj_create: Cannot find proj.db` on a machine that "worked yesterday" is two GDAL builds fighting over the path. A conda or mamba environment installs `proj.db` under `$CONDA_PREFIX/share/proj`, while a system `apt`/`yum` GDAL installs it under `/usr/share/proj`. If your `.bashrc` hardcodes `export PROJ_LIB=/usr/share/proj` but you launch the CLI inside an activated conda environment running PROJ 9, the library loads the conda binary yet is pointed at the system database — a version mismatch that either fails outright or applies the wrong datum-shift grid.

The fix is exactly what `_detect_proj_data()` does: never hardcode the directory. Let `pyproj.datadir.get_data_dir()` report the path for the PROJ build that is actually loaded, so activating or deactivating conda automatically moves the path with it. If you must keep a static export for a container, generate it from the same command at build time rather than copying a literal path between machines.

## Verification

Confirm every environment resolves the same database and that a known transform is correct. Run this in each shell — bash, zsh, the Docker container, and the CI job — and compare:

```bash
# 1. Print the paths Python actually resolved
python -c 'import geo_env, json; print(json.dumps(geo_env.sync_geo_env(), indent=2))'

# 2. Confirm PROJ finds proj.db and can describe a CRS
projinfo EPSG:4326 | head -n 3

# 3. Confirm a datum-shifted transform returns identical numbers everywhere
python - <<'PY'
from pyproj import Transformer
t = Transformer.from_crs("EPSG:4326", "EPSG:32633", always_xy=True)
print("%.4f %.4f" % t.transform(15.0, 50.0))   # deterministic across machines
PY
```

If `projinfo EPSG:4326` prints a CRS block instead of a "Cannot find proj.db" error, and the transform prints the same two numbers in every environment, the sync is correct. To see which files the C library chose, run any command with `CPL_DEBUG=ON` and grep for `PROJ` and `GDAL_DATA` in the output. For turning this into a build-time check, wire the same commands into your [Packaging & CI/CD](/cli-architecture-design-patterns/packaging-and-cicd/) pipeline so a drifted image fails the job before release.

## FAQ

<details class="faq-item">
<summary>Why do GDAL_DATA and PROJ_LIB differ between bash and zsh?</summary>

Each shell sources a different startup file. A path exported in `.bashrc` is invisible to a zsh login shell that only reads `.zshrc`, and neither is read by a non-interactive CI runner or a Docker `RUN` step. When one environment picks up a conda `proj.db` and another picks up the system one, the same CLI resolves coordinates differently. Detecting the paths in Python removes the dependency on any single shell startup file.
</details>

<details class="faq-item">
<summary>What causes PROJ: proj_create: Cannot find proj.db?</summary>

PROJ cannot locate its `proj.db` grid and CRS database because `PROJ_DATA` (formerly `PROJ_LIB`) points at a directory that does not contain the file, or is unset while the library default path is wrong. This usually happens after a conda environment change or a Docker layer that installed a different GDAL build. Setting `PROJ_DATA` to the value returned by `pyproj.datadir.get_data_dir()` resolves it.
</details>

<details class="faq-item">
<summary>Should I use PROJ_LIB or PROJ_DATA?</summary>

PROJ 9 reads `PROJ_DATA` and treats `PROJ_LIB` as a deprecated alias that still works for backward compatibility. On mixed fleets where some machines run PROJ 6 to 8 and others run PROJ 9, set both variables to the same directory so every version finds `proj.db`. The helper in this guide writes both.
</details>

<details class="faq-item">
<summary>Why does GDAL_CACHEMAX behave differently on two machines?</summary>

`GDAL_CACHEMAX` interprets a bare number as megabytes on some builds and as a percentage of RAM on older ones, so `512` can mean 512 MB or 512 percent depending on the version. Always append an explicit unit such as `512MB` to remove the ambiguity, and set the same value in every shell and container so raster block caching performs identically.
</details>

---

## Related

- [Environment Variable Sync for Python GIS CLI Tools](/cli-architecture-design-patterns/environment-variable-sync/) — parent guide covering how GDAL, PROJ, and CLI settings stay consistent across shells, containers, and CI
- [Loading .env Files in a Geospatial CLI](/cli-architecture-design-patterns/environment-variable-sync/loading-dotenv-files-in-a-geospatial-cli/) — layer operator-supplied overrides on top of the detected GDAL and PROJ defaults
