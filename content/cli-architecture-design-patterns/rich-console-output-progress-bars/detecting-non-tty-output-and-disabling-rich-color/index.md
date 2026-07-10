---
title: "Detecting Non-TTY Output and Disabling Rich Color"
description: "Detect when a geospatial CLI's stdout is piped or running in CI and switch Rich to plain, ANSI-free output so log files and CI consoles stay clean."
slug: "detecting-non-tty-output-and-disabling-rich-color"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Rich Console Output & Progress Bars for GIS CLIs"
    url: "/cli-architecture-design-patterns/rich-console-output-progress-bars/"
  - label: "Detecting Non-TTY Output and Disabling Rich Color"
    url: "/cli-architecture-design-patterns/rich-console-output-progress-bars/detecting-non-tty-output-and-disabling-rich-color/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Detecting Non-TTY Output and Disabling Rich Color",
      "description": "Detect when a geospatial CLI's stdout is piped or running in CI and switch Rich to plain, ANSI-free output so log files and CI consoles stay clean.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Rich Console Output & Progress Bars for GIS CLIs", "item": "https://batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/"},
        {"@type": "ListItem", "position": 3, "name": "Detecting Non-TTY Output and Disabling Rich Color", "item": "https://batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/detecting-non-tty-output-and-disabling-rich-color/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Detect Non-TTY Output and Disable Rich Color",
      "step": [
        {"@type": "HowToStep", "name": "Inspect stdout", "text": "Call sys.stdout.isatty() to decide whether the destination is an interactive terminal or a pipe, file, or CI log."},
        {"@type": "HowToStep", "name": "Honour environment overrides", "text": "Check the NO_COLOR and CI environment variables so users and pipelines can force plain output regardless of the TTY state."},
        {"@type": "HowToStep", "name": "Construct the console", "text": "Build rich.console.Console with force_terminal and no_color set from the detection result, routing logs to stderr."},
        {"@type": "HowToStep", "name": "Degrade the progress bar", "text": "Disable the live Rich Progress in non-TTY mode and emit periodic plain percentage lines instead."},
        {"@type": "HowToStep", "name": "Verify", "text": "Run the tool piped through cat and confirm no ANSI escape codes appear in the captured output."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does Rich still emit color when I redirect output to a file?",
          "acceptedAnswer": {"@type": "Answer", "text": "Rich only auto-detects a non-terminal on the stream it was constructed with. If you build one global Console bound to stdout but write logs elsewhere, or if force_terminal was set anywhere, detection is bypassed. Build the Console from an explicit isatty() check and leave force_terminal as None unless you deliberately want to override it."}
        },
        {
          "@type": "Question",
          "name": "What is the difference between NO_COLOR and forcing a plain terminal?",
          "acceptedAnswer": {"@type": "Answer", "text": "NO_COLOR strips ANSI color and style but keeps Rich's layout features such as progress bars and tables in a terminal. A plain, non-TTY console disables color and also drops live-updating widgets because a pipe cannot process carriage returns. For clean log files you want the fully plain path, not just NO_COLOR."}
        },
        {
          "@type": "Question",
          "name": "How do I keep the progress bar off log files but on for interactive users?",
          "acceptedAnswer": {"@type": "Answer", "text": "Gate the Rich Progress instance on the same TTY detection used for the console. When stdout is not a terminal, skip the live Progress and log a plain percentage line every N items or every few seconds instead, so CI logs show measurable advancement without carriage-return spam."}
        },
        {
          "@type": "Question",
          "name": "Should logs go to stdout or stderr?",
          "acceptedAnswer": {"@type": "Answer", "text": "Send machine-consumable results to stdout and human-facing logs and progress to stderr via Console(stderr=True). This lets a user run the tool and pipe stdout to jq or a file while still seeing progress on the terminal, and it prevents progress redraws from corrupting a structured JSON payload."}
        }
      ]
    }
  ]
}
</script>

# Detecting Non-TTY Output and Disabling Rich Color

Decide Rich's output mode from `sys.stdout.isatty()` plus the `NO_COLOR` and `CI` environment variables, then build `rich.console.Console` with `force_terminal` and `no_color` set accordingly. When the destination is a pipe, a redirected file, or a CI runner, return a plain console with color disabled and skip the live progress bar; when it is an interactive terminal, return the full styled console. This page is part of the [Rich Console Output & Progress Bars for GIS CLIs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/) guide within the broader [CLI Architecture & Design Patterns for Python GIS](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install rich` (Rich 13.0+)
- A GDAL-backed toolchain for the raster examples (`pip install rasterio`), though the detection logic itself has no geospatial dependency

If your tool already reads settings from the shell, pair this with [Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/) so `NO_COLOR` and `CI` are resolved through the same layered configuration as everything else.

## How the Decision Is Made

The core question is a single boolean: is the current `stdout` an interactive terminal, or is it a pipe, a file, or a CI log? Rich answers this on its own most of the time, but a robust CLI makes the decision explicit so it can also disable progress widgets and route logs to the right stream. The diagram below shows the three inputs that feed the decision and the two console shapes that come out.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision flow: isatty, NO_COLOR, and CI environment variables feed a make_console helper that returns either a rich interactive console or a plain ANSI-free console" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>make_console decision flow</title>
  <desc>Three input checks — sys.stdout.isatty, the NO_COLOR variable, and the CI variable — feed into a make_console helper. If any forces plain output, the helper returns a plain, no-color console with progress disabled. Otherwise it returns a full rich console with a live progress bar.</desc>
  <!-- Input nodes -->
  <rect x="20" y="30" width="180" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="110" y="52" text-anchor="middle" font-size="12" fill="currentColor">sys.stdout.isatty()</text>
  <text x="110" y="68" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">terminal or pipe?</text>
  <rect x="20" y="96" width="180" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="110" y="118" text-anchor="middle" font-size="12" fill="currentColor">NO_COLOR env var</text>
  <text x="110" y="134" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">user opt-out</text>
  <rect x="20" y="162" width="180" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="110" y="184" text-anchor="middle" font-size="12" fill="currentColor">CI env var</text>
  <text x="110" y="200" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">pipeline runner</text>
  <!-- Arrows to helper -->
  <line x1="200" y1="53" x2="292" y2="110" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a2)"/>
  <line x1="200" y1="119" x2="292" y2="119" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a2)"/>
  <line x1="200" y1="185" x2="292" y2="128" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a2)"/>
  <!-- Helper node -->
  <rect x="295" y="92" width="130" height="54" rx="6" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.7" stroke-width="1.4"/>
  <text x="360" y="116" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">make_console()</text>
  <text x="360" y="133" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">picks the mode</text>
  <!-- Output arrows -->
  <line x1="425" y1="107" x2="512" y2="70" stroke="#27ae60" stroke-opacity="0.6" stroke-width="1.4" marker-end="url(#a2)"/>
  <line x1="425" y1="131" x2="512" y2="234" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.4" marker-end="url(#a2)"/>
  <!-- Output: rich -->
  <rect x="515" y="40" width="185" height="66" rx="6" fill="#27ae60" fill-opacity="0.08" stroke="#27ae60" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="607" y="62" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">interactive console</text>
  <text x="607" y="80" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">color on, live progress</text>
  <text x="607" y="95" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">stderr for logs</text>
  <!-- Output: plain -->
  <rect x="515" y="210" width="185" height="66" rx="6" fill="#c0392b" fill-opacity="0.07" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.3"/>
  <text x="607" y="232" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">plain console</text>
  <text x="607" y="250" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">no_color, ANSI-free</text>
  <text x="607" y="265" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">plain percentage lines</text>
  <!-- Rule caption -->
  <text x="360" y="300" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.8">Any of: not a TTY, NO_COLOR set, or CI set to a truthy value forces the plain path.</text>
  <defs>
    <marker id="a2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
</svg>

## Complete Working Implementation

The module below exposes a single `make_console()` helper plus a `batch_progress()` context manager that renders a live bar on a terminal and periodic plain lines everywhere else. It processes a directory of GeoTIFFs (reprojecting each to a target CRS) purely to give the progress reporting something real to track. Copy it, adjust the paths, and run it both directly and piped:

```python
#!/usr/bin/env python3
"""
Console/output-mode detection for a Rich-based geospatial CLI.

Usage:
    python clean_output.py ./input --crs EPSG:3857        # interactive
    python clean_output.py ./input --crs EPSG:3857 | cat   # plain, no ANSI
"""
import os
import sys
import time
import argparse
from pathlib import Path
from contextlib import contextmanager

from rich.console import Console
from rich.progress import Progress, BarColumn, TimeRemainingColumn
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling


def _truthy(name: str) -> bool:
    """A variable counts as 'set' if it exists and is not an explicit off value."""
    value = os.environ.get(name)
    if value is None:
        return False
    return value.strip().lower() not in {"", "0", "false", "no"}


def is_interactive(stream=sys.stdout) -> bool:
    """Return True only when the stream is a real terminal AND nothing forces plain.

    NO_COLOR (https://no-color.org) and CI take precedence over TTY detection:
    a developer may run interactively but still want machine-clean output.
    """
    if _truthy("NO_COLOR"):
        return False
    if _truthy("CI"):
        return False
    # isatty() may be absent on some wrapped streams (e.g. pytest capture).
    return bool(getattr(stream, "isatty", lambda: False)())


def make_console(stderr: bool = True) -> Console:
    """Build a Console tuned for the current output destination.

    - Interactive terminal: full color, Rich picks the true width.
    - Piped / redirected / CI: no_color=True and force_terminal=False so
      absolutely no ANSI escape codes reach the pipe.

    Logs go to stderr by default so stdout stays a clean data channel.
    """
    interactive = is_interactive(sys.stdout)
    return Console(
        stderr=stderr,
        # force_terminal=False hard-disables ANSI; None would let Rich guess.
        force_terminal=False if not interactive else None,
        no_color=not interactive,
        # A fixed width keeps wrapped log lines reproducible in CI artifacts.
        width=None if interactive else 100,
        highlight=interactive,
    )


@contextmanager
def batch_progress(console: Console, total: int, label: str):
    """Live Rich bar when interactive; periodic plain log lines otherwise."""
    if is_interactive(sys.stdout):
        with Progress(
            "[progress.description]{task.description}",
            BarColumn(),
            "[progress.percentage]{task.percentage:>3.0f}%",
            TimeRemainingColumn(),
            console=console,
        ) as progress:
            task = progress.add_task(label, total=total)
            yield lambda: progress.advance(task)
    else:
        # Plain mode: no carriage returns, just a line every 10% or 5 seconds.
        state = {"done": 0, "last": time.monotonic()}

        def advance():
            state["done"] += 1
            now = time.monotonic()
            step = max(1, total // 10)
            if state["done"] % step == 0 or now - state["last"] >= 5:
                pct = 100 * state["done"] / total
                console.print(f"{label}: {state['done']}/{total} ({pct:.0f}%)")
                state["last"] = now

        yield advance
        console.print(f"{label}: {total}/{total} (100%) done")


def reproject_one(src_path: Path, dst_path: Path, target_crs: str) -> None:
    with rasterio.open(src_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, target_crs, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(crs=target_crs, transform=transform, width=width, height=height)
        with rasterio.open(dst_path, "w", **profile) as dst:
            for band in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band),
                    destination=rasterio.band(dst, band),
                    src_crs=src.crs,
                    dst_crs=target_crs,
                    resampling=Resampling.bilinear,
                )


def main() -> int:
    parser = argparse.ArgumentParser(description="Reproject a folder of GeoTIFFs")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--crs", default="EPSG:4326", help="Target CRS, e.g. EPSG:3857")
    parser.add_argument("--out", type=Path, default=Path("./out"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    console = make_console(stderr=True)          # logs/progress -> stderr
    result = Console()                           # data payload   -> stdout

    sources = sorted(args.input_dir.glob("*.tif"))
    if not sources:
        console.print("[yellow]No .tif files found[/]")
        return 2

    console.print(f"Reprojecting {len(sources)} rasters to {args.crs}")
    ok = 0
    with batch_progress(console, len(sources), "warp") as advance:
        for src in sources:
            dst = args.out / f"{src.stem}_{args.crs.replace(':', '_')}.tif"
            try:
                reproject_one(src, dst, args.crs)
                ok += 1
            except Exception as exc:                       # noqa: BLE001
                console.print(f"[red]FAIL[/] {src.name}: {exc}")
            advance()

    # Machine-readable summary on stdout, never styled.
    result.print(f"{ok} {len(sources)}")
    return 0 if ok == len(sources) else 12


if __name__ == "__main__":
    sys.exit(main())
```

## Step Annotations

1. **`_truthy()` for env vars** — `NO_COLOR` follows the [no-color.org](https://no-color.org) convention where mere presence disables color, but treating an explicit `NO_COLOR=0` as "off" is friendlier for users who export it globally. The same helper handles `CI`, which most runners set to `true`.

2. **`is_interactive()` order of checks** — Environment overrides are evaluated *before* `isatty()`. A developer running locally can still force clean output with `NO_COLOR=1 mytool ...`, and a CI job gets plain output even though some runners allocate a pseudo-TTY that would otherwise pass `isatty()`.

3. **`getattr(stream, "isatty", lambda: False)`** — Wrapped streams (pytest's capture buffer, some logging handlers) do not always implement `isatty()`. Guarding the attribute access prevents an `AttributeError` from crashing the CLI under test.

4. **`force_terminal=False` versus `None`** — Passing `False` hard-disables ANSI; passing `None` lets Rich re-run its own detection, which can disagree with yours. Because the plain path must guarantee zero escape codes, it uses the explicit `False`.

5. **`width=100` in plain mode** — Rich normally probes terminal width, which is undefined on a pipe and defaults to 80. Pinning it keeps wrapped log lines byte-for-byte reproducible across local runs and CI artifacts.

6. **Two consoles, two streams** — `console` targets stderr for human logs and progress; `result` targets stdout for the machine summary. This is what lets `mytool ... > data.txt` capture only the payload while progress still reaches the terminal, and it dovetails with the structured logs described in [Error Handling in Spatial Pipelines](https://www.batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/).

7. **`batch_progress()` degradation** — In plain mode there is no live bar; the closure prints one line per 10% or every five seconds. CI logs then show real advancement without thousands of carriage-return redraws, and exit code `12` still signals a partial batch failure.

## Named Gotcha: `| tee`, `nohup`, and pytest Fool Auto-Detection

Rich's built-in detection is correct for a plain `mytool > file.txt`, but three common wrappers defeat it. Running under `nohup` or inside some CI runners can allocate a pseudo-terminal, so `isatty()` returns `True` and Rich happily writes ANSI codes into what is actually a log file. Piping through `tee` (`mytool | tee run.log`) sends output to both a terminal and a file, and if you forced a terminal anywhere those escape codes land in `run.log`. Under pytest, the capture fixture replaces `sys.stdout` with an object that may or may not implement `isatty()`.

The worst version of this corrupts a structured log: if any part of the payload on stdout carries `\x1b[32m` sequences, a downstream `json.loads()` throws `json.decoder.JSONDecodeError` on the first byte. The fix is the design above — never call `force_terminal=True`, always route color-bearing output to stderr, and keep the machine payload on a separate unstyled console. When you must override detection for a genuinely non-TTY terminal (a Docker `-t` shell), expose an explicit `--color/--no-color` flag rather than guessing.

## Verification

Prove that piped output contains no escape codes. The `cat -v` view and a grep for the escape byte are the fastest checks:

```bash
# 1. Piped through cat: there must be NO ^[[ sequences in the output.
python clean_output.py ./input --crs EPSG:3857 | cat -v

# 2. Grep for the raw ESC byte (0x1b). Zero matches = clean.
python clean_output.py ./input --crs EPSG:3857 2>&1 | grep -c $'\x1b\['
# expected: 0

# 3. CI simulation: force the plain path even in an interactive shell.
CI=true python clean_output.py ./input --crs EPSG:3857 | cat -v

# 4. Confirm the machine payload on stdout is unstyled and parseable.
python clean_output.py ./input --crs EPSG:3857 2>/dev/null
# expected: two integers, e.g. "12 12", with no color
```

A zero count from step 2 and clean integers from step 4 confirm that both the log stream and the data stream stay ANSI-free when redirected.

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| ANSI codes in a redirected log file | `force_terminal=True` set somewhere | Remove it; let `no_color` follow `isatty()` |
| Color still shows under `nohup` / Docker `-t` | Pseudo-TTY makes `isatty()` return `True` | Add an explicit `--no-color` flag and honour `NO_COLOR` |
| `JSONDecodeError` on captured stdout | Styled bytes mixed into the data payload | Route logs to `Console(stderr=True)`, payload to a plain console |
| Progress bar spams `\r` in CI logs | Live `Progress` used in non-TTY mode | Gate `Progress` on `is_interactive()` and print plain lines |
| `AttributeError: isatty` under pytest | Capture stream lacks `isatty()` | Guard with `getattr(stream, "isatty", lambda: False)` |

## FAQ

<details class="faq-item">
<summary>Why does Rich still emit color when I redirect output to a file?</summary>

Rich only auto-detects a non-terminal on the stream it was constructed with. If you build one global `Console` bound to stdout but write logs elsewhere, or if `force_terminal` was set anywhere, detection is bypassed. Build the `Console` from an explicit `isatty()` check and leave `force_terminal` as `None` unless you deliberately want to override it.
</details>

<details class="faq-item">
<summary>What is the difference between NO_COLOR and forcing a plain terminal?</summary>

`NO_COLOR` strips ANSI color and style but keeps Rich's layout features such as progress bars and tables in a terminal. A plain, non-TTY console disables color and also drops live-updating widgets because a pipe cannot process carriage returns. For clean log files you want the fully plain path, not just `NO_COLOR`.
</details>

<details class="faq-item">
<summary>How do I keep the progress bar off log files but on for interactive users?</summary>

Gate the Rich `Progress` instance on the same TTY detection used for the console. When stdout is not a terminal, skip the live `Progress` and log a plain percentage line every N items or every few seconds instead, so CI logs show measurable advancement without carriage-return spam.
</details>

<details class="faq-item">
<summary>Should logs go to stdout or stderr?</summary>

Send machine-consumable results to stdout and human-facing logs and progress to stderr via `Console(stderr=True)`. This lets a user run the tool and pipe stdout to `jq` or a file while still seeing progress on the terminal, and it prevents progress redraws from corrupting a structured JSON payload.
</details>

---

## Related

- [Rich Console Output & Progress Bars for GIS CLIs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/) — parent guide covering styled tables, live displays, and progress reporting for geospatial command-line tools
- [Rendering a Live Rich Dashboard for Batch Raster Jobs](https://www.batch-processing.com/cli-architecture-design-patterns/rich-console-output-progress-bars/rendering-a-live-rich-dashboard-for-batch-raster-jobs/) — the interactive counterpart, showing when a live dashboard is worth the terminal-only complexity
