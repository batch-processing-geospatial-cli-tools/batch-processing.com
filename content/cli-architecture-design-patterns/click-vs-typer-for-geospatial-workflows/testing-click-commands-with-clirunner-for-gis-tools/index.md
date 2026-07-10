---
title: "Testing Click Commands with CliRunner for GIS Tools"
description: "Unit-test a Click shapefile-conversion command with CliRunner: assert exit codes, capture stderr, and inject in-memory rasterio fixtures without touching disk."
slug: "testing-click-commands-with-clirunner-for-gis-tools"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Click vs Typer for Geospatial Workflows"
    url: "/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/"
  - label: "Testing Click Commands with CliRunner for GIS Tools"
    url: "/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/testing-click-commands-with-clirunner-for-gis-tools/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Testing Click Commands with CliRunner for GIS Tools",
      "description": "Unit-test a Click shapefile-conversion command with CliRunner: assert exit codes, capture stderr, and inject in-memory rasterio fixtures without touching disk.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Click vs Typer for Geospatial Workflows", "item": "https://batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/"},
        {"@type": "ListItem", "position": 3, "name": "Testing Click Commands with CliRunner for GIS Tools", "item": "https://batch-processing.com/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/testing-click-commands-with-clirunner-for-gis-tools/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Test a Click geospatial CLI command with CliRunner",
      "step": [
        {"@type": "HowToStep", "name": "Build an in-memory raster fixture", "text": "Create a small EPSG:4326 raster in a rasterio MemoryFile and expose it as a pytest fixture so tests never touch disk."},
        {"@type": "HowToStep", "name": "Invoke the command with CliRunner", "text": "Instantiate CliRunner and call runner.invoke() inside isolated_filesystem() to run the reprojection command in a scratch directory."},
        {"@type": "HowToStep", "name": "Assert the success path", "text": "Check result.exit_code equals 0 and inspect result.output for the expected EPSG:3857 confirmation message."},
        {"@type": "HowToStep", "name": "Assert the CRS-mismatch failure path", "text": "Feed a raster whose CRS conflicts with the requested target and assert the domain exit code 10 with the error text on stderr."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does CliRunner capture logging output as well as stdout?",
          "acceptedAnswer": {"@type": "Answer", "text": "No. By default CliRunner captures click.echo() and anything written to sys.stdout, but the logging module writes to its own handlers, which are not redirected. Attach a caplog fixture or route diagnostics through click.echo(err=True) if you want to assert on them via result.output."}
        },
        {
          "@type": "Question",
          "name": "How do I separate stdout from stderr in a CliRunner result?",
          "acceptedAnswer": {"@type": "Answer", "text": "On Click 8.2 and later, CliRunner keeps the two streams apart automatically and result.output holds only stdout while result.stderr holds stderr. On older releases pass mix_stderr=False to the CliRunner constructor, otherwise both streams are merged into result.output."}
        },
        {
          "@type": "Question",
          "name": "Should I assert on result.exit_code or catch SystemExit?",
          "acceptedAnswer": {"@type": "Answer", "text": "Always assert on result.exit_code. CliRunner traps the SystemExit raised by Click internally and records the numeric code on the result object, so a try/except SystemExit around runner.invoke() never fires and would mask the real assertion."}
        },
        {
          "@type": "Question",
          "name": "Why use a rasterio MemoryFile instead of a temporary GeoTIFF on disk?",
          "acceptedAnswer": {"@type": "Answer", "text": "A MemoryFile builds the raster in RAM through GDAL's /vsimem/ virtual filesystem, so the test runs faster, leaves no artifacts, and works in read-only CI containers. Write the bytes to a path inside isolated_filesystem() only when the command opens a filename rather than a dataset object."}
        }
      ]
    }
  ]
}
</script>

# Testing Click Commands with CliRunner for GIS Tools

To test a Click-based geospatial CLI command, drive it with `click.testing.CliRunner`: call `runner.invoke(cmd, [...])` inside `runner.isolated_filesystem()`, then assert on `result.exit_code`, `result.output`, and `result.stderr` rather than calling the command function directly. Feeding it a small in-memory rasterio fixture lets you exercise both the success and CRS-mismatch paths without writing files. This page is part of the [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) guide.

## Prerequisites

- Python 3.10 or later
- `pip install "click>=8.1" pytest rasterio numpy pyproj`
- GDAL 3.4+ (rasterio ships manylinux wheels, so no separate system GDAL is required for the raster fixture below)

If you are still choosing a framework, the parent [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) comparison covers the trade-offs; Typer users get an equivalent harness through the [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) guide, since `typer.testing.CliRunner` wraps this same Click object.

## How CliRunner Isolates a Command

`CliRunner` never spawns a subprocess. It calls your command's callback in-process, redirects the standard streams into buffers, and traps the `SystemExit` that Click raises so it can record the numeric exit code on a `Result` object. The diagram below traces one `runner.invoke()` call from fixture to assertion.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Data flow of a CliRunner test: a rasterio MemoryFile fixture feeds runner.invoke inside an isolated filesystem, Click traps SystemExit, and the Result object exposes exit_code, output and stderr for assertions" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>CliRunner test data flow for a geospatial command</title>
  <desc>A rasterio MemoryFile fixture and CLI arguments enter runner.invoke, which runs the command inside an isolated filesystem. Click traps SystemExit and populates a Result object exposing exit_code, output, and stderr, each feeding a pytest assertion.</desc>
  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- Inputs -->
  <rect x="16" y="40" width="160" height="52" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="96" y="62" text-anchor="middle" font-size="11.5" fill="currentColor">MemoryFile fixture</text>
  <text x="96" y="79" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">EPSG:4326 raster</text>
  <rect x="16" y="108" width="160" height="52" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="96" y="130" text-anchor="middle" font-size="11.5" fill="currentColor">CLI arguments</text>
  <text x="96" y="147" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">--target EPSG:3857</text>
  <!-- invoke -->
  <rect x="250" y="66" width="180" height="68" rx="6" fill="#a78bfa" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.3"/>
  <text x="340" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">runner.invoke()</text>
  <text x="340" y="108" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">isolated_filesystem()</text>
  <text x="340" y="123" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">traps SystemExit</text>
  <!-- Result -->
  <rect x="504" y="66" width="196" height="68" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.3"/>
  <text x="602" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Result object</text>
  <text x="602" y="108" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">exit_code / output</text>
  <text x="602" y="123" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">stderr / exception</text>
  <!-- Assertions -->
  <rect x="504" y="196" width="196" height="46" rx="6" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="602" y="216" text-anchor="middle" font-size="11" fill="currentColor">assert exit_code == 0</text>
  <text x="602" y="232" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">success path</text>
  <rect x="504" y="262" width="196" height="46" rx="6" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2"/>
  <text x="602" y="282" text-anchor="middle" font-size="11" fill="currentColor">assert exit_code == 10</text>
  <text x="602" y="298" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">CRS-mismatch path</text>
  <!-- Arrows -->
  <line x1="176" y1="66" x2="248" y2="90" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="176" y1="134" x2="248" y2="108" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="430" y1="100" x2="502" y2="100" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="602" y1="134" x2="602" y2="194" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="560" y1="134" x2="560" y2="260" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ar)"/>
</svg>

## The Command Under Test

Assume a small conversion tool that reads a raster, checks its CRS against a requested target, and reprojects it. The command exits `0` on success, `2` on a usage error (Click handles that automatically), and the domain code `10` when the source CRS cannot be reconciled with the target.

```python
# gistools/reproject.py
from pathlib import Path

import click
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from pyproj import CRS


@click.command()
@click.argument("src", type=click.Path(exists=True, path_type=Path))
@click.argument("dst", type=click.Path(path_type=Path))
@click.option("--target", "target_epsg", required=True, help="Target CRS, e.g. EPSG:3857")
@click.option("--allow-geographic/--no-allow-geographic", default=False)
def reproject_cmd(src: Path, dst: Path, target_epsg: str, allow_geographic: bool) -> None:
    """Reproject SRC to DST in the --target CRS."""
    target = CRS.from_user_input(target_epsg)

    with rasterio.open(src) as ds:
        source = ds.crs
        if source is None:
            click.echo(f"error: {src} has no CRS", err=True)
            raise click.exceptions.Exit(10)
        # Domain rule: refuse a geographic->projected warp unless explicitly allowed.
        if source.is_geographic and target.is_projected and not allow_geographic:
            click.echo(
                f"error: refusing geographic {source.to_epsg()} to projected "
                f"{target.to_epsg()} without --allow-geographic",
                err=True,
            )
            raise click.exceptions.Exit(10)

        transform, width, height = calculate_default_transform(
            ds.crs, target, ds.width, ds.height, *ds.bounds
        )
        profile = ds.profile.copy()
        profile.update(crs=target, transform=transform, width=width, height=height)

        with rasterio.open(dst, "w", **profile) as out:
            for band in range(1, ds.count + 1):
                reproject(
                    source=rasterio.band(ds, band),
                    destination=rasterio.band(out, band),
                    resampling=Resampling.nearest,
                )

    click.echo(f"reprojected {src.name} to EPSG:{target.to_epsg()}")
```

## The pytest Module

This is the centrepiece: a fixture that builds an EPSG:4326 raster in a rasterio `MemoryFile`, plus two tests that drive the command with `CliRunner` and assert on the `Result`.

```python
# tests/test_reproject_cli.py
import numpy as np
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from click.testing import CliRunner

from gistools.reproject import reproject_cmd


@pytest.fixture
def wgs84_raster_bytes() -> bytes:
    """A 4x4 single-band EPSG:4326 GeoTIFF materialised entirely in memory."""
    data = np.arange(16, dtype="uint8").reshape(1, 4, 4)
    transform = from_bounds(west=-1.0, south=-1.0, east=1.0, north=1.0, width=4, height=4)
    with MemoryFile() as mem:
        with mem.open(
            driver="GTiff",
            height=4,
            width=4,
            count=1,
            dtype="uint8",
            crs="EPSG:4326",
            transform=transform,
        ) as ds:
            ds.write(data)
        return mem.read()          # raw GeoTIFF bytes, no file on disk yet


@pytest.fixture
def runner() -> CliRunner:
    # mix_stderr=False keeps result.output (stdout) separate from result.stderr.
    # On Click >= 8.2 the streams are always split and this kwarg is removed.
    return CliRunner(mix_stderr=False)


def test_reproject_success(runner, wgs84_raster_bytes):
    with runner.isolated_filesystem():
        # Only write to disk because the command opens a *filename*, not a dataset.
        with open("in.tif", "wb") as fh:
            fh.write(wgs84_raster_bytes)

        result = runner.invoke(
            reproject_cmd,
            ["in.tif", "out.tif", "--target", "EPSG:3857", "--allow-geographic"],
        )

        assert result.exit_code == 0, result.output
        assert "reprojected in.tif to EPSG:3857" in result.output
        with rasterio.open("out.tif") as out:
            assert out.crs.to_epsg() == 3857


def test_reproject_crs_mismatch(runner, wgs84_raster_bytes):
    with runner.isolated_filesystem():
        with open("in.tif", "wb") as fh:
            fh.write(wgs84_raster_bytes)

        # No --allow-geographic: the geographic source triggers domain code 10.
        result = runner.invoke(
            reproject_cmd,
            ["in.tif", "out.tif", "--target", "EPSG:3857"],
        )

        assert result.exit_code == 10
        assert "refusing geographic 4326 to projected 3857" in result.stderr


def test_missing_target_is_usage_error(runner, wgs84_raster_bytes):
    with runner.isolated_filesystem():
        with open("in.tif", "wb") as fh:
            fh.write(wgs84_raster_bytes)

        result = runner.invoke(reproject_cmd, ["in.tif", "out.tif"])

        # Click emits its own exit code 2 for a missing required option.
        assert result.exit_code == 2
        assert "Missing option" in result.stderr
```

## Step Annotations

1. **`MemoryFile` fixture returns bytes, not a path** — building the raster through GDAL's `/vsimem/` virtual filesystem means the test never allocates a temp file. Returning `mem.read()` hands the caller raw GeoTIFF bytes it can write wherever the command expects them, which keeps the fixture reusable across tests that need different filenames.

2. **`from_bounds(...)` for a real affine transform** — a raster without a valid transform makes `calculate_default_transform` raise, so the fixture pins a genuine 2x2 degree footprint. Using real coordinates keeps the test exercising the same code path as production data.

3. **`CliRunner(mix_stderr=False)`** — this splits `result.output` (stdout) from `result.stderr`. Without it, the `err=True` messages from the command land in `result.output` and your stderr assertions silently pass against merged text. On Click 8.2+ the split is the default and the kwarg is gone.

4. **`runner.isolated_filesystem()`** — this context manager `chdir`s into a fresh temporary directory and cleans it up afterwards, so the `out.tif` written by the command cannot collide with a real file or leak between tests. It is the reason the tests can use bare relative filenames.

5. **`assert result.exit_code == 0, result.output`** — attaching `result.output` as the assertion message means a failing run prints the captured stdout, turning an opaque `AssertionError: 0 != 1` into an actionable traceback from inside the command.

6. **`raise click.exceptions.Exit(10)`** — Click converts this into a `SystemExit(10)` that `CliRunner` traps and records as `result.exit_code`. Using the domain code `10` for a CRS mismatch keeps the exit-code contract consistent with the rest of the toolchain, distinct from Click's own `2` for usage errors.

## Named Gotcha: Wrapping `runner.invoke()` in `try/except SystemExit`

The most common mistake is asserting on a caught `SystemExit` instead of on `result.exit_code`. Because the command calls `raise click.exceptions.Exit(10)`, developers reach for:

```python
# WRONG — this except block never runs.
try:
    runner.invoke(reproject_cmd, ["in.tif", "out.tif", "--target", "EPSG:3857"])
except SystemExit as exc:
    assert exc.code == 10   # unreachable
```

`CliRunner.invoke()` already catches `SystemExit` internally and stores the code on the returned object. The `except` block is dead code, the assertion never executes, and the test passes no matter what the command does. The fix is to drop the `try/except` entirely and read `result.exit_code`, exactly as the working tests above do. If a genuinely unexpected exception escaped the command, inspect `result.exception` and `result.exc_info` — Click stores the original traceback there rather than re-raising it.

## Verification

Run the module and confirm all three paths are green:

```bash
pytest tests/test_reproject_cli.py -v
# test_reproject_success PASSED
# test_reproject_crs_mismatch PASSED
# test_missing_target_is_usage_error PASSED
```

To prove the failure test is not a false positive, temporarily flip the assertion to `result.exit_code == 0` and confirm it fails — a test that cannot fail is not testing anything. These same tests belong in the pipeline described in the [Packaging & CI/CD](/cli-architecture-design-patterns/packaging-and-cicd/) guide, where they run against the built wheel on every push.

## FAQ

<details class="faq-item">
<summary>Does CliRunner capture logging output as well as stdout?</summary>

No. By default `CliRunner` captures `click.echo()` and anything written to `sys.stdout`, but the `logging` module writes to its own handlers, which are not redirected. Attach a `caplog` fixture or route diagnostics through `click.echo(err=True)` if you want to assert on them via `result.output`.
</details>

<details class="faq-item">
<summary>How do I separate stdout from stderr in a CliRunner result?</summary>

On Click 8.2 and later, `CliRunner` keeps the two streams apart automatically and `result.output` holds only stdout while `result.stderr` holds stderr. On older releases pass `mix_stderr=False` to the `CliRunner` constructor, otherwise both streams are merged into `result.output`.
</details>

<details class="faq-item">
<summary>Should I assert on result.exit_code or catch SystemExit?</summary>

Always assert on `result.exit_code`. `CliRunner` traps the `SystemExit` raised by Click internally and records the numeric code on the result object, so a `try/except SystemExit` around `runner.invoke()` never fires and would mask the real assertion.
</details>

<details class="faq-item">
<summary>Why use a rasterio MemoryFile instead of a temporary GeoTIFF on disk?</summary>

A `MemoryFile` builds the raster in RAM through GDAL's `/vsimem/` virtual filesystem, so the test runs faster, leaves no artifacts, and works in read-only CI containers. Write the bytes to a path inside `isolated_filesystem()` only when the command opens a filename rather than a dataset object.
</details>

---

## Related

- [Click vs Typer for Geospatial Workflows](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/) — parent guide comparing both frameworks for CRS-aware command design and error handling
- [Migrating a Click Geospatial CLI to Typer](/cli-architecture-design-patterns/click-vs-typer-for-geospatial-workflows/migrating-a-click-geospatial-cli-to-typer/) — how the same test harness carries over once you move commands to Typer
