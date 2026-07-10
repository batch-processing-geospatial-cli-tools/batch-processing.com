---
title: "Matrix Testing a Geospatial CLI Across GDAL Versions"
description: "Configure a GitHub Actions matrix that runs your CLI test suite against multiple GDAL and Python versions to catch driver and API regressions before release."
slug: "matrix-testing-a-geospatial-cli-across-gdal-versions"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Packaging & CI/CD for Python GIS CLI Tools"
    url: "/cli-architecture-design-patterns/packaging-and-cicd/"
  - label: "Matrix Testing a Geospatial CLI Across GDAL Versions"
    url: "/cli-architecture-design-patterns/packaging-and-cicd/matrix-testing-a-geospatial-cli-across-gdal-versions/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Matrix Testing a Geospatial CLI Across GDAL Versions",
      "description": "Configure a GitHub Actions matrix that runs your CLI test suite against multiple GDAL and Python versions to catch driver and API regressions before release.",
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
        {"@type": "ListItem", "position": 3, "name": "Matrix Testing a Geospatial CLI Across GDAL Versions", "item": "https://batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/matrix-testing-a-geospatial-cli-across-gdal-versions/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Matrix Test a Geospatial CLI Across GDAL Versions",
      "step": [
        {"@type": "HowToStep", "name": "Declare the matrix", "text": "Define a strategy.matrix over python-version and gdal-version with fail-fast set to false so one red job does not cancel the rest."},
        {"@type": "HowToStep", "name": "Run inside an official GDAL container", "text": "Set the job container to ghcr.io/osgeo/gdal so the C library and Python bindings are pinned to the exact GDAL version under test."},
        {"@type": "HowToStep", "name": "Install and pin bindings", "text": "Install the package and pin rasterio and pyproj to versions built against the container GDAL to avoid ABI mismatches."},
        {"@type": "HowToStep", "name": "Run pytest with coverage", "text": "Execute pytest with coverage and assert that a reprojection to EPSG:3857 produces the expected coordinates."},
        {"@type": "HowToStep", "name": "Upload coverage per job", "text": "Upload the coverage report with a job-specific flag so each GDAL and Python combination is tracked separately."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Should I test against GDAL container images or conda-forge builds?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use the official ghcr.io/osgeo/gdal container images when you want the exact C library and system bindings the OSGeo project ships, and they start fast in CI. Use conda-forge gdal pins when your users install via conda or when you need a GDAL version not published as an image. Many projects run both as separate matrix legs to cover both installation paths."}
        },
        {
          "@type": "Question",
          "name": "Why does my reprojection test pass on GDAL 3.4 but fail on GDAL 3.8?",
          "acceptedAnswer": {"@type": "Answer", "text": "The most common cause is authority-compliant axis order. Since PROJ 6 and GDAL 3, transformations respect the CRS axis order, so EPSG:4326 is latitude then longitude. If your test hardcodes longitude-first inputs it can drift across GDAL and PROJ point releases. Pin pyproj and rasterio to versions built against the container GDAL and assert on rounded coordinates rather than exact floats."}
        },
        {
          "@type": "Question",
          "name": "How do I skip a known-incompatible GDAL and Python combination?",
          "acceptedAnswer": {"@type": "Answer", "text": "Add an exclude entry under strategy.matrix that names the exact python-version and gdal-version pair to drop, or use include to add a single extra leg without expanding the full cross product. This keeps the matrix green when a specific combination has no compatible wheel or container image."}
        },
        {
          "@type": "Question",
          "name": "How do I confirm each job actually used the GDAL version I intended?",
          "acceptedAnswer": {"@type": "Answer", "text": "Add a step that runs gdalinfo --version and python -c to print rasterio.gdal_version() before pytest. Printing the resolved version in the log proves the container or conda pin took effect and makes a silent fallback to a cached GDAL obvious in the job output."}
        }
      ]
    }
  ]
}
</script>

# Matrix Testing a Geospatial CLI Across GDAL Versions

To test a geospatial CLI across GDAL versions, define a GitHub Actions `strategy.matrix` over `python-version` and `gdal-version`, run each job inside the matching `ghcr.io/osgeo/gdal` container (or a conda-forge `gdal=<ver>` pin), install your package, run `pytest`, and upload coverage per job. Set `fail-fast: false` so one red combination does not cancel the rest. This page is part of the [Packaging & CI/CD for Python GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/) guide within the broader [CLI Architecture & Design Patterns for Python GIS](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later, with your CLI installable via `pip install -e .`
- A test suite using `pytest` and `pytest-cov`
- Familiarity with GitHub Actions workflow YAML
- GDAL is provided by the container image or conda environment in CI — you do not install it with pip

The core problem is that GDAL is a C library, and its Python bindings (`rasterio`, `pyproj`, `fiona`/`pyogrio`) are compiled against a specific ABI. A test that passes against GDAL 3.4 can regress on GDAL 3.8 because a driver was renamed, a default changed, or axis-order handling shifted. A version matrix surfaces these regressions before your users do. For how these pins fit into your release story, see the parent [Packaging & CI/CD for Python GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/) guide.

## How the Matrix Fans Out

Each cell in the matrix is an isolated job with its own GDAL container and Python interpreter. The diagram below shows how one workflow expands into a grid of jobs, with one combination excluded because no compatible build exists.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A GitHub Actions matrix expands one workflow into a grid of jobs across three GDAL versions and two Python versions, with one incompatible combination excluded" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>GDAL and Python test matrix expansion</title>
  <desc>A single workflow definition on the left fans out into a grid of six jobs, three GDAL versions across the top and two Python versions down the side. Five cells are green passing jobs; one cell is marked excluded because no compatible build exists.</desc>
  <!-- Source workflow -->
  <rect x="12" y="130" width="150" height="70" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.6" stroke-width="1.4"/>
  <text x="87" y="158" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ci.yml</text>
  <text x="87" y="176" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">strategy.matrix</text>
  <text x="87" y="190" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">fail-fast: false</text>
  <!-- Fan arrow -->
  <line x1="162" y1="165" x2="228" y2="165" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#mx)"/>
  <!-- Column headers (GDAL versions) -->
  <text x="330" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">GDAL 3.4</text>
  <text x="470" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">GDAL 3.6</text>
  <text x="610" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">GDAL 3.8</text>
  <!-- Row headers (Python versions) -->
  <text x="250" y="128" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Py 3.10</text>
  <text x="250" y="238" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Py 3.12</text>
  <!-- Row 1 cells -->
  <rect x="278" y="98" width="104" height="54" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="330" y="122" text-anchor="middle" font-size="15" fill="#15803d">✓</text>
  <text x="330" y="140" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">pytest pass</text>
  <rect x="418" y="98" width="104" height="54" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="470" y="122" text-anchor="middle" font-size="15" fill="#15803d">✓</text>
  <text x="470" y="140" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">pytest pass</text>
  <rect x="558" y="98" width="104" height="54" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="610" y="122" text-anchor="middle" font-size="15" fill="#15803d">✓</text>
  <text x="610" y="140" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">pytest pass</text>
  <!-- Row 2 cells -->
  <rect x="278" y="208" width="104" height="54" rx="5" fill="currentColor" fill-opacity="0.05" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="4 3"/>
  <text x="330" y="232" text-anchor="middle" font-size="13" fill="#c0392b">excluded</text>
  <text x="330" y="250" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">no wheel</text>
  <rect x="418" y="208" width="104" height="54" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="470" y="232" text-anchor="middle" font-size="15" fill="#15803d">✓</text>
  <text x="470" y="250" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">pytest pass</text>
  <rect x="558" y="208" width="104" height="54" rx="5" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="610" y="232" text-anchor="middle" font-size="15" fill="#15803d">✓</text>
  <text x="610" y="250" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">pytest pass</text>
  <!-- Caption -->
  <text x="360" y="312" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">6 combinations minus 1 exclude = 5 isolated jobs, each with its own gdalinfo --version</text>
  <defs>
    <marker id="mx" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The workflow below runs your CLI test suite against three GDAL versions and two Python versions using the official OSGeo container images. It pins `rasterio` and `pyproj` to builds compatible with the container GDAL, runs `pytest` with coverage, and uploads a per-job coverage artifact. Save it as `.github/workflows/gdal-matrix.yml`:

```yaml
name: gdal-matrix

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    # Run every job inside the exact GDAL the leg targets. The bindings
    # already present in the image match this GDAL's ABI.
    container:
      image: ghcr.io/osgeo/gdal:ubuntu-small-${{ matrix.gdal-version }}
    strategy:
      # Do not cancel sibling jobs when one GDAL version regresses.
      fail-fast: false
      matrix:
        python-version: ["3.10", "3.12"]
        gdal-version: ["3.4.3", "3.6.4", "3.8.5"]
        include:
          # Add one extra leg pinning the newest GDAL without expanding
          # the full cross product.
          - python-version: "3.12"
            gdal-version: "3.9.2"
        exclude:
          # GDAL 3.4 image ships no interpreter compatible with 3.12.
          - python-version: "3.12"
            gdal-version: "3.4.3"
    name: py${{ matrix.python-version }} · gdal${{ matrix.gdal-version }}
    steps:
      - uses: actions/checkout@v4

      - name: Report the resolved GDAL version
        run: |
          gdalinfo --version
          echo "GDAL_VERSION=$(gdal-config --version)" >> "$GITHUB_ENV"

      - name: Install test dependencies and the package
        run: |
          python3 -m pip install --upgrade pip
          # Pin bindings to the container GDAL so pip does not pull a
          # wheel built against a different ABI (GDAL_VERSION set above).
          case "$GDAL_VERSION" in
            3.8*|3.9*) RASTERIO=1.3.11 ;;
            *)         RASTERIO=1.3.9  ;;
          esac
          python3 -m pip install \
            "rasterio==${RASTERIO}" \
            "pyproj>=3.6,<3.8" \
            pytest pytest-cov
          python3 -m pip install -e . --no-build-isolation

      - name: Run the CLI test suite with coverage
        run: |
          pytest -q \
            --cov=geocli --cov-report=xml:coverage.xml \
            --junitxml=results.xml

      - name: Upload coverage for this matrix leg
        uses: actions/upload-artifact@v4
        with:
          name: coverage-py${{ matrix.python-version }}-gdal${{ matrix.gdal-version }}
          path: coverage.xml
          if-no-files-found: error
```

The reprojection assertion the matrix is meant to protect lives in an ordinary `pytest` file. This test proves that a point transformed from `EPSG:4326` to `EPSG:3857` lands where Web Mercator expects it, and it is stable across GDAL point releases because it rounds the result:

```python
# tests/test_reproject.py
import math

import pytest
from pyproj import CRS, Transformer


def reproject_point(lon: float, lat: float) -> tuple[float, float]:
    """Reproject a lon/lat point to Web Mercator (EPSG:3857).

    always_xy=True forces longitude-first input regardless of the
    authority axis order, so this call is stable across GDAL/PROJ versions.
    """
    transformer = Transformer.from_crs(
        CRS.from_epsg(4326),
        CRS.from_epsg(3857),
        always_xy=True,
    )
    return transformer.transform(lon, lat)


def test_reprojection_to_web_mercator():
    # Null Island's neighbour: 1 degree east, on the equator.
    easting, northing = reproject_point(1.0, 0.0)

    # 1 degree of longitude at the equator in EPSG:3857.
    assert math.isclose(easting, 111319.49, abs_tol=0.5)
    # The equator maps to northing 0 in Web Mercator.
    assert math.isclose(northing, 0.0, abs_tol=1e-6)


@pytest.mark.parametrize("epsg", [3857, 32633])
def test_target_crs_is_projected(epsg):
    # Guard against a CRS regression: both targets must be projected,
    # never geographic, or downstream pixel maths breaks.
    assert CRS.from_epsg(epsg).is_projected
```

## Step Annotations

1. **`container.image` interpolates `matrix.gdal-version`** — Running the whole job inside `ghcr.io/osgeo/gdal:ubuntu-small-<ver>` means the GDAL C library, `gdal-config`, and the bundled Python bindings all match the version under test. There is no separate GDAL install step and no risk of a cached system GDAL shadowing it.

2. **`fail-fast: false`** — By default GitHub Actions cancels every sibling job the moment one fails. For a compatibility matrix that is exactly the wrong behaviour: you want to see that GDAL 3.8 is the only red leg, not have the run aborted before GDAL 3.4 and 3.6 finish. Set it to `false`.

3. **`include:` adds a single extra leg** — The `include` block appends one `python-version: 3.12` / `gdal-version: 3.9.2` job without multiplying it across every Python version. Use it to smoke-test a bleeding-edge GDAL on your newest interpreter only.

4. **`exclude:` drops an impossible combination** — The GDAL 3.4 image predates Python 3.12, so that cell can never install. Naming the exact pair under `exclude` keeps the matrix green instead of carrying a permanently red job that trains reviewers to ignore failures.

5. **`gdalinfo --version` before anything else** — Printing the resolved version at the top of the log is your proof that the container pin took effect. If a step silently fell back to a cached GDAL, this line makes it obvious instead of letting a stale binding pass the suite.

6. **Pinning `rasterio` and `pyproj` to the container GDAL** — pip wheels for `rasterio` bundle their own GDAL, which can override the container's. Installing a `rasterio` version built for the container GDAL, or building with `--no-build-isolation` against the system GDAL, keeps the ABI consistent. This is the single most common source of matrix flakiness.

7. **`always_xy=True` in the transformer** — This forces longitude-first input and output regardless of the CRS authority axis order, making the reprojection deterministic across PROJ and GDAL point releases. The named gotcha below explains why this matters.

## Named Gotcha: Axis Order Changes Between GDAL Versions

The single most common cross-version failure is authority-compliant axis order. Since GDAL 3 and PROJ 6, coordinate transformations honour the axis order declared by the CRS authority, so `EPSG:4326` is latitude-then-longitude, not the longitude-first convention many older scripts assume. A test that hardcodes `transformer.transform(lon, lat)` against a `Transformer` built without `always_xy=True` can silently swap coordinates, and the exact behaviour drifts as `pyproj` and its bundled PROJ move between GDAL 3.4, 3.6, and 3.8. Driver defaults shift too — for example, creation-option defaults and NULL-handling in some drivers changed across these releases.

The fix is twofold. First, always build transformers with `always_xy=True` so your CLI's coordinate order is explicit and version-independent, as shown in the test above. Second, pin `pyproj` and `rasterio` to versions built against the GDAL in each matrix leg, rather than letting pip resolve whatever wheel it prefers. When your CLI reads pins or driver preferences from configuration, keep them consistent across environments using the [Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/) pattern so local runs and CI resolve the same GDAL behaviour. For exercising the command entry points themselves, drive them with [Testing Click Commands with CliRunner for GIS Tools](https://www.batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/testing-click-commands-with-clirunner-for-gis-tools/).

## Verification

A correctly configured matrix shows one green check per surviving combination on the pull request, and each job log names the GDAL it used. Confirm the pins locally before pushing:

```bash
# Confirm the container GDAL and the binding GDAL agree.
gdalinfo --version
python3 -c "import rasterio; print('rasterio sees GDAL', rasterio.gdal_version())"
python3 -c "import pyproj; print('PROJ', pyproj.proj_version_str)"

# Run only the reprojection guard, quietly.
pytest tests/test_reproject.py -q
```

If `gdalinfo --version` and `rasterio.gdal_version()` disagree, a mismatched wheel slipped in and the leg is testing the wrong GDAL. When both report the same version and `pytest` exits `0`, the matrix leg is trustworthy. A non-zero exit from `pytest` (exit code `1`) on a single GDAL version, with siblings green, is the exact regression signal this workflow exists to produce.

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| `rasterio.gdal_version()` differs from `gdalinfo --version` | pip pulled a wheel bundling its own GDAL | Pin `rasterio` to the container GDAL or install `--no-build-isolation` |
| Reprojection off by swapped coordinates | Authority axis order (lat/lon vs lon/lat) | Build `Transformer` with `always_xy=True` |
| Whole run cancels on first red leg | `fail-fast` defaults to `true` | Set `fail-fast: false` under `strategy` |
| One matrix cell can never install | GDAL image predates the Python version | Add the pair to `exclude:` |
| `PROJ: proj_create: cannot find proj.db` | `PROJ_DATA` unset in the container | Export `PROJ_DATA=/usr/share/proj` before `pytest` |

## FAQ

<details class="faq-item">
<summary>Should I test against GDAL container images or conda-forge builds?</summary>

Use the official `ghcr.io/osgeo/gdal` container images when you want the exact C library and system bindings the OSGeo project ships, and they start fast in CI. Use conda-forge `gdal=<ver>` pins when your users install via conda or when you need a GDAL version not published as an image. Many projects run both as separate matrix legs to cover both installation paths.
</details>

<details class="faq-item">
<summary>Why does my reprojection test pass on GDAL 3.4 but fail on GDAL 3.8?</summary>

The most common cause is authority-compliant axis order. Since PROJ 6 and GDAL 3, transformations respect the CRS axis order, so `EPSG:4326` is latitude then longitude. If your test hardcodes longitude-first inputs it can drift across GDAL and PROJ point releases. Pin `pyproj` and `rasterio` to versions built against the container GDAL and assert on rounded coordinates rather than exact floats.
</details>

<details class="faq-item">
<summary>How do I skip a known-incompatible GDAL and Python combination?</summary>

Add an `exclude` entry under `strategy.matrix` that names the exact `python-version` and `gdal-version` pair to drop, or use `include` to add a single extra leg without expanding the full cross product. This keeps the matrix green when a specific combination has no compatible wheel or container image.
</details>

<details class="faq-item">
<summary>How do I confirm each job actually used the GDAL version I intended?</summary>

Add a step that runs `gdalinfo --version` and `python -c` to print `rasterio.gdal_version()` before `pytest`. Printing the resolved version in the log proves the container or conda pin took effect and makes a silent fallback to a cached GDAL obvious in the job output.
</details>

---

## Related

- [Packaging & CI/CD for Python GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/) — parent guide covering wheels, container builds, and release automation for geospatial command-line tools
- [Building a Docker Image with GDAL for a Python CLI](https://www.batch-processing.com/cli-architecture-design-patterns/packaging-and-cicd/building-a-docker-image-with-gdal-for-a-python-cli/) — package the same pinned GDAL you test against into a reproducible runtime image
