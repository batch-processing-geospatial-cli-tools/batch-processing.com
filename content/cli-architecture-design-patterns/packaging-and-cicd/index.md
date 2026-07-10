---
title: "Packaging & CI/CD for Python GIS CLI Tools"
description: "Package, containerise, and continuously test a Python geospatial CLI: pin GDAL, ship reproducible Docker images, matrix-test across GDAL versions, and publish to PyPI."
slug: "packaging-and-cicd"
type: "topic"
breadcrumb: "CLI Architecture & Design Patterns > Packaging & CI/CD"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Packaging & CI/CD for Python GIS CLI Tools",
      "description": "Package, containerise, and continuously test a Python geospatial CLI: pin GDAL, ship reproducible Docker images, matrix-test across GDAL versions, and publish to PyPI.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "CLI Architecture & Design Patterns for Python GIS", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 3, "name": "Packaging & CI/CD", "item": "https://batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Package and continuously deliver a Python GIS CLI",
      "step": [
        {"@type": "HowToStep", "name": "Declare console-script entry points and pin the geospatial stack", "text": "Define the console_scripts entry point in pyproject.toml under PEP 621 metadata and constrain the GDAL, rasterio, and pyproj versions to a compatible range."},
        {"@type": "HowToStep", "name": "Choose a GDAL distribution strategy", "text": "Decide between binary wheels, a conda-forge environment, or a system GDAL supplied by the base image, and encode that choice in your build."},
        {"@type": "HowToStep", "name": "Build a reproducible multi-stage Docker image", "text": "Install a pinned GDAL in a builder stage, compile the wheel, and copy only the runtime artefacts into a slim final image."},
        {"@type": "HowToStep", "name": "Matrix-test across GDAL and Python versions", "text": "Run the test suite against every supported GDAL and Python combination in a GitHub Actions matrix so version drift surfaces before release."},
        {"@type": "HowToStep", "name": "Lock the environment with hashes", "text": "Compile a fully pinned, hash-verified lock file with pip-tools or uv so installs are byte-for-byte reproducible."},
        {"@type": "HowToStep", "name": "Publish to PyPI from a release workflow", "text": "Build the sdist and wheel on a tagged commit and upload them to PyPI using trusted publishing with no long-lived tokens."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Should I pin GDAL as a Python dependency or install it from the system?",
          "acceptedAnswer": {"@type": "Answer", "text": "Pin the rasterio and pyproj versions in pyproject.toml, but let the actual GDAL C library come from one controlled source per environment: the manylinux binary wheels for CI and PyPI installs, or a system GDAL baked into your Docker base image for containers. Never mix a system libgdal with pip-installed rasterio wheels that bundle their own GDAL, because two GDAL copies loaded into one process cause segfaults and PROJ database mismatches."}
        },
        {
          "@type": "Question",
          "name": "Why does my CLI work locally but crash with a PROJ database error in Docker?",
          "acceptedAnswer": {"@type": "Answer", "text": "The PROJ_LIB or PROJ_DATA environment variable is pointing at a proj.db from a different PROJ version than the one your rasterio wheel was compiled against. When the image bundles GDAL from apt but rasterio from a wheel, two proj.db files exist and the wrong one wins. Fix it by installing rasterio without its bundled binaries (pip install --no-binary rasterio) against the system GDAL, or by using the wheel's own PROJ data and unsetting the system PROJ_LIB."}
        },
        {
          "@type": "Question",
          "name": "How do I test my geospatial CLI against multiple GDAL versions?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use a GitHub Actions matrix that pairs Python versions with GDAL versions, installing each GDAL from a controlled channel such as conda-forge or the ubuntugis PPA, then running the same pytest suite in every cell. Pin the matrix to the GDAL versions your users actually run — typically the current release, the previous minor, and whatever ships in the latest Ubuntu LTS."}
        },
        {
          "@type": "Question",
          "name": "What belongs in the lock file for a reproducible GIS environment?",
          "acceptedAnswer": {"@type": "Answer", "text": "The lock file must contain every transitive dependency pinned to an exact version with a SHA-256 hash, including rasterio, pyogrio, pyproj, shapely, and numpy. Compile it with pip-tools or uv lock so the resolver records the exact wheels that satisfy your GDAL constraint, and install with hash checking enabled so a tampered or mismatched wheel aborts the build instead of silently loading a different GDAL ABI."}
        },
        {
          "@type": "Question",
          "name": "Should I publish binary wheels for my GIS CLI to PyPI?",
          "acceptedAnswer": {"@type": "Answer", "text": "If your package is pure Python and only depends on rasterio and pyogrio, publish a single universal wheel and let those dependencies supply their own compiled GDAL wheels. Only build platform-specific binary wheels yourself if you ship compiled C or Cython extensions that link against GDAL directly, in which case you need cibuildwheel with the GDAL headers available in each manylinux build container."}
        }
      ]
    }
  ]
}
</script>

# Packaging & CI/CD for Python GIS CLI Tools

**TL;DR:** Package a Python geospatial CLI so it installs and runs identically everywhere by pinning the GDAL stack in `pyproject.toml`, shipping a reproducible multi-stage Docker image, matrix-testing across GDAL and Python versions in CI, locking dependencies with hashes, and publishing to PyPI through a tagged release workflow.

## Prerequisites

- Python 3.10+
- `pip install build twine pip-tools rasterio>=1.3 pyogrio>=0.7 pyproj>=3.6 shapely>=2.0`
- A working GDAL toolchain to develop against (`gdal-config --version` should print 3.6 or newer)
- Docker 24+ and a GitHub repository with Actions enabled
- This page is part of the [CLI Architecture & Design Patterns for Python GIS](https://www.batch-processing.com/cli-architecture-design-patterns/) guide — read the parent page first for the overall shape of a production geospatial command-line tool, of which packaging is the final delivery stage.

## Problem Framing

A team ships a raster reprojection CLI as a `git clone` plus a `requirements.txt`. It works on the maintainer's laptop, where GDAL 3.8 was installed by Homebrew years ago. A new hire on Ubuntu 22.04 installs the same requirements and every command dies with `CPLE_OpenFailedError: PROJ: proj_create_from_database`. The CI runner, which uses the `ubuntu-latest` image with GDAL 3.4 from apt, passes some tests and segfaults on others with no stack trace. Nobody can reproduce anyone else's failure.

This is the defining packaging problem for Python GIS. The Python code is trivially portable; the GDAL C library underneath it is not. GDAL, PROJ, and GEOS are compiled libraries with their own ABIs, their own data files (`proj.db`, the GDAL data directory), and their own version-to-version behaviour changes. A geospatial CLI is really a Python entry point sitting on top of three C libraries that must all agree on their versions and their data paths at runtime. When they disagree, you get segfaults, silent coordinate corruption, or `proj.db` lookup failures — never a clean Python traceback.

Packaging and CI/CD for a GIS CLI is therefore the discipline of nailing down exactly one GDAL per environment, proving it works across the GDAL versions your users actually run, and shipping the result so the install is byte-for-byte identical on every machine. The rest of this guide walks the full pipeline: declaring entry points and pinning the stack, choosing a GDAL distribution strategy, building a reproducible container, matrix-testing, locking with hashes, and publishing.

## Pipeline: Source to Published Artefact

The diagram below traces one commit from source through the wheel build, the GDAL test matrix, the container image, and the two publish targets — PyPI and a container registry.

<svg viewBox="0 0 720 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CI/CD pipeline for a Python GIS CLI: a tagged source commit builds an sdist and wheel, which fan out to a GDAL and Python test matrix; on green, the pipeline builds a locked multi-stage Docker image and publishes the wheel to PyPI and the image to a container registry" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Packaging and CI/CD pipeline for a Python geospatial CLI</title>
  <desc>A tagged commit is built into an sdist and wheel. The wheel fans out into a test matrix that pairs GDAL versions with Python versions. When every matrix cell passes, the pipeline builds a locked multi-stage Docker image and, in parallel, publishes the wheel to PyPI and the container image to a registry.</desc>
  <defs>
    <marker id="pa" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Source -->
  <rect x="20" y="150" width="120" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8"/>
  <text x="80" y="176" text-anchor="middle" font-size="13" font-family="inherit" fill="currentColor" font-weight="600">Tagged commit</text>
  <text x="80" y="194" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">pyproject.toml</text>
  <!-- Build wheel -->
  <rect x="185" y="150" width="120" height="60" rx="6" fill="none" stroke="#6366f1" stroke-width="1.5" fill-opacity="0.08"/>
  <text x="245" y="176" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Build</text>
  <text x="245" y="194" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">sdist + wheel</text>
  <line x1="140" y1="180" x2="185" y2="180" stroke="currentColor" stroke-width="1.2" opacity="0.6" marker-end="url(#pa)"/>
  <!-- Matrix cells -->
  <rect x="350" y="40" width="150" height="42" rx="5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.75"/>
  <text x="425" y="60" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor">GDAL 3.6 · Py 3.10</text>
  <text x="425" y="74" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">pytest</text>
  <rect x="350" y="94" width="150" height="42" rx="5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.75"/>
  <text x="425" y="114" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor">GDAL 3.8 · Py 3.11</text>
  <text x="425" y="128" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">pytest</text>
  <rect x="350" y="148" width="150" height="42" rx="5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.75"/>
  <text x="425" y="168" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor">GDAL 3.9 · Py 3.12</text>
  <text x="425" y="182" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">pytest</text>
  <text x="425" y="206" text-anchor="middle" font-size="14" fill="currentColor" opacity="0.4">⋮</text>
  <text x="425" y="28" text-anchor="middle" font-size="11" font-family="inherit" fill="currentColor" opacity="0.7" font-weight="600">Test matrix</text>
  <line x1="305" y1="172" x2="350" y2="61" stroke="currentColor" stroke-width="1.1" opacity="0.5" marker-end="url(#pa)"/>
  <line x1="305" y1="180" x2="350" y2="115" stroke="currentColor" stroke-width="1.1" opacity="0.5" marker-end="url(#pa)"/>
  <line x1="305" y1="188" x2="350" y2="169" stroke="currentColor" stroke-width="1.1" opacity="0.5" marker-end="url(#pa)"/>
  <!-- Containerise -->
  <rect x="350" y="250" width="150" height="60" rx="6" fill="none" stroke="#a78bfa" stroke-width="1.5" fill-opacity="0.08"/>
  <text x="425" y="276" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Containerise</text>
  <text x="425" y="294" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">multi-stage image</text>
  <line x1="425" y1="190" x2="425" y2="250" stroke="currentColor" stroke-width="1.2" opacity="0.6" marker-end="url(#pa)"/>
  <text x="512" y="226" text-anchor="middle" font-size="9" font-family="inherit" fill="#15803d" opacity="0.85">all green</text>
  <!-- Publish PyPI -->
  <rect x="560" y="120" width="140" height="56" rx="6" fill="none" stroke="#15803d" stroke-width="1.5" fill-opacity="0.08"/>
  <text x="630" y="144" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Publish PyPI</text>
  <text x="630" y="162" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">wheel + sdist</text>
  <line x1="500" y1="115" x2="560" y2="148" stroke="currentColor" stroke-width="1.2" opacity="0.5" marker-end="url(#pa)"/>
  <!-- Publish registry -->
  <rect x="560" y="252" width="140" height="56" rx="6" fill="none" stroke="#15803d" stroke-width="1.5" fill-opacity="0.08"/>
  <text x="630" y="276" text-anchor="middle" font-size="12" font-family="inherit" fill="currentColor" font-weight="600">Push registry</text>
  <text x="630" y="294" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" opacity="0.7">tagged image</text>
  <line x1="500" y1="280" x2="560" y2="280" stroke="currentColor" stroke-width="1.2" opacity="0.6" marker-end="url(#pa)"/>
</svg>

## Step-by-Step Implementation

### Step 1 — Declare Entry Points and Pin the Geospatial Stack

Modern packaging uses `pyproject.toml` with PEP 621 metadata. The `[project.scripts]` table declares console-script entry points: each key becomes an executable on `PATH` that calls the referenced function. Pin the geospatial dependencies to a compatible range — wide enough to accept security patches, narrow enough that a GDAL ABI break cannot slip in unannounced.

```toml
# pyproject.toml
[build-system]
requires = ["hatchling>=1.21"]
build-backend = "hatchling.build"

[project]
name = "geowarp-cli"
version = "1.4.0"
description = "Batch raster reprojection CLI for Python GIS pipelines"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "Apache-2.0" }
authors = [{ name = "batch-processing.com" }]
dependencies = [
    "rasterio>=1.3,<1.5",   # bundles GDAL 3.6-3.9 in its manylinux wheels
    "pyogrio>=0.7,<0.9",    # preferred vector I/O over fiona
    "pyproj>=3.6,<3.8",     # must agree with rasterio's PROJ ABI
    "shapely>=2.0,<2.1",
    "typer>=0.12",
    "rich>=13.0",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-cov", "pip-tools>=7.4"]

[project.scripts]
geowarp = "geowarp_cli.__main__:app"   # `geowarp reproject ...` after install

[project.urls]
Homepage = "https://batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/"
```

The `geowarp = "geowarp_cli.__main__:app"` line is what makes the tool feel native: after `pip install geowarp-cli` the shell has a `geowarp` command wired to your Typer or Click application object. Keep the version constraints on `rasterio` and `pyproj` in lockstep — they must be built against the same PROJ. The way that command exposes subcommands like `geowarp reproject` and `geowarp validate` is covered in [CLI Subcommand Organization for GIS Toolchains](https://www.batch-processing.com/cli-architecture-design-patterns/cli-subcommand-organization/).

### Step 2 — Choose a GDAL Distribution Strategy

There are three ways to get GDAL under your Python code, and mixing them is the root cause of most "works here, crashes there" reports. Pick exactly one per environment.

```text
Strategy A — Binary wheels (rasterio/pyogrio bundle GDAL)
  pip install rasterio pyogrio
  → GDAL ships inside the manylinux wheel; no system GDAL needed.
  → Best for: PyPI installs, CI runners, laptops. Zero system deps.
  → Constraint: you get whatever GDAL that wheel version bundled.

Strategy B — Conda-forge (one GDAL for the whole env)
  conda install -c conda-forge gdal rasterio pyogrio
  → conda-forge compiles everything against one libgdal.
  → Best for: research environments, pinning an exact GDAL.
  → Constraint: not pip; needs a conda toolchain in CI and Docker.

Strategy C — System GDAL (from apt / the base image)
  apt-get install libgdal-dev && pip install --no-binary rasterio rasterio
  → rasterio compiles against the system libgdal.
  → Best for: Docker images that already pin a GDAL apt version.
  → Constraint: pip and system GDAL versions must match exactly.
```

The fatal mistake is Strategy A and Strategy C at once: a system `libgdal` from apt plus a `rasterio` wheel that bundles its own GDAL. Two GDAL copies then load into one process, two `proj.db` files exist, and coordinate transforms either segfault or return wrong numbers. For a distributable CLI, Strategy A is the default — it needs no system packages and installs cleanly from PyPI. For containers where you want to pin the exact GDAL, Strategy C inside a controlled base image (Step 3) is the reproducible choice. Whichever you pick, the `GDAL_DATA` and `PROJ_LIB` paths must resolve to the data directory of that one GDAL, which is exactly the concern addressed by [Environment Variable Sync for Python GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/).

### Step 3 — Build a Reproducible Multi-Stage Docker Image

A multi-stage Dockerfile keeps the final image small and reproducible: the builder stage carries the compilers and GDAL headers needed to build the wheel, and the runtime stage carries only the pinned GDAL runtime and the installed application. Pin the base image by digest and the GDAL apt package by version so the image is bit-for-bit rebuildable.

```dockerfile
# syntax=docker/dockerfile:1.7
# ---- Stage 1: builder -------------------------------------------------
FROM python:3.12-slim-bookworm AS builder

# Pin the GDAL apt version explicitly; Debian bookworm ships 3.6.x.
ARG GDAL_VERSION=3.6.2+dfsg-1+b2
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libgdal-dev=${GDAL_VERSION} \
        gdal-bin=${GDAL_VERSION} \
    && rm -rf /var/lib/apt/lists/*

# Build against the system GDAL (Strategy C): no bundled wheel binaries.
ENV GDAL_CONFIG=/usr/bin/gdal-config
WORKDIR /build
COPY requirements.lock ./
RUN pip install --require-hashes --no-deps -r requirements.lock \
    && pip install --no-binary rasterio,pyogrio rasterio pyogrio

COPY . .
RUN pip install --no-deps . && pip wheel --no-deps -w /wheels .

# ---- Stage 2: runtime -------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

ARG GDAL_VERSION=3.6.2+dfsg-1+b2
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgdal32=${GDAL_VERSION} \
        gdal-data \
    && rm -rf /var/lib/apt/lists/*

# Point the data paths at the one GDAL installed above.
ENV GDAL_DATA=/usr/share/gdal \
    PROJ_LIB=/usr/share/proj \
    GDAL_NUM_THREADS=1 \
    PYTHONUNBUFFERED=1

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/geowarp /usr/local/bin/geowarp

# Non-root runtime user
RUN useradd --create-home --uid 10001 geo
USER geo
ENTRYPOINT ["geowarp"]
CMD ["--help"]
```

The image sets `GDAL_DATA` and `PROJ_LIB` once, at the runtime layer, so every invocation of `geowarp` resolves the same `proj.db`. Because only the site-packages and the console script are copied from the builder, the compilers and dev headers never reach the shipped image. The detailed walkthrough — layer caching, shrinking GDAL, and pinning the PROJ grid files — lives in the deep-dive on [building a Docker image with GDAL for a Python CLI](https://www.batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/building-a-docker-image-with-gdal-for-a-python-cli/).

### Step 4 — Matrix-Test Across GDAL and Python Versions

Version drift is the enemy: a transform that is exact under GDAL 3.9 may round differently under 3.6, and a driver present in one build may be absent in another. A GitHub Actions matrix runs the same `pytest` suite against every GDAL and Python pair you support, so drift surfaces in CI rather than in a user's pipeline.

```yaml
# .github/workflows/test.yml
name: test
on: [push, pull_request]

jobs:
  matrix:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - { python: "3.10", gdal: "3.6.4" }
          - { python: "3.11", gdal: "3.8.5" }
          - { python: "3.12", gdal: "3.9.2" }
    name: py${{ matrix.python }} · gdal${{ matrix.gdal }}
    steps:
      - uses: actions/checkout@v4
      - uses: conda-incubator/setup-miniconda@v3
        with:
          python-version: ${{ matrix.python }}
          channels: conda-forge
          auto-activate-base: false
          activate-environment: test
      - name: Install pinned GDAL and the CLI
        shell: bash -el {0}
        run: |
          conda install -y "gdal=${{ matrix.gdal }}" "rasterio" "pyogrio" "pyproj"
          pip install --no-deps -e ".[dev]"
      - name: Report the resolved stack
        shell: bash -el {0}
        run: |
          gdal-config --version
          python -c "import rasterio; print('rasterio', rasterio.__gdal_version__)"
      - name: Run tests
        shell: bash -el {0}
        run: pytest -q --cov=geowarp_cli
```

Using conda-forge to supply each GDAL keeps the whole environment compiled against one `libgdal`, avoiding the mixed-copy trap from Step 2. Pin the matrix to the GDAL versions your users actually run — usually the current release, the previous minor, and whatever ships in the latest Ubuntu LTS. The full treatment, including caching conda environments and asserting numeric transform stability across versions, is in the deep-dive on [matrix testing a geospatial CLI across GDAL versions](https://www.batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/matrix-testing-a-geospatial-cli-across-gdal-versions/).

### Step 5 — Lock the Environment with Hashes

A version range in `pyproject.toml` is a promise about what is compatible; a lock file is a fact about what was installed. Compile a fully pinned, hash-verified lock file so a rebuild resolves to the exact same wheels — critical when a wheel change would swap the bundled GDAL ABI underneath you.

```bash
# Compile a hash-locked requirements file from pyproject.toml
pip-compile --generate-hashes --strip-extras \
    --output-file requirements.lock pyproject.toml

# Or with uv, which resolves the geospatial stack considerably faster:
uv pip compile --generate-hashes pyproject.toml -o requirements.lock

# Install the exact, verified set — a hash mismatch aborts the build.
pip install --require-hashes -r requirements.lock
```

The `--require-hashes` flag turns a supply-chain problem into a build failure: if PyPI serves a `rasterio` wheel whose SHA-256 does not match the locked hash, the install stops rather than silently loading a different GDAL. The lock file is what the Dockerfile in Step 3 installs, and what pins the numbers behind the ranges. Regenerate it deliberately, review the diff, and commit it alongside the code.

### Step 6 — Publish to PyPI from a Release Workflow

Publishing is triggered by a version tag and gated on a green matrix. Build the sdist and wheel with `python -m build`, then upload with PyPI trusted publishing (OpenID Connect) so no long-lived API token lives in the repository.

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    tags: ["v*"]

jobs:
  build-and-publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write        # required for trusted publishing (OIDC)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Build sdist and wheel
        run: |
          pip install build
          python -m build
      - name: Check metadata
        run: |
          pip install twine
          twine check dist/*
      - name: Publish to PyPI
        uses: pypa/gh-action-pypi-publish@release/v1
        # no password: trusted publishing exchanges the OIDC token
```

Because `geowarp-cli` is pure Python that depends on `rasterio` and `pyogrio` for its compiled parts, `python -m build` produces one universal wheel; the GDAL wheels come from the dependencies at install time. Only reach for `cibuildwheel` and per-platform binary wheels if you ship your own C or Cython extensions that link GDAL directly.

## Configuration Integration

The packaging layer resolves settings in the same defaults → file → env → flag order the rest of the CLI uses, and its job is to make sure the runtime environment matches what the wheel was built against. The values that matter most at packaging time are the GDAL data paths and thread caps, which the image bakes in as defaults and a user can still override per invocation.

```python
# geowarp_cli/config.py — packaging-relevant resolution
import os
from pathlib import Path

# 1. Baked-in defaults (set in the Dockerfile ENV)
DEFAULTS = {"GDAL_DATA": "/usr/share/gdal", "PROJ_LIB": "/usr/share/proj"}

def resolve_gdal_paths(cli_proj_lib: str | None = None) -> dict[str, str]:
    """defaults -> environment -> --proj-lib flag (highest priority)."""
    resolved = dict(DEFAULTS)
    for key in resolved:
        if key in os.environ:            # env overrides the image default
            resolved[key] = os.environ[key]
    if cli_proj_lib:                     # an explicit flag wins outright
        resolved["PROJ_LIB"] = str(Path(cli_proj_lib).resolve())
    return resolved
```

Bake the defaults into the image, let deployment set environment variables, and expose a `--proj-lib` flag for one-off overrides. The broader mechanics of layered settings — file discovery, precedence, and validation — are covered in [Configuration File Management for GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/), and the pitfalls of getting `GDAL_DATA` and `PROJ_LIB` to agree across parent and child processes in [Environment Variable Sync for Python GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/).

## Error Handling and Gotchas

**Two GDAL copies in one process.** The single most common packaging failure: a system `libgdal` from apt plus a `rasterio` wheel that bundles its own GDAL. Symptom is a segfault with no traceback, or `PROJ: proj_create` errors. Fix is to commit to one strategy — either install `rasterio` with `--no-binary` against the system GDAL, or use pure wheels and install no system GDAL at all.

**PROJ_LIB pointing at the wrong proj.db.** When two PROJ versions coexist, `pyproj` may load a `proj.db` that predates the datum grids your transforms need, yielding coordinates off by tens of metres with no error. Verify with `pyproj.datadir.get_data_dir()` and ensure it matches the GDAL you built against.

**Unpinned base image tags.** `FROM python:3.12-slim` silently changes GDAL when Debian bumps its apt package. Pin the base image (ideally by digest) and pin `libgdal-dev` to an explicit version so rebuilds are reproducible.

**Lock file omits the GDAL ABI.** A lock file records `rasterio==1.4.3` but not which GDAL that wheel bundles. If PyPI later reissues the wheel, the GDAL underneath can change. `--require-hashes` closes this gap by binding the exact wheel artefact.

**Console script not on PATH after install.** If `geowarp: command not found` follows a successful `pip install`, the `[project.scripts]` key is missing or the install went to a user site not on `PATH`. Confirm the entry point with `pip show -f geowarp-cli | grep bin`.

**Wheel builds but imports fail in the slim image.** Copying only site-packages misses a runtime shared library (`libgdal32`, `libproj`) that lived in the builder. Install the runtime GDAL package explicitly in the final stage, as the Dockerfile in Step 3 does.

## Verification

Confirm the packaged artefact actually runs and reports the GDAL it was built against. Run these checks as a smoke-test job after the image build and before publishing.

```bash
# 1. The console script is installed and on PATH
geowarp --help >/dev/null && echo "OK  entry point resolves"

# 2. The bundled GDAL matches the expected version
python - <<'PY'
import sys, rasterio, pyproj
gdal = rasterio.__gdal_version__
proj = pyproj.proj_version_str
print(f"GDAL {gdal}  PROJ {proj}")
sys.exit(0 if gdal.startswith("3.") else 11)   # 11 = unsupported format/version
PY

# 3. A real reprojection round-trips through the packaged CLI
geowarp reproject sample.tif --crs EPSG:3857 -o /tmp/out.tif \
    && python -c "import rasterio; \
       print('OK', rasterio.open('/tmp/out.tif').crs)"
```

Inside the container, run `docker run --rm geowarp-cli:1.4.0 --version` and assert the exit code is `0`. A non-zero exit — `11` for an unexpected GDAL version, `1` for a runtime error — fails the release job before anything reaches PyPI or the registry.

## Performance Notes

**Image size.** A naive single-stage image with `libgdal-dev` and build tools runs 1.2–1.8 GB. The multi-stage split in Step 3 drops the runtime image to 300–450 MB by shedding compilers and dev headers. Do not chase a smaller base than `slim-bookworm` for GDAL work — Alpine's musl libc forces a full GDAL source compile that adds 20+ minutes to every build and is a frequent source of PROJ grid bugs.

**Build cache.** Order Dockerfile layers cheapest-to-most-volatile: install the pinned GDAL apt packages first (rarely changes), then `pip install` the lock file (changes on dependency bumps), then `COPY . .` and the wheel build (changes every commit). With BuildKit caching, a code-only change then reuses the GDAL layer and rebuilds in seconds rather than minutes.

**Matrix runtime.** Installing GDAL from conda-forge in each matrix cell costs 60–120 seconds. Cache the conda environment keyed on the GDAL and Python versions so unchanged cells restore in seconds. A three-cell matrix with caching finishes in about the time one uncached cell takes.

**Lock resolution.** `pip-compile` on a full geospatial stack with `--generate-hashes` can take a minute because it downloads candidate wheels to hash them. `uv pip compile` resolves the same tree in a few seconds and is worth adopting for the lock step alone, even if the rest of the pipeline stays on pip.

**PyPI upload size.** A pure-Python wheel for the CLI is tens of kilobytes and uploads instantly; the heavy `rasterio`/`pyogrio` wheels are never yours to upload. Keep it that way — publishing your own GDAL binary wheels multiplies your maintenance surface by every platform you support.

## FAQ

<details class="faq-item">
<summary>Should I pin GDAL as a Python dependency or install it from the system?</summary>

Pin the `rasterio` and `pyproj` versions in `pyproject.toml`, but let the actual GDAL C library come from one controlled source per environment: the manylinux binary wheels for CI and PyPI installs, or a system GDAL baked into your Docker base image for containers. Never mix a system `libgdal` with pip-installed `rasterio` wheels that bundle their own GDAL, because two GDAL copies loaded into one process cause segfaults and PROJ database mismatches.
</details>

<details class="faq-item">
<summary>Why does my CLI work locally but crash with a PROJ database error in Docker?</summary>

The `PROJ_LIB` or `PROJ_DATA` environment variable is pointing at a `proj.db` from a different PROJ version than the one your `rasterio` wheel was compiled against. When the image bundles GDAL from apt but `rasterio` from a wheel, two `proj.db` files exist and the wrong one wins. Fix it by installing `rasterio` without its bundled binaries (`pip install --no-binary rasterio`) against the system GDAL, or by using the wheel's own PROJ data and unsetting the system `PROJ_LIB`.
</details>

<details class="faq-item">
<summary>How do I test my geospatial CLI against multiple GDAL versions?</summary>

Use a GitHub Actions matrix that pairs Python versions with GDAL versions, installing each GDAL from a controlled channel such as conda-forge or the ubuntugis PPA, then running the same `pytest` suite in every cell. Pin the matrix to the GDAL versions your users actually run — typically the current release, the previous minor, and whatever ships in the latest Ubuntu LTS.
</details>

<details class="faq-item">
<summary>What belongs in the lock file for a reproducible GIS environment?</summary>

The lock file must contain every transitive dependency pinned to an exact version with a SHA-256 hash, including `rasterio`, `pyogrio`, `pyproj`, `shapely`, and `numpy`. Compile it with pip-tools or `uv lock` so the resolver records the exact wheels that satisfy your GDAL constraint, and install with hash checking enabled so a tampered or mismatched wheel aborts the build instead of silently loading a different GDAL ABI.
</details>

<details class="faq-item">
<summary>Should I publish binary wheels for my GIS CLI to PyPI?</summary>

If your package is pure Python and only depends on `rasterio` and `pyogrio`, publish a single universal wheel and let those dependencies supply their own compiled GDAL wheels. Only build platform-specific binary wheels yourself if you ship compiled C or Cython extensions that link against GDAL directly, in which case you need `cibuildwheel` with the GDAL headers available in each manylinux build container.
</details>

## Related

- [CLI Architecture & Design Patterns for Python GIS](https://www.batch-processing.com/cli-architecture-design-patterns/) — the parent guide this packaging stage completes, from argument parsing through configuration to delivery
- [Environment Variable Sync for Python GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/) — keep GDAL_DATA and PROJ_LIB pointing at the one GDAL your image ships
- [Configuration File Management for GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) — the layered defaults → file → env → flag resolution the packaged tool inherits
