# Customizing Rich tables for coordinate system outputs

Customizing Rich tables for coordinate system outputs requires explicit column constraints, conditional styling, and authoritative CRS resolution via `pyproj`. Geospatial metadata—EPSG codes, WKT strings, bounding boxes, and transformation accuracy—frequently exceeds standard terminal widths. By combining `rich.table.Table` with dynamic truncation and theme-aware formatting, you can render machine-readable, human-friendly output that survives batch processing and CI/CD pipelines. This approach aligns with modern [CLI Architecture & Design Patterns](/cli-architecture-design-patterns/) where console output must balance readability with strict layout boundaries.

## Core Configuration Principles

- **Explicit Column Definitions:** Use `add_column()` with `width`, `max_width`, `justify`, and `overflow` to prevent layout collapse when rendering long WKT strings or high-precision coordinates.
- **Conditional Styling:** Apply `style` and inline markup to differentiate projection types (e.g., `bold green` for geographic, `bold yellow` for projected).
- **Authoritative Resolution:** Delegate CRS parsing to `pyproj.CRS` rather than manual string splitting. This ensures compliance with the [PROJ library](https://proj.org/en/9.3/) standards and handles deprecated EPSG codes gracefully.
- **Terminal Safety:** Enforce `overflow="ellipsis"` or `overflow="fold"` for variable-length fields. Rich automatically respects `COLUMNS` environment variables, but explicit `max_width` guarantees consistent behavior across narrow CI runners.

## Production-Ready Implementation

The following builder validates inputs, extracts spatial metadata, and formats outputs for terminal consumption. It integrates seamlessly with [Rich Console Output & Progress Bars](/cli-architecture-design-patterns/rich-console-output-progress-bars/) when processing large shapefiles or GeoJSON batches.

```python
import sys
from typing import List, Optional
from rich.console import Console
from rich.table import Table
from pyproj import CRS
from pyproj.exceptions import CRSError

def build_crs_table(
    crs_inputs: List[str], 
    console: Optional[Console] = None
) -> Table:
    console = console or Console()
    
    table = Table(
        title="Coordinate System Registry",
        caption="Batch validation output | PROJ >= 8.0",
        show_header=True,
        header_style="bold cyan",
        border_style="dim",
        collapse_padding=False,
        padding=(0, 2),
        show_lines=True
    )

    # Explicit column definitions for coordinate system outputs
    table.add_column("ID", justify="right", style="dim", width=4)
    table.add_column("EPSG", justify="center", style="bold yellow", width=8)
    table.add_column("Name", style="white", overflow="fold", max_width=28)
    table.add_column("Type", justify="center", width=14)
    table.add_column("Bounds (W,S,E,N)", justify="left", style="blue", overflow="ellipsis", max_width=32)
    table.add_column("Status", justify="center", width=10)

    for idx, crs_input in enumerate(crs_inputs, start=1):
        try:
            crs = CRS.from_user_input(crs_input)
            epsg = str(crs.to_epsg()) if crs.to_epsg() else "CUSTOM"
            name = crs.name
            crs_type = crs.type_name
            
            if crs.area_of_use and crs.area_of_use.bounds:
                w, s, e, n = crs.area_of_use.bounds
                bounds_str = f"{w:.2f}, {s:.2f}, {e:.2f}, {n:.2f}"
            else:
                bounds_str = "N/A"

            # Conditional styling based on CRS validity
            status_style = "green" if crs.is_valid else "red"
            status = "VALID" if crs.is_valid else "INVALID"

            table.add_row(
                str(idx),
                epsg,
                name,
                crs_type,
                bounds_str,
                f"[{status_style}]{status}[/]"
            )
        except CRSError as e:
            table.add_row(
                str(idx),
                "—",
                crs_input[:25] + ("…" if len(crs_input) > 25 else ""),
                "ERROR",
                "—",
                "[red]FAIL[/]"
            )

    return table

if __name__ == "__main__":
    sample_inputs = ["EPSG:4326", "EPSG:3857", "EPSG:32633", "INVALID:CRS"]
    console = Console()
    console.print(build_crs_table(sample_inputs, console))
```

## Parameter Deep Dive

Rich's table engine prioritizes developer control over automatic layout guessing. Understanding these parameters prevents common terminal rendering failures:

- `overflow="fold"` vs `overflow="ellipsis"`: Use `fold` for WKT/PROJ strings that must remain copy-pasteable. Use `ellipsis` for bounding boxes where exact precision isn't critical for quick scanning.
- `max_width`: Hard-limits column expansion. Rich respects this even when `expand=True` is set on the table, preventing horizontal scrollbars in constrained environments.
- `justify`: Aligns numeric/coordinate data consistently. Right-aligning IDs and center-aligning EPSG codes improves vertical scanning speed during log reviews.
- `show_lines=True`: Adds horizontal dividers between rows, critical when batch outputs exceed 50+ entries and terminal wrapping occurs.

## Coordinate Transformation & Array Handling

When your pipeline requires coordinate transformation alongside metadata display, instantiate `pyproj.Transformer` before rendering. Avoid transforming inside the table loop; instead, precompute arrays and pass them as formatted strings. Rich handles tabular data efficiently, but heavy mathematical operations will block I/O if executed synchronously during rendering.

```python
from pyproj import Transformer

# Precompute transformations
transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
coords_lon_lat = [(-122.4194, 37.7749), (-74.0060, 40.7128)]
coords_easting_northing = [transformer.transform(lon, lat) for lon, lat in coords_lon_lat]

# Format for table insertion
formatted_coords = [f"{x:.2f}, {y:.2f}" for x, y in coords_easting_northing]
```

For large datasets, pair the table builder with a progress tracker to prevent blocking I/O. Always sanitize user-provided CRS strings before passing them to `CRS.from_user_input()` to prevent parsing errors that cascade into malformed table rows.

## Pipeline Integration & Performance

When embedding this into automated workflows, avoid printing directly to `sys.stdout`. Instead, pass a configured `Console` instance with `force_terminal=True` and `record=True` to capture output for log aggregation. Coordinate validation should run early in the ETL pipeline. If `pyproj` returns `CRSError`, fail fast or route to a fallback resolver.

The Rich table renderer handles Unicode gracefully, but ensure your deployment environment uses UTF-8 encoding. For advanced theming, consult the official [Rich Tables documentation](https://rich.readthedocs.io/en/stable/tables.html) to override default borders or integrate with your organization's CLI design system. Properly structured console output reduces debugging time, standardizes geospatial validation across teams, and keeps terminal logs actionable during long-running batch operations.