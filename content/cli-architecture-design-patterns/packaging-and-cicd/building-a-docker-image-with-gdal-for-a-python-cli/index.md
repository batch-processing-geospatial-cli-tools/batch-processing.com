---
title: "Building a Docker Image with GDAL for a Python CLI"
description: "Write a slim, reproducible multi-stage Dockerfile that installs a pinned GDAL and your Python geospatial CLI so it runs identically in CI and production."
slug: "building-a-docker-image-with-gdal-for-a-python-cli"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Packaging & CI/CD for Python GIS CLI Tools"
    url: "/cli-architecture-design-patterns/packaging-and-cicd/"
  - label: "Building a Docker Image with GDAL for a Python CLI"
    url: "/cli-architecture-design-patterns/packaging-and-cicd/building-a-docker-image-with-gdal-for-a-python-cli/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Building a Docker Image with GDAL for a Python CLI",
      "description": "Write a slim, reproducible multi-stage Dockerfile that installs a pinned GDAL and your Python geospatial CLI so it runs identically in CI and production.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Packaging & CI/CD for Python GIS CLI Tools", "item": "https://batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/"},
        {"@type": "ListItem", "position": 3, "name": "Building a Docker Image with GDAL for a Python CLI", "item": "https://batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/building-a-docker-image-with-gdal-for-a-python-cli/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Build a Docker Image with GDAL for a Python CLI",
      "step": [
        {"@type": "HowToStep", "name": "Pin the GDAL base image", "text": "Start the build stage from a tagged OSGeo GDAL image such as ghcr.io/osgeo/gdal:ubuntu-small-3.8.5 so the C library version is reproducible."},
        {"@type": "HowToStep", "name": "Build the wheel in an isolated stage", "text": "Install build tooling and pip-install your CLI package into a virtual environment inside the build stage."},
        {"@type": "HowToStep", "name": "Copy the venv into a slim runtime stage", "text": "Start a second stage from the same GDAL runtime image and copy only the built virtual environment across."},
        {"@type": "HowToStep", "name": "Set GDAL_DATA and PROJ_LIB", "text": "Export GDAL_DATA and PROJ_LIB in the runtime stage so coordinate transforms resolve their support files."},
        {"@type": "HowToStep", "name": "Add a non-root user and ENTRYPOINT", "text": "Create an unprivileged user and set ENTRYPOINT to the installed console script so the container runs the CLI directly."},
        {"@type": "HowToStep", "name": "Verify the image", "text": "Run docker run --rm to print the tool version and warp a mounted EPSG:4326 GeoTIFF to confirm GDAL works end to end."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why is my container GDAL version different from the Python package version?",
          "acceptedAnswer": {"@type": "Answer", "text": "The osgeo.gdal Python bindings must be built against the exact system libgdal in the image. If you pip-install a gdal wheel from PyPI it ships its own compiled library that shadows the system one, so pip install gdal==$(gdal-config --version) against the OSGeo base image instead of pulling an arbitrary wheel."}
        },
        {
          "@type": "Question",
          "name": "How do I make PROJ find its transformation grids inside the image?",
          "acceptedAnswer": {"@type": "Answer", "text": "Set PROJ_LIB (and PROJ_DATA on PROJ 9) to the directory that holds proj.db, which is /usr/share/proj on the OSGeo images. Without it, pyproj and any datum transform fall back to an empty search path and raise a CRS error at runtime."}
        },
        {
          "@type": "Question",
          "name": "Should I run the container as root?",
          "acceptedAnswer": {"@type": "Answer", "text": "No. Create a dedicated non-root user with a fixed UID and switch to it with USER before the ENTRYPOINT. Bind-mounted output directories then need to be writable by that UID, which you control with the --user flag on docker run or chown on the host."}
        },
        {
          "@type": "Question",
          "name": "Why does rasterio segfault or report a GDAL version mismatch in my image?",
          "acceptedAnswer": {"@type": "Answer", "text": "The manylinux rasterio wheel bundles its own copy of GDAL, which clashes with the system libgdal in the OSGeo base image. Install it with pip install --no-binary rasterio rasterio so it links against the system library, or pin a rasterio release whose bundled GDAL matches your base image."}
        }
      ]
    }
  ]
}
</script>

# Building a Docker Image with GDAL for a Python CLI

To Dockerise a Python CLI that needs GDAL, build from a pinned OSGeo GDAL image in a multi-stage `Dockerfile`: compile your wheel into a virtual environment in the build stage, copy that venv into a slim runtime stage from the same base, export `GDAL_DATA` and `PROJ_LIB`, add a non-root user, and set the console script as the `ENTRYPOINT`. This page is part of the [Packaging & CI/CD for Python GIS CLI Tools](/cli-architecture-design-patterns/packaging-and-cicd/) guide within the broader [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later, packaged with a `pyproject.toml` that declares a console script entry point (the thing that becomes `mytool` on the command line).
- Docker 24+ with BuildKit enabled (the default), so multi-stage builds cache each stage independently.
- A working knowledge of how your CLI reads configuration; container images pass most settings through the environment, which the [Environment Variable Sync](/cli-architecture-design-patterns/environment-variable-sync/) guide covers in depth.

The hardest part is not writing Docker syntax — it is keeping the C-level GDAL library, its data files, and the `osgeo.gdal` Python bindings all pinned to one version so the image behaves identically in CI and production.

## The Two-Stage Layout

The build stage carries compilers, headers, and `pip` caches you never want in production. The runtime stage starts clean from the same GDAL base and receives only the finished virtual environment. Because both stages descend from an identical `ghcr.io/osgeo/gdal` tag, the `libgdal` that your bindings were compiled against is byte-for-byte the one present at runtime.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Multi-stage Docker build: a build stage compiles the wheel into a virtual environment, then only that venv is copied into a slim runtime stage that shares the same pinned GDAL base image" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Multi-stage Docker build for a GDAL Python CLI</title>
  <desc>A build stage installs build tools and pip-installs the CLI into a virtual environment. Only the virtual environment is copied into a slim runtime stage. Both stages share the same pinned OSGeo GDAL base image, and the runtime stage sets GDAL_DATA, PROJ_LIB, a non-root user, and an ENTRYPOINT.</desc>
  <!-- Shared base label -->
  <rect x="180" y="12" width="360" height="34" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.5" stroke-width="1.2"/>
  <text x="360" y="33" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">shared base: ghcr.io/osgeo/gdal:ubuntu-small-3.8.5</text>
  <!-- Build stage panel -->
  <rect x="16" y="66" width="320" height="252" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.5"/>
  <text x="176" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Stage 1: build</text>
  <rect x="46" y="104" width="260" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="176" y="128" text-anchor="middle" font-size="11" fill="currentColor">apt: build-essential, python3-dev</text>
  <rect x="46" y="156" width="260" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="176" y="180" text-anchor="middle" font-size="11" fill="currentColor">python -m venv /opt/venv</text>
  <rect x="46" y="208" width="260" height="40" rx="5" fill="#a78bfa" fill-opacity="0.08" stroke="#a78bfa" stroke-opacity="0.5" stroke-width="1.1"/>
  <text x="176" y="232" text-anchor="middle" font-size="11" fill="currentColor">pip install . + pinned gdal</text>
  <rect x="46" y="260" width="260" height="40" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.1"/>
  <text x="176" y="284" text-anchor="middle" font-size="11" fill="currentColor">artifact: /opt/venv</text>
  <!-- Copy arrow -->
  <line x1="308" y1="280" x2="392" y2="280" stroke="#15803d" stroke-opacity="0.7" stroke-width="1.6" marker-end="url(#arrg)"/>
  <text x="350" y="272" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">COPY --from=build</text>
  <!-- Runtime stage panel -->
  <rect x="392" y="66" width="312" height="252" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.5"/>
  <text x="548" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Stage 2: runtime (slim)</text>
  <rect x="418" y="104" width="260" height="40" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.1"/>
  <text x="548" y="128" text-anchor="middle" font-size="11" fill="currentColor">/opt/venv (copied, no compilers)</text>
  <rect x="418" y="156" width="260" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="548" y="180" text-anchor="middle" font-size="11" fill="currentColor">ENV GDAL_DATA / PROJ_LIB</text>
  <rect x="418" y="208" width="260" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="548" y="232" text-anchor="middle" font-size="11" fill="currentColor">USER appuser (non-root)</text>
  <rect x="418" y="260" width="260" height="40" rx="5" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.5" stroke-width="1.1"/>
  <text x="548" y="284" text-anchor="middle" font-size="11" fill="currentColor">ENTRYPOINT ["mytool"]</text>
  <defs>
    <marker id="arrg" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#15803d" opacity="0.7"/>
    </marker>
  </defs>
</svg>

## The Dockerfile

This is the complete, copy-pasteable `Dockerfile`. It assumes your package is named `geo-cli` and installs a console script called `mytool`. Adjust the GDAL tag to the version you tested against.

```dockerfile
# syntax=docker/dockerfile:1.7

########################  Stage 1: build  ########################
ARG GDAL_TAG=ubuntu-small-3.8.5
FROM ghcr.io/osgeo/gdal:${GDAL_TAG} AS build

# Build tools are needed to compile the osgeo.gdal bindings and any
# C extensions in your dependency tree. They stay in this stage only.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3-dev \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Isolate everything in a venv so the runtime stage copies one directory.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /src
COPY pyproject.toml README.md ./
COPY src ./src

# Pin the Python bindings to the EXACT system libgdal in this image.
# gdal-config ships with the OSGeo base and reports its own version.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir "gdal==$(gdal-config --version)" \
    && pip install --no-cache-dir .

########################  Stage 2: runtime  ######################
FROM ghcr.io/osgeo/gdal:${GDAL_TAG} AS runtime

# GDAL_DATA and PROJ_LIB point the C library at its support files.
# On the OSGeo ubuntu-small images these live under /usr/share.
ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    GDAL_DATA=/usr/share/gdal \
    PROJ_LIB=/usr/share/proj \
    PROJ_DATA=/usr/share/proj \
    PYTHONUNBUFFERED=1

# Copy only the finished venv. No compilers, headers or pip cache follow.
COPY --from=build /opt/venv /opt/venv

# Run unprivileged. A fixed UID keeps bind-mount permissions predictable.
RUN useradd --create-home --uid 10001 appuser
USER appuser
WORKDIR /work

# The console script from pyproject.toml is now on PATH inside the venv.
ENTRYPOINT ["mytool"]
CMD ["--help"]
```

Pair it with a `.dockerignore` so the build context stays small and secrets never leak into a layer:

```gitignore
.git
.venv
__pycache__/
*.pyc
*.tif
*.gpkg
dist/
build/
.pytest_cache/
.env
```

## Step Annotations

1. **`ARG GDAL_TAG` used in both `FROM` lines** — declaring the tag once and referencing it in the build and runtime stages guarantees they descend from the same `libgdal`. Overriding it at build time (`docker build --build-arg GDAL_TAG=ubuntu-small-3.9.2`) is how you feed a matrix of GDAL versions, which pairs with [matrix testing across GDAL versions](/cli-architecture-design-patterns/packaging-and-cicd/matrix-testing-a-geospatial-cli-across-gdal-versions/).
2. **`pip install "gdal==$(gdal-config --version)"`** — this is the single most important line. `gdal-config` reports the version of the system library baked into the base image, so the bindings compile against the exact `libgdal` present at runtime. Hard-coding a version, or omitting this and letting a dependency pull a PyPI wheel, is what produces version-mismatch crashes.
3. **The virtual environment as the sole artifact** — everything the app needs ends up in `/opt/venv`. The runtime stage copies that one directory, so build-only packages (`build-essential`, `python3-dev`) never inflate the shipped image.
4. **`GDAL_DATA`, `PROJ_LIB`, and `PROJ_DATA`** — GDAL resolves coordinate-system definitions from `GDAL_DATA` and PROJ resolves `proj.db` and datum grids from `PROJ_LIB`. PROJ 9 reads `PROJ_DATA` instead of `PROJ_LIB`, so setting both keeps the image working across PROJ major versions. Miss these and any reprojection raises a CRS error even though `libgdal` loaded fine.
5. **`useradd --uid 10001` and `USER appuser`** — the container drops root before the entrypoint runs. The fixed UID matters for bind mounts: a host directory must be writable by UID 10001 (or you pass `--user` at run time) for outputs to land.
6. **`ENTRYPOINT ["mytool"]` in exec form** — exec form (JSON array) makes the console script PID 1, so `SIGTERM` from `docker stop` reaches your CLI and it can flush partial output. Shell form would wrap it in `/bin/sh -c` and swallow signals. `CMD ["--help"]` gives a friendly default when the container is run with no arguments.

## Named Gotcha: The rasterio Wheel Bundles Its Own GDAL

If your CLI depends on rasterio and you `pip install rasterio` in the build stage, pip pulls a `manylinux` wheel that ships a **private, statically bundled copy of GDAL**. That bundled library clashes with the system `libgdal` in the OSGeo base image. The symptoms are ugly and intermittent: a `RuntimeError` about a GDAL version mismatch, a `PROJ: proj_create_from_database` failure, or a hard segfault when rasterio and `osgeo.gdal` are imported in the same process.

The fix is to force rasterio to compile against the system library instead of using its bundled one:

```dockerfile
# In the build stage, before "pip install ." — force a source build
RUN pip install --no-cache-dir --no-binary rasterio \
        "rasterio==$(python -c 'import subprocess,sys; \
        v=subprocess.check_output(["gdal-config","--version"]).decode().strip(); \
        print("1.3.10" if v.startswith("3.8") else "1.4.3")')"
```

Simpler still: pin a rasterio release whose bundled GDAL matches your base image tag (rasterio publishes which GDAL each wheel embeds), or add `--no-binary rasterio` to your `pip install` and let it link dynamically. Either way the goal is one GDAL in the image, not two. The same warning applies to `Fiona`; prefer pyogrio, which is more disciplined about linking against the system GDAL, for vector I/O.

## Verification

Build the image, then confirm the CLI runs and that GDAL can actually reproject a real raster from a mounted volume:

```bash
# Build with the pinned GDAL tag
docker build -t geo-cli:3.8.5 .

# 1. The console script and its GDAL are both present
docker run --rm geo-cli:3.8.5 --version

# 2. Confirm the bindings match the system library (must print the same version twice)
docker run --rm --entrypoint python geo-cli:3.8.5 -c \
    "from osgeo import gdal; import subprocess; \
     print('bindings', gdal.__version__); \
     print('system  ', subprocess.check_output(['gdal-config','--version']).decode().strip())"

# 3. End-to-end: warp a mounted EPSG:4326 GeoTIFF to EPSG:3857
mkdir -p data
gdal_translate -of GTiff -a_srs EPSG:4326 \
    -outsize 256 256 /vsimem/x.tif data/wgs84.tif 2>/dev/null || \
    curl -sL https://download.osgeo.org/geotiff/samples/gdal_eg/cea.tif -o data/wgs84.tif

docker run --rm -u "$(id -u):$(id -g)" \
    -v "$PWD/data:/work" geo-cli:3.8.5 \
    warp --src wgs84.tif --dst web_mercator.tif --t-srs EPSG:3857

# 4. Read back the CRS of the output written to the mounted host dir
docker run --rm --entrypoint gdalsrsinfo \
    -v "$PWD/data:/work" geo-cli:3.8.5 -o epsg /work/web_mercator.tif
```

Step 2 printing the same version from both the bindings and `gdal-config` is the proof that you avoided the mismatch trap. Step 4 printing `EPSG:3857` confirms the full transform chain — `GDAL_DATA`, `PROJ_LIB`, and the venv — works inside the container. If the warp exits non-zero with a CRS error, `PROJ_LIB` is almost certainly unset or pointing at the wrong directory.

## Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'osgeo'` | Bindings not installed, or venv not on `PATH` in runtime stage | Keep `ENV PATH="/opt/venv/bin:$PATH"` in the runtime stage |
| Bindings and system report different GDAL versions | A dependency pulled a PyPI gdal/rasterio wheel | `pip install "gdal==$(gdal-config --version)"`; `--no-binary rasterio` |
| `PROJ: proj_create: Cannot find proj.db` | `PROJ_LIB` / `PROJ_DATA` unset | `ENV PROJ_LIB=/usr/share/proj PROJ_DATA=/usr/share/proj` |
| Output file owned by root on the host | Container ran as root | Add `USER appuser` and run with `-u "$(id -u):$(id -g)"` |
| `Permission denied` writing to `/work` | Bind mount not writable by container UID | `chown` the host dir, or pass `--user` matching the mount owner |
| Image is 1.5 GB+ | Compilers and pip cache shipped in final image | Use the two-stage layout; copy only `/opt/venv` |

## FAQ

<details class="faq-item">
<summary>Why is my container GDAL version different from the Python package version?</summary>

The `osgeo.gdal` Python bindings must be built against the exact system `libgdal` in the image. If you pip-install a `gdal` wheel from PyPI it ships its own compiled library that shadows the system one. Run `pip install "gdal==$(gdal-config --version)"` against the OSGeo base image instead of pulling an arbitrary wheel.
</details>

<details class="faq-item">
<summary>How do I make PROJ find its transformation grids inside the image?</summary>

Set `PROJ_LIB` (and `PROJ_DATA` on PROJ 9) to the directory that holds `proj.db`, which is `/usr/share/proj` on the OSGeo images. Without it, pyproj and any datum transform fall back to an empty search path and raise a CRS error at runtime.
</details>

<details class="faq-item">
<summary>Should I run the container as root?</summary>

No. Create a dedicated non-root user with a fixed UID and switch to it with `USER` before the `ENTRYPOINT`. Bind-mounted output directories then need to be writable by that UID, which you control with the `--user` flag on `docker run` or `chown` on the host.
</details>

<details class="faq-item">
<summary>Why does rasterio segfault or report a GDAL version mismatch in my image?</summary>

The `manylinux` rasterio wheel bundles its own copy of GDAL, which clashes with the system `libgdal` in the OSGeo base image. Install it with `pip install --no-binary rasterio rasterio` so it links against the system library, or pin a rasterio release whose bundled GDAL matches your base image.
</details>

---

## Related

- [Packaging & CI/CD for Python GIS CLI Tools](/cli-architecture-design-patterns/packaging-and-cicd/) — parent guide covering wheels, entry points, and release automation for geospatial command-line tools
- [Matrix Testing a Geospatial CLI Across GDAL Versions](/cli-architecture-design-patterns/packaging-and-cicd/matrix-testing-a-geospatial-cli-across-gdal-versions/) — run the same image build against several pinned GDAL tags in CI to catch version drift early
