---
title: "Validating EPSG Codes as Typer CLI Options"
description: "Add a Typer callback that rejects invalid EPSG codes at the CLI boundary with pyproj, returning exit code 2 before any raster or vector I/O begins."
slug: "validating-epsg-codes-as-typer-cli-options"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Argument Parsing with Typer for Python GIS CLIs"
    url: "/cli-architecture-design-patterns/argument-parsing-with-typer/"
  - label: "Validating EPSG Codes as Typer CLI Options"
    url: "/cli-architecture-design-patterns/argument-parsing-with-typer/validating-epsg-codes-as-typer-cli-options/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

# Validating EPSG Codes as Typer CLI Options

To reject a bad EPSG code before any file is touched, attach a `callback=` to your Typer `--crs` option that normalises the value and resolves it through `pyproj.CRS.from_epsg`; on any failure raise `typer.BadParameter`, which prints a usage message and exits with code `2`. Because a callback runs before the command body, invalid input never reaches a `gdal.Open` or `pyogrio.read_dataframe` call. It builds on the [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) guide, part of the broader [CLI Architecture & Design Patterns](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install "typer>=0.12" "pyproj>=3.6"`
- pyproj ships its own bundled PROJ database, so no system GDAL is required for validation itself; the downstream I/O in your command may still need GDAL 3.4+

A CRS value is the most error-prone argument a geospatial command accepts, because a typo like `EPSG:4362` is a perfectly valid string that silently designates the wrong planet-scale projection. Enforcing it at the boundary keeps the rest of your pipeline honest. For how options and callbacks fit together, and where CRS validation sits relative to config-file defaults, see [Configuration File Management](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/).

## Where Validation Runs in the Call Order

The value of a callback is entirely about *when* it fires. Typer resolves and validates every option, running each option's callback, before it invokes your command function. A raised `typer.BadParameter` short-circuits the whole call: the command body never executes, so no dataset is opened and no output file is created.

<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Call order showing the --crs callback validating an EPSG code before the command body opens any dataset, with invalid input exiting with code 2" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>EPSG validation runs before dataset I/O</title>
  <desc>A left-to-right flow: the CLI parses the raw --crs token, the callback normalises and resolves it with pyproj, then either the command body opens datasets on success or the process exits with code 2 on failure before any I/O.</desc>
  <!-- Stage 1: raw token -->
  <rect x="12" y="96" width="150" height="60" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="87" y="120" text-anchor="middle" font-size="12" fill="currentColor">Raw --crs token</text>
  <text x="87" y="138" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">"4326" or "EPSG:4326"</text>
  <!-- arrow -->
  <line x1="162" y1="126" x2="205" y2="126" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a)"/>
  <!-- Stage 2: callback -->
  <rect x="207" y="82" width="176" height="88" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.6" stroke-width="1.4"/>
  <text x="295" y="106" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">callback runs here</text>
  <text x="295" y="126" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">normalise to int</text>
  <text x="295" y="142" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">CRS.from_epsg()</text>
  <text x="295" y="158" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">before any I/O</text>
  <!-- success arrow -->
  <line x1="383" y1="110" x2="520" y2="66" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="452" y="78" text-anchor="middle" font-size="10" fill="#15803d">valid</text>
  <!-- failure arrow -->
  <line x1="383" y1="150" x2="520" y2="196" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="452" y="188" text-anchor="middle" font-size="10" fill="#c0392b">invalid</text>
  <!-- Stage 3a: command body -->
  <rect x="524" y="30" width="184" height="60" rx="6" fill="#27ae60" fill-opacity="0.08" stroke="#27ae60" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="616" y="54" text-anchor="middle" font-size="11" fill="currentColor">Command body</text>
  <text x="616" y="72" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">opens raster / vector</text>
  <!-- Stage 3b: exit 2 -->
  <rect x="524" y="176" width="184" height="60" rx="6" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="616" y="200" text-anchor="middle" font-size="11" fill="currentColor">BadParameter</text>
  <text x="616" y="218" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">exit code 2, no I/O</text>
  <defs>
    <marker id="a" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The command below reprojects a vector file. The `--crs` option carries a `callback` that does all the validation; the command body assumes it received a canonical, resolvable EPSG string. Copy it, run `python crs_cli.py reproject input.gpkg output.gpkg --crs 4326`, and try a bad code to see the exit behaviour.

```python
#!/usr/bin/env python3
"""
Validate an EPSG code at the Typer CLI boundary before any dataset I/O.
Usage: python crs_cli.py reproject input.gpkg output.gpkg --crs EPSG:32633
"""
from pathlib import Path

import typer
import pyproj
from pyproj.exceptions import CRSError

app = typer.Typer(add_completion=False)

def normalise_epsg(raw: str) -> int:
    """Reduce '4326' or 'EPSG:4326' to the integer 4326.

    Accepts an optional, case-insensitive 'EPSG:' authority prefix and
    nothing else. Any other authority (ESRI:, IAU:) is rejected here so
    the rest of the pipeline only ever deals with EPSG integer codes.
    """
    token = raw.strip()
    if ":" in token:
        authority, _, code = token.partition(":")
        if authority.upper() != "EPSG":
            raise ValueError(f"unsupported authority {authority!r}; expected EPSG")
        token = code
    return int(token)  # raises ValueError on non-numeric input

def validate_crs(value: str) -> str:
    """Typer callback: turn any bad EPSG code into an exit-code-2 usage error.

    Runs BEFORE the command body, so an invalid code never reaches file I/O.
    Returns the canonical 'EPSG:<code>' string on success.
    """
    try:
        code = normalise_epsg(value)
    except ValueError as exc:
        # Non-numeric, or a non-EPSG authority prefix.
        raise typer.BadParameter(f"{value!r} is not an EPSG code ({exc})")

    try:
        # from_epsg rejects syntactically valid but unregistered codes.
        crs = pyproj.CRS.from_epsg(code)
    except CRSError:
        raise typer.BadParameter(
            f"EPSG:{code} is not a known coordinate reference system"
        )

    # Return the normalised, canonical form for the command body to consume.
    return f"EPSG:{crs.to_epsg()}"

@app.command()
def reproject(
    source: Path = typer.Argument(..., exists=True, dir_okay=False,
                                   help="Input vector dataset"),
    destination: Path = typer.Argument(..., dir_okay=False,
                                        help="Output vector dataset"),
    crs: str = typer.Option(
        "EPSG:4326",
        "--crs",
        callback=validate_crs,       # validation happens here, pre-command
        help="Target CRS as an EPSG code (e.g. 4326 or EPSG:4326)",
    ),
) -> None:
    """Reproject SOURCE to the target CRS and write DESTINATION."""
    # By the time we reach this line, `crs` is guaranteed resolvable.
    import pyogrio  # imported lazily so --help stays fast

    typer.echo(f"Reprojecting {source} to {crs}")
    gdf = pyogrio.read_dataframe(source)
    gdf = gdf.to_crs(crs)
    pyogrio.write_dataframe(gdf, destination)
    typer.echo(f"Wrote {destination}")

if __name__ == "__main__":
    app()
```

## Step Annotations

1. **`normalise_epsg` splits authority from code** — `str.partition(":")` cleanly handles both `4326` (no colon, returned as-is) and `EPSG:4326`. Rejecting any non-`EPSG` authority here keeps the contract narrow: the command body only ever sees an EPSG integer, so downstream reprojection logic never has to branch on authority.

2. **`int(token)` is where the string-vs-int trap is defused** — Typer hands the callback the raw command-line string, so `4326` arrives as `"4326"`. The explicit `int()` both converts it and rejects garbage like `"EPSG:abc"` via `ValueError`, which the surrounding `try` turns into a clean usage error.

3. **`pyproj.CRS.from_epsg(code)` is the real gate** — Passing an integer to `from_epsg` looks the code up in the bundled PROJ/EPSG database. A number that is well-formed but unregistered, such as `9999`, raises `CRSError` here rather than surfacing as a confusing failure deep inside `to_crs`.

4. **`raise typer.BadParameter(...)`** — This is the bridge between pyproj's exception vocabulary and Typer's CLI contract. Typer catches it, prints `Invalid value for '--crs': ...` to stderr, and exits with code `2` — the POSIX usage-error code — without a Python traceback.

5. **`callback=validate_crs` on the option** — Wiring the function as `callback=` is what guarantees it runs before `reproject`'s body. The command receives the callback's return value, so `crs` inside the body is the canonical `EPSG:4326` string, already validated.

6. **Lazy `import pyogrio`** — Deferring the heavy vector-I/O import until after validation keeps `--help` and error paths fast, and ensures a bad `--crs` never even loads the GDAL-backed reader.

## Named Gotcha: A Well-Formed Code That Does Not Exist

The failure that slips past naive validation is the *syntactically valid but non-existent* code, most famously `EPSG:9999`. A regex check like `^(EPSG:)?\d+$` accepts it happily, and even `int("9999")` succeeds — so a hand-rolled validator that only checks "is it a number?" waves it through. The bad value then travels all the way into `gdf.to_crs("EPSG:9999")`, where pyproj finally raises `CRSError` after the input file has already been read into memory.

The fix is to make `pyproj.CRS.from_epsg` itself the authority, as in the implementation above. It performs a real database lookup, so `from_epsg(9999)` raises `CRSError` and the callback converts it to exit code `2` before a single byte of vector data is read:

```python
>>> import pyproj
>>> pyproj.CRS.from_epsg(4326)   # OK
<Geographic 2D CRS: EPSG:4326>
>>> pyproj.CRS.from_epsg(9999)   # CRSError: crs not found
Traceback (most recent call last):
pyproj.exceptions.CRSError: Invalid projection: EPSG:9999
```

If you accept arbitrary CRS strings elsewhere (WKT, PROJ pipelines), swap `CRS.from_epsg` for `pyproj.CRS.from_user_input` and read the resulting `crs.to_epsg()` — but for an option documented as an EPSG code, `from_epsg` gives the tightest, clearest rejection.

## Verification

Confirm both the accept and reject paths, and check the exit code the shell sees:

```bash
# Valid: bare integer form is accepted and normalised
python crs_cli.py reproject in.gpkg out.gpkg --crs 4326
echo "exit: $?"          # -> exit: 0

# Valid: prefixed form resolves to the same canonical value
python crs_cli.py reproject in.gpkg out.gpkg --crs EPSG:32633
echo "exit: $?"          # -> exit: 0

# Invalid: well-formed but unregistered code is rejected before I/O
python crs_cli.py reproject in.gpkg out.gpkg --crs EPSG:9999
echo "exit: $?"          # -> Invalid value for '--crs': ... ; exit: 2

# Invalid: non-numeric input
python crs_cli.py reproject in.gpkg out.gpkg --crs WGS84
echo "exit: $?"          # -> Invalid value for '--crs': ... ; exit: 2
```

An exit code of `2` on the last two calls — with `out.gpkg` never created — proves the callback stops bad input at the boundary. You can assert this directly in tests with Typer's `CliRunner`:

```python
from typer.testing import CliRunner
from crs_cli import app

runner = CliRunner()

def test_unknown_epsg_exits_2(tmp_path):
    src = tmp_path / "in.gpkg"
    src.write_bytes(b"")            # existence check only; never opened
    result = runner.invoke(app, ["reproject", str(src),
                                 str(tmp_path / "out.gpkg"), "--crs", "EPSG:9999"])
    assert result.exit_code == 2
    assert not (tmp_path / "out.gpkg").exists()
```

## FAQ

<details class="faq-item">
<summary>Why does my callback receive a string when I typed a number?</summary>

Typer passes the raw command-line token to a `str`-typed option, so `4326` arrives as the string `"4326"`, not the integer `4326`. Strip any `EPSG:` prefix and call `int()` yourself before handing the value to pyproj, and raise `typer.BadParameter` if the `int()` conversion fails.
</details>

<details class="faq-item">
<summary>Does pyproj reject a code like EPSG:9999?</summary>

Yes. `EPSG:9999` is syntactically valid but is not registered in the EPSG database, so `pyproj.CRS.from_epsg(9999)` raises `pyproj.exceptions.CRSError`. Catching that error and re-raising `typer.BadParameter` is what turns an unknown authority code into a clean exit code `2` instead of a stack trace later.
</details>

<details class="faq-item">
<summary>What exit code does typer.BadParameter produce?</summary>

`typer.BadParameter` causes Typer to print a usage error to stderr and exit with code `2`, matching the POSIX convention for command-line usage errors. This lets shell scripts and CI jobs distinguish bad arguments from runtime failures, which exit with code `1`.
</details>

<details class="faq-item">
<summary>Should I validate the CRS in the callback or inside the command?</summary>

Validate in the callback. A callback runs before the command body, so a bad EPSG code fails before any raster or vector file is opened. Validating inside the command wastes the cost of opening a dataset and risks partial writes before the CRS is checked.
</details>

---

## Related

- [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/) — parent guide covering options, arguments, and callback-based validation at the CLI boundary
- [How to Build a Typer CLI for Shapefile Conversion](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/how-to-build-a-typer-cli-for-shapefile-conversion/) — a full Typer command that consumes a validated CRS to convert and reproject vector data
