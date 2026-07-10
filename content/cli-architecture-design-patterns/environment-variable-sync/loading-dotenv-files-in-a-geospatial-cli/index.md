---
title: "Loading .env Files in a Geospatial CLI"
description: "Load a .env file with python-dotenv at CLI startup so GDAL, PROJ, and cloud-credential variables are set before rasterio imports, without leaking secrets into logs."
slug: "loading-dotenv-files-in-a-geospatial-cli"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Environment Variable Sync for Python GIS CLI Tools"
    url: "/cli-architecture-design-patterns/environment-variable-sync/"
  - label: "Loading .env Files in a Geospatial CLI"
    url: "/cli-architecture-design-patterns/environment-variable-sync/loading-dotenv-files-in-a-geospatial-cli/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Loading .env Files in a Geospatial CLI",
      "description": "Load a .env file with python-dotenv at CLI startup so GDAL, PROJ, and cloud-credential variables are set before rasterio imports, without leaking secrets into logs.",
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
        {"@type": "ListItem", "position": 3, "name": "Loading .env Files in a Geospatial CLI", "item": "https://batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/loading-dotenv-files-in-a-geospatial-cli/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Load a .env file in a geospatial CLI before rasterio imports",
      "step": [
        {"@type": "HowToStep", "name": "Locate the .env file", "text": "Call find_dotenv() from a bootstrap module so the file is resolved by walking up from the current working directory."},
        {"@type": "HowToStep", "name": "Load before importing rasterio", "text": "Call load_dotenv() at the very top of the entry module, before any import of rasterio or osgeo, so GDAL and PROJ read the variables at their own import time."},
        {"@type": "HowToStep", "name": "Choose override semantics", "text": "Use override=False so real shell and CI environment variables win over the checked-in .env defaults."},
        {"@type": "HowToStep", "name": "Mask secrets in log output", "text": "Redact AWS_SECRET_ACCESS_KEY and similar keys before logging the resolved environment so credentials never reach log files."},
        {"@type": "HowToStep", "name": "Verify the load order", "text": "Print the effective GDAL_DATA and a masked AWS key at startup and confirm a /vsis3/ read succeeds."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why must load_dotenv run before importing rasterio?",
          "acceptedAnswer": {"@type": "Answer", "text": "Rasterio and osgeo read GDAL_DATA, PROJ_DATA, GDAL_CACHEMAX and the AWS_* credentials from os.environ during their own import and driver registration. If load_dotenv runs after that import, the values already read into GDAL's C-level configuration will not change, so the /vsis3/ handler and PROJ transforms use stale or missing settings."}
        },
        {
          "@type": "Question",
          "name": "Should I use override=True or override=False with load_dotenv?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use override=False, which is the default. Real environment variables set by the shell, container, or CI runner then take precedence over the .env file, so production credentials injected by the platform are not clobbered by a checked-in development file. Use override=True only for a deliberate local reset."}
        },
        {
          "@type": "Question",
          "name": "How do I stop .env secrets from leaking into CLI logs?",
          "acceptedAnswer": {"@type": "Answer", "text": "Never log os.environ wholesale. Build a redacted copy that masks any key matching SECRET, TOKEN, PASSWORD or KEY, showing only the last four characters, and log that copy instead. Also add .env to .gitignore so credentials are never committed."}
        },
        {
          "@type": "Question",
          "name": "Where should the .env file live for a CLI run from any directory?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use find_dotenv(), which walks up the directory tree from the current working directory until it finds a .env file. This lets the CLI be invoked from a subfolder of a project and still resolve the project-root .env. Pass an explicit path with a --env-file flag when you need to override that search."}
        }
      ]
    }
  ]
}
</script>

# Loading .env Files in a Geospatial CLI

Load the `.env` file at the very top of your entry module with `python-dotenv` — `load_dotenv(find_dotenv(), override=False)` — before any `import rasterio` or `from osgeo import gdal`. GDAL and PROJ read `GDAL_DATA`, `PROJ_DATA`, `GDAL_CACHEMAX`, and the `AWS_*` credentials for `/vsis3/` at their own import time, so a late load leaves them stale. This page is part of the [Environment Variable Sync for Python GIS CLI Tools](/cli-architecture-design-patterns/environment-variable-sync/) guide within the broader [CLI Architecture & Design Patterns for Python GIS](/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install python-dotenv rasterio` (rasterio 1.3+ ships GDAL 3.4+ wheels)
- A working GDAL, either from the rasterio wheel or a conda/mamba install
- A `.env` file at your project root, listed in `.gitignore`

This page focuses on the `.env` file itself — locating it, loading it in the right order, and keeping secrets out of logs. For the separate question of exporting the same variables as shell profiles or systemd units, see the sibling page on [managing GDAL and PROJ environment variables across shells](/cli-architecture-design-patterns/environment-variable-sync/managing-gdal-and-proj-env-vars-across-shells/). For how `.env` values slot into a wider defaults-then-file-then-flag chain, see [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/).

## The Import-Order Problem

The subtlety that breaks most first attempts is timing. When Python executes `import rasterio`, rasterio imports the GDAL C library, which registers drivers and snapshots configuration from `os.environ` into its own C-level state. `PROJ` does the same for `PROJ_DATA` and the network-CDN grid settings. Anything you inject into `os.environ` *after* that import has already missed the window for those one-time reads.

A `.env` file only mutates `os.environ`. So the `load_dotenv()` call has to run before the first geospatial import in the whole process — including transitive imports pulled in by your CLI framework. The diagram below shows the one correct ordering versus the two failure orderings.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline showing that load_dotenv must run before rasterio import so GDAL reads environment variables correctly, versus a late load that leaves GDAL configuration stale" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Correct versus late dotenv load order relative to the rasterio import</title>
  <desc>Two horizontal timelines. The top timeline loads the .env file first, then imports rasterio, so GDAL reads the variables successfully. The bottom timeline imports rasterio first, so GDAL snapshots an empty environment and the later dotenv load has no effect.</desc>
  <!-- Correct row -->
  <text x="16" y="40" font-size="12" font-weight="600" fill="#15803d">Correct order</text>
  <line x1="16" y1="96" x2="704" y2="96" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.4"/>
  <rect x="30" y="66" width="150" height="46" rx="6" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="105" y="86" text-anchor="middle" font-size="11" fill="currentColor">load_dotenv()</text>
  <text x="105" y="101" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">writes os.environ</text>
  <rect x="285" y="66" width="150" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="360" y="86" text-anchor="middle" font-size="11" fill="currentColor">import rasterio</text>
  <text x="360" y="101" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">GDAL reads env</text>
  <rect x="540" y="66" width="150" height="46" rx="6" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="615" y="86" text-anchor="middle" font-size="11" fill="currentColor">/vsis3/ read</text>
  <text x="615" y="101" text-anchor="middle" font-size="9.5" fill="#15803d" opacity="0.85">AWS creds present</text>
  <path d="M180,89 L283,89" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a)"/>
  <path d="M435,89 L538,89" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a)"/>
  <!-- Wrong row -->
  <text x="16" y="182" font-size="12" font-weight="600" fill="#c0392b">Late load (broken)</text>
  <line x1="16" y1="238" x2="704" y2="238" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.4"/>
  <rect x="30" y="208" width="150" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="105" y="228" text-anchor="middle" font-size="11" fill="currentColor">import rasterio</text>
  <text x="105" y="243" text-anchor="middle" font-size="9.5" fill="#c0392b" opacity="0.85">GDAL reads empty env</text>
  <rect x="285" y="208" width="150" height="46" rx="6" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="360" y="228" text-anchor="middle" font-size="11" fill="currentColor">load_dotenv()</text>
  <text x="360" y="243" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">too late for GDAL</text>
  <rect x="540" y="208" width="150" height="46" rx="6" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="615" y="228" text-anchor="middle" font-size="11" fill="currentColor">/vsis3/ read</text>
  <text x="615" y="243" text-anchor="middle" font-size="9.5" fill="#c0392b" opacity="0.85">403: no creds</text>
  <path d="M180,231 L283,231" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a)"/>
  <path d="M435,231 L538,231" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a)"/>
  <defs>
    <marker id="a" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The layout uses a tiny `bootstrap.py` module that does nothing but load the `.env` file. The entry module imports it *first*, on its own line, before touching rasterio. Keeping the load in a dedicated module makes the ordering intention explicit and hard to accidentally reorder with an autoformatter.

```python
# bootstrap.py — imported FIRST, before any geospatial library.
"""Load the project .env into os.environ before GDAL/PROJ initialize.

Import this module at the very top of the CLI entry point, on its own line,
above `import rasterio` or `from osgeo import gdal`. It has no other job.
"""
import os
import logging
from pathlib import Path
from dotenv import load_dotenv, find_dotenv

logger = logging.getLogger("gis_cli.bootstrap")

# Keys whose values must never appear in logs, verbatim.
_SECRET_MARKERS = ("SECRET", "TOKEN", "PASSWORD", "KEY", "CREDENTIAL")

# Geospatial variables that must be resolved before rasterio/osgeo import.
_GDAL_KEYS = (
    "GDAL_DATA", "PROJ_DATA", "GDAL_CACHEMAX",
    "GDAL_NUM_THREADS", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_S3_ENDPOINT", "AWS_REGION",
)


def _mask(key: str, value: str) -> str:
    """Redact secret values, keeping only the last four characters."""
    if any(marker in key.upper() for marker in _SECRET_MARKERS):
        tail = value[-4:] if len(value) > 4 else ""
        return f"****{tail}"
    return value


def load_environment(env_file: str | None = None, override: bool = False) -> Path | None:
    """Load a .env file into os.environ and return the path that was used.

    override=False (the default) means a variable already present in the real
    environment — set by the shell, container, or CI runner — WINS over the
    .env file. Pass override=True only to force a deliberate local reset.
    """
    dotenv_path = env_file or find_dotenv(usecwd=True)
    if not dotenv_path:
        logger.warning("No .env file found; using process environment only.")
        return None

    load_dotenv(dotenv_path, override=override)

    # Log the resolved geospatial config with secrets masked.
    resolved = {
        key: _mask(key, os.environ[key])
        for key in _GDAL_KEYS
        if key in os.environ
    }
    logger.info("Loaded env from %s (override=%s): %s",
                dotenv_path, override, resolved)
    return Path(dotenv_path)


# Load at import time so a plain `import bootstrap` is enough to arm GDAL.
load_environment()
```

```python
# cli.py — the entry point.
"""Reproject a cloud-hosted GeoTIFF from /vsis3/ to a local file.

Run: python cli.py s3://tiles/scene.tif ./out.tif --crs EPSG:3857
"""
import bootstrap          # noqa: F401  MUST be the first import — arms GDAL env.

import sys
import argparse
import logging
from pathlib import Path

import rasterio            # safe now: bootstrap already populated os.environ
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.crs import CRS

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("gis_cli")


def reproject_vsis3(src_uri: str, dst_path: Path, target_epsg: str) -> int:
    """Read a raster (local or /vsis3/) and warp it to target_epsg."""
    dst_crs = CRS.from_string(target_epsg)          # e.g. "EPSG:3857"
    # rasterio maps s3:// URIs to GDAL's /vsis3/ handler, which needs AWS_* now.
    with rasterio.open(src_uri) as src:
        if src.crs is None:
            logger.error("Source %s has no CRS; cannot reproject.", src_uri)
            return 10                               # 10 = CRS mismatch/missing
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(crs=dst_crs, transform=transform, width=width, height=height)

        with rasterio.open(dst_path, "w", **profile) as dst:
            for band in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band),
                    destination=rasterio.band(dst, band),
                    src_crs=src.crs,
                    dst_crs=dst_crs,
                    resampling=Resampling.bilinear,
                )
    logger.info("Wrote %s in %s", dst_path, dst_crs)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Reproject a raster to a target CRS")
    parser.add_argument("src", help="Source raster: local path or s3://bucket/key")
    parser.add_argument("dst", type=Path, help="Destination GeoTIFF path")
    parser.add_argument("--crs", default="EPSG:3857", help="Target CRS (default EPSG:3857)")
    parser.add_argument("--env-file", default=None, help="Explicit .env path override")
    args = parser.parse_args()

    # Optional late re-load ONLY affects os.environ read at runtime (AWS creds),
    # not GDAL_DATA/PROJ_DATA which were already snapshotted at import.
    if args.env_file:
        bootstrap.load_environment(args.env_file)

    return reproject_vsis3(args.src, args.dst, args.crs)


if __name__ == "__main__":
    sys.exit(main())
```

A representative `.env` at the project root:

```bash
# .env — add this file to .gitignore. Never commit real credentials.
GDAL_DATA=/opt/conda/share/gdal
PROJ_DATA=/opt/conda/share/proj
GDAL_CACHEMAX=512
GDAL_NUM_THREADS=1
AWS_REGION=eu-central-1
AWS_S3_ENDPOINT=s3.eu-central-1.amazonaws.com
AWS_ACCESS_KEY_ID=AKIAEXAMPLE1234
AWS_SECRET_ACCESS_KEY=changeme-do-not-commit
```

## Step Annotations

1. **`import bootstrap` on its own first line** — The `# noqa: F401` comment stops linters from flagging the "unused" import and, more importantly, from auto-removing it. This single line is the whole safety mechanism: it runs `load_environment()` at import time, mutating `os.environ` before `import rasterio` a few lines down triggers GDAL's one-time environment read.

2. **`find_dotenv(usecwd=True)`** — Walks up the directory tree from the current working directory until it finds a `.env`. `usecwd=True` anchors the search to where the CLI was invoked rather than to the module file, so running the tool from any project subfolder still resolves the project-root file.

3. **`override=False`** — The default and the correct choice for production. A real `AWS_SECRET_ACCESS_KEY` injected by a CI runner or container orchestrator wins over the checked-in `.env`. Flip to `override=True` only when you deliberately want the file to reset a polluted local shell.

4. **`_mask()` before logging** — GDAL and cloud debugging tempts you to log the whole environment. The mask keeps `GDAL_DATA` and `AWS_REGION` readable while reducing `AWS_SECRET_ACCESS_KEY` to `****meme`, so log files and CI output never carry a usable credential.

5. **`s3://` URI to `/vsis3/`** — rasterio translates an `s3://` URI to GDAL's `/vsis3/` virtual filesystem handler, which reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` from the environment on first access. Because bootstrap ran first, those values are present.

6. **Return codes** — `0` for success, `10` for a missing source CRS. This keeps the tool composable in a batch loop, matching the domain exit-code convention used across the [Configuration File Management](/cli-architecture-design-patterns/configuration-file-management/) tooling.

## Named Gotcha: A Late Import Silently Wins

The trap is not usually a visibly misplaced `load_dotenv()` — it is a *transitive* import. Suppose `cli.py` imports a helper module `geo_utils` above `import bootstrap`, and `geo_utils` itself does `import rasterio` at module scope. Python executes `geo_utils`'s imports first, GDAL snapshots an empty environment, and only then does `bootstrap` run. Your `GDAL_DATA` and PROJ grid settings are already fixed to defaults, and a `/vsis3/` read returns a `403` because the AWS keys arrived too late for the handler.

The fix is a hard rule: `import bootstrap` (or a `load_dotenv()` call) must be the very first import in the entry module, above every other project import and every geospatial import, transitive ones included. If you cannot control import order — for example, a plugin framework imports your modules for you — set the truly critical variables such as `GDAL_DATA` and `PROJ_DATA` in the real environment (shell profile or container spec) so they never depend on `.env` timing, and reserve `.env` for runtime-read values like the `AWS_*` credentials. Note that `override=False` compounds this: if a stale value is already in the shell, the file will not correct it, so a wrong early value persists silently.

## Verification

Confirm both the load order and the masking at startup, then prove a cloud read works:

```bash
# 1. Show the effective, masked geospatial config without running a job.
python -c "import bootstrap"
# INFO gis_cli.bootstrap: Loaded env from /proj/.env (override=False):
#   {'GDAL_DATA': '/opt/conda/share/gdal', 'AWS_SECRET_ACCESS_KEY': '**** mit', ...}

# 2. Prove GDAL saw GDAL_DATA (empty output means it was set before import).
python - <<'EOF'
import bootstrap                     # first
from osgeo import gdal
print("GDAL_DATA:", gdal.GetConfigOption("GDAL_DATA"))   # must be non-empty
print("PROJ_DATA:", gdal.GetConfigOption("PROJ_DATA"))
EOF

# 3. End-to-end: reproject a /vsis3/ raster to EPSG:3857.
python cli.py s3://my-bucket/scene.tif ./scene_3857.tif --crs EPSG:3857
echo "exit: $?"     # 0 = success, 10 = missing source CRS
```

If step 2 prints a non-empty `GDAL_DATA`, the load ran before GDAL initialized. If the secret in step 1 shows only four trailing characters, masking is working. A grep for the raw secret in your logs should return nothing:

```bash
grep -R "changeme-do-not-commit" ./logs/ && echo "LEAK!" || echo "clean"
```

## FAQ

<details class="faq-item">
<summary>Why must load_dotenv run before importing rasterio?</summary>

Rasterio and `osgeo` read `GDAL_DATA`, `PROJ_DATA`, `GDAL_CACHEMAX`, and the `AWS_*` credentials from `os.environ` during their own import and driver registration. If `load_dotenv` runs after that import, the values already read into GDAL's C-level configuration will not change, so the `/vsis3/` handler and PROJ transforms use stale or missing settings.
</details>

<details class="faq-item">
<summary>Should I use override=True or override=False with load_dotenv?</summary>

Use `override=False`, which is the default. Real environment variables set by the shell, container, or CI runner then take precedence over the `.env` file, so production credentials injected by the platform are not clobbered by a checked-in development file. Use `override=True` only for a deliberate local reset.
</details>

<details class="faq-item">
<summary>How do I stop .env secrets from leaking into CLI logs?</summary>

Never log `os.environ` wholesale. Build a redacted copy that masks any key matching `SECRET`, `TOKEN`, `PASSWORD`, or `KEY`, showing only the last four characters, and log that copy instead. Also add `.env` to `.gitignore` so credentials are never committed.
</details>

<details class="faq-item">
<summary>Where should the .env file live for a CLI run from any directory?</summary>

Use `find_dotenv()`, which walks up the directory tree from the current working directory until it finds a `.env` file. This lets the CLI be invoked from a subfolder of a project and still resolve the project-root `.env`. Pass an explicit path with a `--env-file` flag when you need to override that search.
</details>

---

## Related

- [Environment Variable Sync for Python GIS CLI Tools](/cli-architecture-design-patterns/environment-variable-sync/) — parent guide covering how GDAL, PROJ, and cloud variables stay consistent across a CLI's runtime surfaces
- [Managing GDAL and PROJ Environment Variables Across Shells](/cli-architecture-design-patterns/environment-variable-sync/managing-gdal-and-proj-env-vars-across-shells/) — the shell-export counterpart for setting the same variables in profiles, containers, and systemd units
