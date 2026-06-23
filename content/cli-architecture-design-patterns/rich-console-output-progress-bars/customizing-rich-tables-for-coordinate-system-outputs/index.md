---
title: "Customizing Rich Tables for Coordinate System Outputs"
description: "Render EPSG codes, WKT strings, and bounding boxes in a Rich table without layout collapse — column constraints, conditional styling, and pyproj integration."
slug: "customizing-rich-tables-for-coordinate-system-outputs"
type: "long_tail"
breadcrumb:
  - label: "CLI Architecture & Design Patterns"
    url: "/cli-architecture-design-patterns/"
  - label: "Rich Console Output & Progress Bars"
    url: "/cli-architecture-design-patterns/rich-console-output-progress-bars/"
  - label: "Customizing Rich Tables for Coordinate System Outputs"
    url: "/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/"
datePublished: "2024-03-12"
dateModified: "2026-06-23"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Customizing Rich Tables for Coordinate System Outputs",
      "description": "How to render EPSG codes, WKT strings, and bounding boxes in a Rich table without layout collapse — explicit column constraints, conditional styling, and pyproj integration.",
      "datePublished": "2024-03-12",
      "dateModified": "2026-06-23",
      "author": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "CLI Architecture & Design Patterns", "item": "https://batch-processing.com/cli-architecture-design-patterns/"},
        {"@type": "ListItem", "position": 2, "name": "Rich Console Output & Progress Bars", "item": "https://batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/"},
        {"@type": "ListItem", "position": 3, "name": "Customizing Rich Tables for Coordinate System Outputs", "item": "https://batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/customizing-rich-tables-for-coordinate-system-outputs/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Customize Rich Tables for Coordinate System Outputs",
      "step": [
        {"@type": "HowToStep", "name": "Install dependencies", "text": "Install rich>=13.0.0 and pyproj>=3.4."},
        {"@type": "HowToStep", "name": "Define column constraints", "text": "Use add_column() with width, max_width, overflow, and justify to prevent layout collapse on long WKT strings."},
        {"@type": "HowToStep", "name": "Resolve CRS via pyproj", "text": "Parse every input through CRS.from_user_input() to extract EPSG code, type name, and area-of-use bounds."},
        {"@type": "HowToStep", "name": "Apply conditional markup", "text": "Use Rich inline markup to colour-code geographic vs projected CRS types and flag invalid entries."},
        {"@type": "HowToStep", "name": "Verify output", "text": "Run the verification snippet to confirm column widths and row counts match expectations."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does my Rich table overflow on narrow CI runners?",
          "acceptedAnswer": {"@type": "Answer", "text": "Rich respects the COLUMNS environment variable, but without explicit max_width on each column the table can exceed the runner's 80-column default. Set max_width on every variable-length column and use overflow='ellipsis' to hard-cap expansion."}
        },
        {
          "@type": "Question",
          "name": "When should I use overflow='fold' versus overflow='ellipsis'?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use fold for WKT or PROJ strings that need to remain copy-pasteable in the terminal. Use ellipsis for bounding-box or name columns where truncation is acceptable for quick scanning."}
        },
        {
          "@type": "Question",
          "name": "How do I capture the Rich table output for a log file?",
          "acceptedAnswer": {"@type": "Answer", "text": "Instantiate Console with record=True and force_terminal=True, then call console.export_text() after printing. This captures the rendered table without ANSI codes, suitable for structured log aggregation."}
        }
      ]
    }
  ]
}
</script>

Use `add_column()` with explicit `width`, `max_width`, and `overflow` constraints and delegate CRS parsing to `pyproj.CRS.from_user_input()`. Without those column constraints a Rich table collapses or overflows when EPSG names, WKT strings, or four-decimal bounding-box values hit a narrow CI terminal. This task is a focused extension of the broader [Rich Console Output & Progress Bars](/cli-architecture-design-patterns/rich-console-output-progress-bars/) pattern, which sits within the [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) guide.

## Prerequisites

```
pip install "rich>=13.0.0" "pyproj>=3.4"
```

Python 3.9 or later is required for the `list[str]` type hint syntax used below. No other geospatial stack dependencies are needed for the table renderer itself; `pyproj` alone handles CRS resolution.

## Architecture: How the Renderer Fits Together

The diagram below shows how input strings flow through `pyproj`, get formatted into row data, and are consumed by the Rich table renderer before reaching the terminal.

<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Data flow from CRS input strings through pyproj resolution to Rich table output" style="width:100%;max-width:640px;display:block;margin:1.5rem auto;">
  <title>CRS table rendering pipeline</title>
  <desc>Diagram showing CRS input strings entering pyproj.CRS.from_user_input, which extracts EPSG code, type name, and area-of-use bounds, then passes formatted row data to the Rich Table renderer, which outputs a constrained table to the terminal.</desc>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor" opacity="0.6"/>
    </marker>
  </defs>
  <!-- Boxes -->
  <rect x="10" y="80" width="130" height="60" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="75" y="106" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">CRS input strings</text>
  <text x="75" y="122" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">[&quot;EPSG:4326&quot;, ...]</text>
  <rect x="200" y="60" width="150" height="100" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="275" y="90" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">pyproj.CRS</text>
  <text x="275" y="108" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">.from_user_input()</text>
  <text x="275" y="124" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">→ epsg, name,</text>
  <text x="275" y="140" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">type_name, bounds</text>
  <rect x="410" y="60" width="140" height="100" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>
  <text x="480" y="90" text-anchor="middle" font-size="12" fill="currentColor" font-family="monospace">Rich Table</text>
  <text x="480" y="108" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">add_column()</text>
  <text x="480" y="124" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">max_width, overflow</text>
  <text x="480" y="140" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">add_row()</text>
  <!-- Terminal box -->
  <rect x="200" y="185" width="240" height="30" rx="4" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="320" y="204" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">Terminal / Console(record=True)</text>
  <!-- Arrows -->
  <line x1="140" y1="110" x2="198" y2="110" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="350" y1="110" x2="408" y2="110" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="480" y1="160" x2="480" y2="178" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <line x1="480" y1="178" x2="442" y2="185" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" marker-end="url(#arr)"/>
</svg>

## Complete Working Implementation

The function below is self-contained: copy it into any CLI module, pass a list of CRS strings (EPSG codes, PROJ strings, or WKT), and print the returned `Table` object.

```python
import sys
from typing import Optional
from rich.console import Console
from rich.table import Table
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError


def build_crs_table(
    crs_inputs: list[str],
    console: Optional[Console] = None,
) -> Table:
    """Return a Rich Table summarising each CRS in crs_inputs."""
    console = console or Console()

    table = Table(
        title="Coordinate System Registry",
        caption="Batch validation | PROJ >= 8.0",
        show_header=True,
        header_style="bold cyan",
        border_style="dim",
        padding=(0, 2),
        show_lines=True,
    )

    # --- Column definitions -------------------------------------------------
    # width/max_width prevents expansion; overflow controls truncation style.
    table.add_column("ID",   justify="right",  style="dim",         width=4)
    table.add_column("EPSG", justify="center", style="bold yellow",  width=8)
    table.add_column("Name",                   style="white",        overflow="fold", max_width=28)
    table.add_column("Type", justify="center",                       width=14)
    table.add_column("Bounds (W,S,E,N)",       style="blue",         overflow="ellipsis", max_width=32)
    table.add_column("Valid", justify="center",                      width=7)

    for idx, raw in enumerate(crs_inputs, start=1):
        try:
            crs = CRS.from_user_input(raw)          # 1
            epsg = str(crs.to_epsg() or "CUSTOM")   # 2

            bounds_str = "N/A"
            if crs.area_of_use and crs.area_of_use.bounds:
                w, s, e, n = crs.area_of_use.bounds
                bounds_str = f"{w:.2f}, {s:.2f}, {e:.2f}, {n:.2f}"

            crs_type = crs.type_name                # 3
            status = "[green]YES[/]" if crs.is_valid else "[red]NO[/]"

            # Conditional markup: geographic CRS gets cyan, projected gets yellow
            if "Geographic" in crs_type:
                type_markup = f"[cyan]{crs_type}[/]"
            elif "Projected" in crs_type:
                type_markup = f"[yellow]{crs_type}[/]"
            else:
                type_markup = crs_type

            table.add_row(str(idx), epsg, crs.name, type_markup, bounds_str, status)

        except CRSError:
            truncated = raw[:24] + ("…" if len(raw) > 24 else "")
            table.add_row(str(idx), "—", truncated, "[red]ERROR[/]", "—", "[red]NO[/]")

    return table


if __name__ == "__main__":
    samples = ["EPSG:4326", "EPSG:3857", "EPSG:32633", "EPSG:27700", "INVALID"]
    con = Console()
    con.print(build_crs_table(samples, con))
```

## Step Annotations

1. **`CRS.from_user_input(raw)`** accepts EPSG authority strings (`"EPSG:4326"`), PROJ4 strings, WKT, and integer authority codes interchangeably. Passing raw user input directly through this method avoids manual string splitting and handles deprecated EPSG codes by resolving them to their canonical replacement.

2. **`crs.to_epsg() or "CUSTOM"`** returns `None` for CRS objects that have no registered EPSG mapping (compound CRS, custom projections). The `or "CUSTOM"` guard prevents a `None` value from breaking the column layout. If your pipeline uses authority codes beyond EPSG, replace `"CUSTOM"` with a call to `crs.to_authority()` which returns `(authority, code)` for any registered database entry.

3. **`crs.type_name`** returns a human-readable string such as `"Geographic 2D CRS"` or `"Projected CRS"`. The conditional markup block applies consistent colour coding: cyan for geographic, yellow for projected, plain text for compound or vertical CRS types. This visual distinction matters when validating mixed input batches where a single projected-CRS slip can corrupt a downstream transformation.

4. **`overflow="fold"` on the Name column** wraps long CRS names (e.g. `"WGS 84 / UTM zone 33N"`) across multiple lines within the cell rather than truncating them. Preserve this for names because truncation silently hides disambiguation information between similarly-named projections. Use `overflow="ellipsis"` only on the Bounds column where exact decimal precision is not needed at a glance.

5. **`width=` vs `max_width=`** serve different purposes. `width` fixes the column at an exact character count; Rich will not expand or shrink it. `max_width` sets a ceiling but lets the column compress below it when the terminal is narrow. Use `width` for short fixed-format columns (ID, EPSG, Valid) and `max_width` for variable-length prose columns.

## Precomputing Coordinate Transformations Before Rendering

When the table needs to include transformed coordinates alongside metadata, precompute with `pyproj.Transformer` before building the table. Never run heavy math inside the `add_row` loop: Rich renders the table synchronously and any blocking computation delays the entire frame.

```python
from pyproj import Transformer

# Precompute: transform lon/lat pairs to Web Mercator before rendering
transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
lon_lat_pairs = [(-122.4194, 37.7749), (-74.0060, 40.7128), (2.3522, 48.8566)]

# Build formatted strings outside the table loop
easting_northing = [
    f"{x:,.0f}, {y:,.0f}"
    for x, y in (transformer.transform(lon, lat) for lon, lat in lon_lat_pairs)
]
# easting_northing is now a plain list[str]; pass elements to add_row() directly
```

`always_xy=True` enforces longitude-first, latitude-second axis order regardless of what the source CRS declares. Without it, EPSG:4326 gives latitude-first results that silently corrupt displayed coordinates.

## Named Gotcha: `None` Return from `to_epsg()` Breaks Column Alignment

`CRS.to_epsg()` returns `None` — not `"None"` — for any CRS without a registered EPSG code. Passing `None` directly to `table.add_row()` raises `TypeError` inside Rich's markup renderer. The fix shown above uses `str(crs.to_epsg() or "CUSTOM")`, converting the value to a string before it reaches the table. If you later sort or filter rows by EPSG code, keep the `None` check in your business logic separately so the rendering path always receives a `str`.

## Verification Snippet

After running the script, confirm the table structure matches expectations with a `Console(record=True)` capture:

```python
from rich.console import Console
from rich.table import Table  # noqa: F401 — imported via build_crs_table

con = Console(record=True, force_terminal=True, width=120)
tbl = build_crs_table(["EPSG:4326", "EPSG:3857", "INVALID"], con)
con.print(tbl)

captured = con.export_text()

# Structural assertions
assert "EPSG:4326" in captured or "4326" in captured, "WGS 84 row missing"
assert "3857" in captured, "Web Mercator row missing"
assert "ERROR" in captured, "Invalid CRS row missing"

row_count = sum(1 for line in captured.splitlines() if "│" in line and "EPSG" not in line)
assert row_count == 3, f"Expected 3 data rows, got {row_count}"
print("Verification passed.")
```

Run it with `python -c "exec(open('verify_table.py').read())"` or include it in your test suite. The `force_terminal=True` flag ensures Rich renders full ANSI output even when the process has no attached TTY, which is the normal state in CI runners. The `export_text()` call strips ANSI codes, leaving plain text that string assertions can operate on reliably.

<details class="faq-item">
<summary><span>Why does Rich ignore my <code>max_width</code> setting?</span></summary>

Rich only respects `max_width` if the column also has `no_wrap=False` (the default). If you explicitly set `no_wrap=True`, Rich ignores `max_width` and renders the full string on a single line, which can overflow. Remove `no_wrap=True` and rely on `overflow="ellipsis"` or `overflow="fold"` instead.

</details>

<details class="faq-item">
<summary>How do I render the table to a plain-text log file without ANSI codes?</summary>

Instantiate `Console(record=True, force_terminal=True)`, print the table, then call `console.export_text(clear=True)`. Write the returned string to your log file. The `clear=True` argument resets the internal buffer so subsequent calls to `export_text()` do not re-include earlier output.

</details>

<details class="faq-item">
<summary>Can I add a footer row with totals or summary counts?</summary>

Rich's `Table` does not have a built-in footer row concept. The closest approach is to call `table.add_section()` before the last row to draw a horizontal separator, then add a final row with summary cells formatted in a distinct style (e.g. `"[bold]3 valid / 1 error[/]"`). Alternatively, use the `caption` parameter on the table constructor for a plain-text footer below the border.

</details>

---

## Related

- [Rich Console Output & Progress Bars](/cli-architecture-design-patterns/rich-console-output-progress-bars/) — the parent guide covering `Console` initialization, progress bar integration, and theme configuration for geospatial batch workflows.
- [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) — the top-level reference for structuring Python GIS command-line tools with subcommands, config layering, and structured logging.
- [Argument Parsing with Typer](/cli-architecture-design-patterns/argument-parsing-with-typer/) — covers type-safe CLI option definitions that feed directly into the CRS input validation pattern shown above.
