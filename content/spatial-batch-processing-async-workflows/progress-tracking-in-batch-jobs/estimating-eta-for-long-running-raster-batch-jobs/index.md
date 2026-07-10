---
title: "Estimating ETA for Long-Running Raster Batch Jobs"
description: "Compute a stable ETA for a raster batch job from a rolling throughput average and surface it through a Rich progress bar and structured logs."
slug: "estimating-eta-for-long-running-raster-batch-jobs"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Progress Tracking for Python GIS Batch Pipelines"
    url: "/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/"
  - label: "Estimating ETA for Long-Running Raster Batch Jobs"
    url: "/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/estimating-eta-for-long-running-raster-batch-jobs/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Estimating ETA for Long-Running Raster Batch Jobs",
      "description": "Compute a stable ETA for a raster batch job from a rolling throughput average and surface it through a Rich progress bar and structured logs.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Progress Tracking for Python GIS Batch Pipelines", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/"},
        {"@type": "ListItem", "position": 3, "name": "Estimating ETA for Long-Running Raster Batch Jobs", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/estimating-eta-for-long-running-raster-batch-jobs/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Estimate ETA for a Long-Running Raster Batch Job",
      "step": [
        {"@type": "HowToStep", "name": "Record per-tile durations", "text": "Time each finished tile with time.monotonic() and push the elapsed seconds into a bounded collections.deque."},
        {"@type": "HowToStep", "name": "Compute exponentially-weighted throughput", "text": "Blend recent per-tile durations with an exponential weight so newer tiles influence the estimate more than stale ones."},
        {"@type": "HowToStep", "name": "Project remaining time", "text": "Divide remaining tiles by the smoothed throughput to get an ETA that ignores warm-up noise."},
        {"@type": "HowToStep", "name": "Render a Rich ETA column", "text": "Subclass a Rich ProgressColumn to display the smoothed ETA next to the raster progress bar."},
        {"@type": "HowToStep", "name": "Emit ETA to structured logs", "text": "Log the ETA seconds and throughput as JSON fields at a fixed interval so headless CI runs stay observable."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does the ETA from a naive total-average jump around so much?",
          "acceptedAnswer": {"@type": "Answer", "text": "A total-average ETA divides every remaining tile by the mean cost of all tiles seen so far, so a single large tile permanently drags the average up and a run of small tiles drags it down. Because early tiles keep influencing the mean forever, the projection lurches whenever tile cost changes. A rolling exponentially-weighted window forgets stale tiles, so the estimate tracks current conditions instead."}
        },
        {
          "@type": "Question",
          "name": "Should I weight throughput by tile count or by pixel count?",
          "acceptedAnswer": {"@type": "Answer", "text": "Weight by pixels whenever tile sizes vary widely. Counting tiles assumes every tile costs the same, so a batch that mixes 512-pixel and 8192-pixel tiles produces an ETA that swings with the luck of the draw. Tracking pixels per second and multiplying by remaining pixels gives a stable projection because it measures the work that actually varies."}
        },
        {
          "@type": "Question",
          "name": "Why use time.monotonic() instead of time.time() for ETA?",
          "acceptedAnswer": {"@type": "Answer", "text": "time.time() reads the wall clock, which can jump backwards or forwards when NTP corrects the system time or when daylight-saving changes apply. A backwards jump produces a negative tile duration and a nonsensical ETA. time.monotonic() only ever increases and is immune to clock adjustments, so it is the correct clock for measuring elapsed intervals."}
        },
        {
          "@type": "Question",
          "name": "How do I know the ETA is trustworthy?",
          "acceptedAnswer": {"@type": "Answer", "text": "Log the ETA at a fixed interval and check that its predicted finish time converges as the job proceeds. On a healthy run the predicted completion timestamp should stabilise within a few percent after the first window fills, and the final ETA should approach zero smoothly rather than snapping down at the end."}
        }
      ]
    }
  ]
}
</script>

# Estimating ETA for Long-Running Raster Batch Jobs

A trustworthy ETA for a raster batch comes from measuring recent throughput, not the whole-run average. Time each finished tile with `time.monotonic()`, push the duration into a bounded `collections.deque`, compute an exponentially-weighted tiles-per-second rate, and multiply the remaining tiles by that rate. This tracks current conditions instead of being anchored to warm-up tiles. This page is part of the [Progress Tracking for Python GIS Batch Pipelines](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) guide within the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install rich` for the progress bar and custom column
- `rasterio` (GDAL 3.4+) only for the worked example that iterates windows; the estimator itself has no geospatial dependency

The estimator is pure standard library plus Rich. For how the progress bar itself is wired into a CLI, see [Rich Console Output & Progress Bars for GIS CLIs](/cli-architecture-design-patterns/rich-console-output-progress-bars/). If your job can be interrupted and resumed, pair this with [Checkpointing for Interrupted Spatial Batch Jobs](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/) so the ETA restarts from the resumed position rather than from zero.

## Why the Naive Average Lurches

The obvious ETA is `elapsed / done * remaining`: total elapsed time divided by tiles completed, projected forward. It works only when every tile costs roughly the same. Raster batches rarely do — a scene of open ocean warps in a fraction of the time a dense urban DEM takes, and cloud-masked tiles skip most of their work.

With a total-average, every tile ever processed keeps voting on the estimate. Process 200 cheap tiles, then hit a block of expensive ones, and the average barely moves at first, so the ETA under-predicts badly; then it slowly climbs as the expensive tiles accumulate. The reverse happens when a slow warm-up gives way to fast tiles: the ETA stays pessimistically high for a long time. The estimate lags reality because it can never forget the past.

A rolling window fixes the memory problem. Keep only the last N tile durations, weight recent ones more heavily, and the throughput estimate reflects what the machine is doing *now*. The diagram below contrasts the two.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison of a naive total-average ETA that lurches when tile cost changes against a rolling exponentially-weighted window ETA that stays stable" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Naive total-average ETA versus rolling exponentially-weighted ETA</title>
  <desc>Two stacked panels. The top panel shows a naive total-average ETA line that spikes and dips sharply when a block of expensive tiles arrives. The bottom panel shows a rolling exponentially-weighted ETA that adjusts smoothly and converges toward the true finish.</desc>
  <!-- Top panel: naive -->
  <rect x="10" y="14" width="700" height="130" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="24" y="36" font-size="12" font-weight="600" fill="currentColor" opacity="0.9">Naive total-average ETA</text>
  <!-- baseline axis -->
  <line x1="40" y1="120" x2="690" y2="120" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"/>
  <!-- lurching line -->
  <polyline points="40,96 130,98 220,92 300,54 360,132 430,60 520,104 610,86 690,110" fill="none" stroke="#c0392b" stroke-opacity="0.8" stroke-width="2"/>
  <!-- expensive-block marker -->
  <rect x="300" y="46" width="70" height="70" fill="#c0392b" fill-opacity="0.08" stroke="none"/>
  <text x="335" y="140" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">expensive tiles arrive</text>
  <text x="668" y="100" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">lurches</text>
  <!-- Bottom panel: rolling -->
  <rect x="10" y="176" width="700" height="130" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.5"/>
  <text x="24" y="198" font-size="12" font-weight="600" fill="currentColor" opacity="0.9">Rolling exponentially-weighted ETA</text>
  <line x1="40" y1="282" x2="690" y2="282" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"/>
  <!-- smooth converging line -->
  <polyline points="40,236 130,240 220,244 300,238 360,250 430,254 520,262 610,270 690,278" fill="none" stroke="#15803d" stroke-opacity="0.85" stroke-width="2"/>
  <rect x="300" y="212" width="70" height="70" fill="#15803d" fill-opacity="0.06" stroke="none"/>
  <text x="335" y="302" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">same tile cost change</text>
  <text x="662" y="266" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">converges</text>
  <!-- shared x label -->
  <text x="360" y="316" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.55">tiles completed over time, ETA on vertical axis</text>
</svg>

## Complete Working Implementation

The estimator below tracks either tiles or pixels, applies an exponential weight to a bounded window, and plugs into a Rich `Progress` as a custom column. The example driver iterates a raster in windows so the per-tile cost genuinely varies with tile dimensions.

```python
#!/usr/bin/env python3
"""
Stable ETA for a raster batch using a rolling exponentially-weighted rate.
Usage: python raster_eta.py scene.tif --block 512
"""
import sys
import time
import math
import json
import logging
import argparse
from pathlib import Path
from collections import deque

import rasterio
from rasterio.windows import Window
from rich.progress import (
    Progress, ProgressColumn, BarColumn, TextColumn,
    TimeElapsedColumn, TaskProgressColumn,
)
from rich.text import Text

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
log = logging.getLogger("raster.eta")


class RollingEta:
    """Estimate remaining seconds from an exponentially-weighted rate.

    Each sample is (work_units, seconds) for one finished tile. `work_units`
    is a tile count (1 per tile) or a pixel count when tiles vary in size.
    Recent samples are weighted more heavily via an exponential decay, so
    the throughput estimate tracks current conditions instead of the whole
    run's average.
    """

    def __init__(self, total_units: int, window: int = 32, half_life: int = 12):
        self.total_units = total_units
        self.done_units = 0
        # bounded window: old samples fall out automatically
        self._durations: deque[float] = deque(maxlen=window)
        self._units: deque[float] = deque(maxlen=window)
        # decay per sample so a tile `half_life` samples old counts half as much
        self._decay = 0.5 ** (1.0 / half_life)
        self._start = time.monotonic()   # monotonic: immune to clock jumps
        self._last_tick = self._start

    def update(self, work_units: float) -> None:
        now = time.monotonic()
        elapsed = now - self._last_tick
        self._last_tick = now
        self._durations.append(elapsed)
        self._units.append(work_units)
        self.done_units += work_units

    def throughput(self) -> float:
        """Exponentially-weighted work units per second over the window."""
        if not self._durations:
            return 0.0
        weighted_units = 0.0
        weighted_time = 0.0
        weight = 1.0
        # walk newest -> oldest, shrinking the weight each step
        for units, secs in zip(reversed(self._units), reversed(self._durations)):
            weighted_units += weight * units
            weighted_time += weight * secs
            weight *= self._decay
        if weighted_time <= 0.0:
            return 0.0
        return weighted_units / weighted_time

    def eta_seconds(self) -> float | None:
        rate = self.throughput()
        if rate <= 0.0:
            return None                  # not enough signal yet
        remaining = max(self.total_units - self.done_units, 0)
        return remaining / rate


class RollingEtaColumn(ProgressColumn):
    """Render the RollingEta attached to a task's fields as 'eta 3m12s'."""

    def render(self, task) -> Text:
        estimator: RollingEta | None = task.fields.get("estimator")
        if estimator is None:
            return Text("eta --", style="dim")
        secs = estimator.eta_seconds()
        if secs is None:
            return Text("eta --", style="dim")
        m, s = divmod(int(secs), 60)
        return Text(f"eta {m:d}m{s:02d}s", style="cyan")


def tile_windows(width: int, height: int, block: int):
    """Yield (window, pixel_count) tiles; edge tiles are smaller on purpose."""
    for row in range(0, height, block):
        h = min(block, height - row)
        for col in range(0, width, block):
            w = min(block, width - col)
            yield Window(col, row, w, h), w * h


def process_tile(dataset, window: Window) -> None:
    """Stand-in for real work: read the block and touch every pixel.

    Cost scales with pixel count, so tiles legitimately differ in duration.
    Replace with a warp, resample, or index computation as needed.
    """
    band1 = dataset.read(1, window=window)
    _ = int(band1.sum())             # force materialisation of the read


def main() -> int:
    parser = argparse.ArgumentParser(description="Rolling-window ETA for a raster batch")
    parser.add_argument("raster", type=Path, help="Source raster (any GDAL format)")
    parser.add_argument("--block", type=int, default=512, help="Tile edge in pixels")
    parser.add_argument("--by-pixels", action="store_true",
                        help="Weight throughput by pixels instead of tile count")
    parser.add_argument("--log-every", type=float, default=5.0,
                        help="Structured ETA log interval in seconds")
    args = parser.parse_args()

    if not args.raster.exists():
        log.error(json.dumps({"event": "input_missing", "path": str(args.raster)}))
        return 2                          # usage/argument error

    with rasterio.open(args.raster) as ds:
        tiles = list(tile_windows(ds.width, ds.height, args.block))
        total_units = sum(px for _, px in tiles) if args.by_pixels else len(tiles)
        estimator = RollingEta(total_units)

        columns = [
            TextColumn("[bold]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            RollingEtaColumn(),
            TimeElapsedColumn(),
        ]
        next_log = time.monotonic() + args.log_every

        with Progress(*columns, console=None, transient=False) as progress:
            task_id = progress.add_task(
                "warping", total=len(tiles), estimator=estimator
            )
            for window, pixels in tiles:
                process_tile(ds, window)
                estimator.update(pixels if args.by_pixels else 1)
                progress.advance(task_id, 1)

                now = time.monotonic()
                if now >= next_log:
                    next_log = now + args.log_every
                    eta = estimator.eta_seconds()
                    log.info(json.dumps({
                        "event": "progress",
                        "done": estimator.done_units,
                        "total": total_units,
                        "throughput": round(estimator.throughput(), 3),
                        "eta_seconds": None if eta is None else round(eta, 1),
                        "eta_finish": None if eta is None
                            else round(time.time() + eta, 0),
                    }))

    log.info(json.dumps({"event": "done", "tiles": len(tiles)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

## Step Annotations

1. **`deque(maxlen=window)`** — Two bounded deques hold the last `window` durations and their work units. Because `maxlen` is set, an appended sample past the limit silently evicts the oldest one, so the window slides forward with zero bookkeeping. This is what makes the estimate forget warm-up tiles.

2. **`self._decay = 0.5 ** (1.0 / half_life)`** — The decay factor is derived from a half-life expressed in samples. A `half_life` of 12 means a tile twelve samples back contributes half the weight of the newest tile. Tuning the half-life, not the window length, is the natural knob for how reactive the ETA feels.

3. **`time.monotonic()` for every timestamp** — All elapsed measurements use the monotonic clock. It only ever moves forward, so an NTP correction mid-run cannot produce a negative tile duration and a garbage ETA. Wall-clock time (`time.time()`) is used exactly once, and only to render an absolute finish timestamp for logs.

4. **`throughput()` walks newest to oldest** — The loop accumulates `weight * units` and `weight * seconds` separately, shrinking `weight` by the decay each step, then divides the two sums. Dividing weighted work by weighted time yields an exponentially-weighted rate that is robust to a single anomalous tile.

5. **`eta_seconds()` returns `None` early** — Before the window has any signal, or if the smoothed rate is zero, the method returns `None` rather than dividing by zero or emitting `inf`. The Rich column and the log both treat `None` as "still warming up" and display a placeholder.

6. **`RollingEtaColumn(ProgressColumn)`** — Subclassing `ProgressColumn` is the supported way to add a computed field to a Rich `Progress`. It pulls the estimator out of `task.fields`, which is populated by passing `estimator=estimator` to `add_task`, so the column stays stateless.

7. **`--by-pixels`** — Switching `work_units` from `1` to the tile's pixel count changes what the rate measures: tiles per second becomes pixels per second. When edge tiles and interior tiles differ in area, the pixel-weighted rate is far steadier because it measures the quantity that actually drives cost.

## Named Gotcha: Weighting by Tile Count When Tiles Vary Wildly

The most common way this estimator misleads is counting tiles when tile cost is not uniform. A batch that mixes 512-pixel interior tiles with 64-pixel edge slivers, or one raster of dense terrain next to one of flat ocean, has per-tile durations that differ by an order of magnitude. A tiles-per-second rate then swings purely on which size of tile happened to land in the recent window, and the ETA jitters even though the machine's real throughput is steady.

The fix is to weight by the work that varies. Run with `--by-pixels` (or pass a pixel count to `estimator.update`) so the rate becomes pixels per second and the projection multiplies remaining *pixels* by that rate. Pixel count is a good proxy for raster work; for compute that scales with something else — number of features, output bands, resample passes — substitute that unit instead. The rule is: measure the quantity that drives duration, not the quantity that is easy to count.

The paired trap is the clock. Measure intervals with `time.monotonic()`, never `time.time()`. A daylight-saving change or an NTP step can move the wall clock backwards by seconds, and a negative interval poisons both the window and the throughput sum.

## Verification

A trustworthy ETA converges: as the run proceeds, its predicted finish timestamp should stop moving. Capture the structured logs and watch the `eta_finish` field settle.

```bash
# Run and keep the JSON progress lines only
python raster_eta.py scene.tif --block 512 --by-pixels 2>eta.log

# Extract the predicted finish timestamps; they should stabilise, not drift
python3 - <<'EOF'
import json
finishes = []
with open("eta.log") as fh:
    for line in fh:
        rec = json.loads(line)
        if rec.get("event") == "progress" and rec.get("eta_finish"):
            finishes.append(rec["eta_finish"])
# spread of the second half of the run should be small (a few percent)
half = finishes[len(finishes) // 2:]
spread = max(half) - min(half)
print(f"late-run finish spread: {spread:.0f}s over {len(half)} samples")
EOF
```

A small late-run spread confirms the estimate is stable. If the spread stays large, the window is too short for your tile-cost variance — raise `window` and `half_life`, or switch to `--by-pixels`. The final ETA should also approach zero smoothly in the Rich bar rather than snapping down only on the last tile, which is the signature of a lagging total-average.

## FAQ

<details class="faq-item">
<summary>Why does the ETA from a naive total-average jump around so much?</summary>

A total-average ETA divides every remaining tile by the mean cost of all tiles seen so far, so a single large tile permanently drags the average up and a run of small tiles drags it down. Because early tiles keep influencing the mean forever, the projection lurches whenever tile cost changes. A rolling exponentially-weighted window forgets stale tiles, so the estimate tracks current conditions instead.
</details>

<details class="faq-item">
<summary>Should I weight throughput by tile count or by pixel count?</summary>

Weight by pixels whenever tile sizes vary widely. Counting tiles assumes every tile costs the same, so a batch that mixes 512-pixel and 8192-pixel tiles produces an ETA that swings with the luck of the draw. Tracking pixels per second and multiplying by remaining pixels gives a stable projection because it measures the work that actually varies.
</details>

<details class="faq-item">
<summary><span>Why use <code>time.monotonic()</code> instead of <code>time.time()</code> for ETA?</span></summary>

`time.time()` reads the wall clock, which can jump backwards or forwards when NTP corrects the system time or when daylight-saving changes apply. A backwards jump produces a negative tile duration and a nonsensical ETA. `time.monotonic()` only ever increases and is immune to clock adjustments, so it is the correct clock for measuring elapsed intervals.
</details>

<details class="faq-item">
<summary>How do I know the ETA is trustworthy?</summary>

Log the ETA at a fixed interval and check that its predicted finish time converges as the job proceeds. On a healthy run the predicted completion timestamp should stabilise within a few percent after the first window fills, and the final ETA should approach zero smoothly rather than snapping down at the end.
</details>

---

## Related

- [Progress Tracking for Python GIS Batch Pipelines](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/) — parent guide covering progress bars, throughput metrics, and observability for batch raster and vector jobs
- [Checkpointing for Interrupted Spatial Batch Jobs](/spatial-batch-processing-async-workflows/progress-tracking-in-batch-jobs/implementing-checkpointing-for-interrupted-spatial-batches/) — resume a batch from its last saved position so the ETA restarts from real progress rather than zero
