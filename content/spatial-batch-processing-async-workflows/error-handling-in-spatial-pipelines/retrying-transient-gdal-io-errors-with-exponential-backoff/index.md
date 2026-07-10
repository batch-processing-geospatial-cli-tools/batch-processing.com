---
title: "Retrying Transient GDAL I/O Errors with Exponential Backoff"
description: "Wrap remote GDAL reads in a tenacity retry with exponential backoff and jitter so transient S3 and network errors don't kill an otherwise healthy batch run."
slug: "retrying-transient-gdal-io-errors-with-exponential-backoff"
type: "long_tail"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Error Handling in Spatial Pipelines"
    url: "/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/"
  - label: "Retrying Transient GDAL I/O Errors with Exponential Backoff"
    url: "/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/retrying-transient-gdal-io-errors-with-exponential-backoff/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Retrying Transient GDAL I/O Errors with Exponential Backoff",
      "description": "Wrap remote GDAL reads in a tenacity retry with exponential backoff and jitter so transient S3 and network errors don't kill an otherwise healthy batch run.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Error Handling in Spatial Pipelines", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/"},
        {"@type": "ListItem", "position": 3, "name": "Retrying Transient GDAL I/O Errors with Exponential Backoff", "item": "https://batch-processing.com/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/retrying-transient-gdal-io-errors-with-exponential-backoff/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Retry Transient GDAL I/O Errors with Exponential Backoff",
      "step": [
        {"@type": "HowToStep", "name": "Classify the error", "text": "Inspect the RasterioIOError message for HTTP 5xx or throttling markers to decide whether the failure is transient or permanent."},
        {"@type": "HowToStep", "name": "Configure tenacity", "text": "Decorate the read with retry using wait_exponential plus wait_random jitter and stop_after_attempt to cap total attempts."},
        {"@type": "HowToStep", "name": "Retry reads only", "text": "Apply the retry to the pure read function so a re-run never re-executes a non-idempotent write."},
        {"@type": "HowToStep", "name": "Fail fast on permanent errors", "text": "Let missing-file, CRS mismatch, and unsupported-format errors raise immediately and exit with code 10 or 11."},
        {"@type": "HowToStep", "name": "Verify the log", "text": "Confirm the log shows the expected attempt count followed by either a success line or a give-up line after the final attempt."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How do I tell a transient GDAL error from a permanent one?",
          "acceptedAnswer": {"@type": "Answer", "text": "Inspect the exception. A RasterioIOError whose message mentions HTTP 500, 502, 503, 504, connection reset, or timeout is almost always transient and worth retrying. A message mentioning 404, no such file, not recognized as a supported file format, or a CRS mismatch you raise yourself is permanent and must fail fast."}
        },
        {
          "@type": "Question",
          "name": "Why add wait_random jitter on top of wait_exponential?",
          "acceptedAnswer": {"@type": "Answer", "text": "Pure exponential backoff makes every worker in a batch retry at the same instant after a shared outage, producing a synchronized thundering herd that re-triggers throttling. Adding wait_random spreads the retries across a window so the storage backend sees a smoother request rate and recovers."}
        },
        {
          "@type": "Question",
          "name": "Is it safe to retry a GDAL write the same way as a read?",
          "acceptedAnswer": {"@type": "Answer", "text": "No. Reads are idempotent, so re-running them is harmless. Writes are not: a retried gdal.Warp or upload can produce duplicate or half-written output. Wrap only the read in the retry, or make the write atomic by writing to a temp path and renaming after success."}
        },
        {
          "@type": "Question",
          "name": "What stop condition should I use for a batch of thousands of files?",
          "acceptedAnswer": {"@type": "Answer", "text": "Use stop_after_attempt(5) combined with a per-call ceiling from wait_exponential's max argument. Five attempts with a capped delay bounds worst-case latency per file to well under a minute, so one slow object cannot stall the whole batch while still surviving a short backend blip."}
        }
      ]
    }
  ]
}
</script>

# Retrying Transient GDAL I/O Errors with Exponential Backoff

Wrap the remote read in a `tenacity` retry that fires only on transient failures — `RasterioIOError` carrying an HTTP 5xx or throttling signal — using `wait_exponential` plus `wait_random` jitter and `stop_after_attempt`, and let permanent failures like a missing key, a CRS mismatch, or an unsupported format raise straight through with exit code `10` or `11`. That single distinction keeps a flaky S3 backend from killing an otherwise healthy batch. This page is part of the [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) guide inside the broader [Spatial Batch Processing & Async Workflows](/spatial-batch-processing-async-workflows/) reference.

## Prerequisites

- Python 3.10 or later
- `pip install tenacity rasterio` (rasterio 1.3+ bundles GDAL 3.4+)
- GDAL virtual filesystem access configured for your backend: AWS credentials for `/vsis3/`, or a plain `/vsicurl/` URL for public HTTPS objects

When a network read fails inside a worker, the exception surfaces from GDAL's C layer as a rasterio `RasterioIOError`. The retry logic here lives entirely around the read call, so it composes cleanly with the concurrency model described in [Async I/O for Raster Processing](/spatial-batch-processing-async-workflows/async-io-for-raster-processing/) and with the recovery path in [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/).

## Transient vs Permanent: the decision that drives everything

Retrying is only useful when a repeat of the exact same call could succeed. A throttled S3 request or a momentary 503 will clear on its own; a 404 or a corrupt file never will. Blindly retrying every exception turns a fast, deterministic failure into a slow one — five attempts with backoff against a missing key wastes 30-plus seconds per file and multiplied across a batch that is hours of dead time. The SVG below is the classifier that the code implements.

<svg viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree that classifies a GDAL read exception as transient, and therefore retryable with backoff, or permanent, and therefore a fast failure with an exit code" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Transient versus permanent GDAL error classification</title>
  <desc>A read raises an exception. If the message shows HTTP 5xx or throttling it is transient and retried with exponential backoff and jitter. If it shows 404, unsupported format, or CRS mismatch it is permanent and exits immediately.</desc>
  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
    </marker>
  </defs>
  <!-- top: read raises -->
  <rect x="270" y="16" width="180" height="46" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/>
  <text x="360" y="38" text-anchor="middle" font-size="12" fill="currentColor">read raster raises</text>
  <text x="360" y="53" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">RasterioIOError</text>
  <!-- decision diamond -->
  <polygon points="360,92 470,140 360,188 250,140" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.55" stroke-width="1.3"/>
  <text x="360" y="136" text-anchor="middle" font-size="11" fill="currentColor">message shows</text>
  <text x="360" y="151" text-anchor="middle" font-size="11" fill="currentColor">5xx / throttle?</text>
  <line x1="360" y1="62" x2="360" y2="90" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#ar)"/>
  <!-- yes branch -->
  <line x1="250" y1="140" x2="150" y2="140" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#ar)"/>
  <text x="205" y="132" text-anchor="middle" font-size="10" fill="#15803d">yes</text>
  <rect x="30" y="116" width="120" height="48" rx="6" fill="#15803d" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="90" y="137" text-anchor="middle" font-size="11" fill="currentColor">transient</text>
  <text x="90" y="152" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">retry backoff</text>
  <!-- retry loop box -->
  <rect x="20" y="210" width="260" height="104" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="150" y="232" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">wait_exponential + wait_random</text>
  <text x="150" y="252" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">attempt 1: about 1s</text>
  <text x="150" y="269" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">attempt 2: about 2s + jitter</text>
  <text x="150" y="286" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">attempt 3: about 4s + jitter</text>
  <text x="150" y="303" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">stop_after_attempt(5), then give up</text>
  <line x1="90" y1="164" x2="90" y2="208" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#ar)"/>
  <!-- no branch -->
  <line x1="470" y1="140" x2="570" y2="140" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#ar)"/>
  <text x="515" y="132" text-anchor="middle" font-size="10" fill="#c0392b">no</text>
  <rect x="570" y="116" width="130" height="48" rx="6" fill="#c0392b" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.2"/>
  <text x="635" y="137" text-anchor="middle" font-size="11" fill="currentColor">permanent</text>
  <text x="635" y="152" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">fail fast</text>
  <rect x="500" y="210" width="200" height="104" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.1"/>
  <text x="600" y="232" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">no retry</text>
  <text x="600" y="252" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">404 missing key</text>
  <text x="600" y="269" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">unsupported format: exit 11</text>
  <text x="600" y="286" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">CRS mismatch: exit 10</text>
  <text x="600" y="303" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">raise to caller</text>
  <line x1="635" y1="164" x2="635" y2="208" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" marker-end="url(#ar)"/>
</svg>

## Complete Working Implementation

The script reads a raster window from a cloud object over `/vsis3/` or `/vsicurl/`. The retry wraps only the read. Classification lives in `is_transient`, and permanent conditions raise dedicated exceptions that map to exit codes. Copy it, set the URL, and run:

```python
#!/usr/bin/env python3
"""
Retry transient cloud GDAL reads with exponential backoff and jitter.
Usage: python read_with_retry.py /vsis3/my-bucket/scenes/scene_001.tif
"""
import sys
import logging
import rasterio
from rasterio.windows import Window
from rasterio.errors import RasterioIOError
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
    wait_random,
    before_sleep_log,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("gdal-retry")

# Substrings GDAL/CURL surface for a temporary backend condition.
TRANSIENT_MARKERS = (
    "http error 500", "http error 502", "http error 503", "http error 504",
    "timed out", "timeout", "connection reset", "connection refused",
    "temporarily", "slowdown", "throttl", "please try again",
)
# Substrings that mean retrying can never help.
PERMANENT_MARKERS = (
    "http error 403", "http error 404", "no such file",
    "not recognized as", "not a supported", "does not exist",
)


class UnsupportedFormat(Exception):
    """Raised for a permanent format error -> exit 11."""


class CrsMismatch(Exception):
    """Raised when the raster CRS is not the expected one -> exit 10."""


def is_transient(exc: BaseException) -> bool:
    """Return True only for errors a bit-for-bit retry could clear.

    We match on the message because GDAL flattens HTTP status and CURL
    conditions into the RasterioIOError string; there is no status attribute.
    """
    if not isinstance(exc, RasterioIOError):
        return False
    msg = str(exc).lower()
    if any(p in msg for p in PERMANENT_MARKERS):
        return False
    return any(t in msg for t in TRANSIENT_MARKERS)


@retry(
    retry=retry_if_exception(is_transient),   # ONLY transient reads are retried
    wait=wait_exponential(multiplier=1, max=30) + wait_random(0, 2),
    stop=stop_after_attempt(5),               # bound worst-case per file
    before_sleep=before_sleep_log(log, logging.WARNING),
    reraise=True,                             # surface the real error, not RetryError
)
def read_window(url: str, expected_epsg: int = 4326) -> "tuple":
    """Read the top-left 512x512 window from a remote raster.

    This function is a PURE READ. It is safe to run any number of times,
    which is exactly why the retry decorator belongs here and nowhere near
    a write. Permanent conditions are converted to typed exceptions that
    escape the retry predicate untouched.
    """
    with rasterio.open(url) as ds:
        if ds.crs is None or ds.crs.to_epsg() != expected_epsg:
            # Permanent: no number of retries fixes a wrong projection.
            raise CrsMismatch(
                f"{url} is EPSG:{ds.crs.to_epsg() if ds.crs else 'unknown'}, "
                f"expected EPSG:{expected_epsg}"
            )
        window = Window(col_off=0, row_off=0, width=512, height=512)
        data = ds.read(1, window=window)
        return data, ds.profile


def main() -> None:
    if len(sys.argv) != 2:
        log.error("usage: read_with_retry.py <vsis3-or-vsicurl-url>")
        sys.exit(2)
    url = sys.argv[1]
    try:
        data, profile = read_window(url, expected_epsg=4326)
    except CrsMismatch as exc:
        log.error("CRS mismatch: %s", exc)
        sys.exit(10)
    except UnsupportedFormat as exc:
        log.error("unsupported format: %s", exc)
        sys.exit(11)
    except RasterioIOError as exc:
        # Reached only when the error was permanent OR retries were exhausted.
        log.error("read failed permanently after retries: %s", exc)
        sys.exit(1)
    log.info("read %s block: shape=%s dtype=%s", url, data.shape, data.dtype)
    sys.exit(0)


if __name__ == "__main__":
    main()
```

## Step Annotations

1. **`retry_if_exception(is_transient)`** — This is the whole design. Tenacity calls `is_transient` on every raised exception; only a `True` result triggers another attempt. A `CrsMismatch`, an `UnsupportedFormat`, or a `RasterioIOError` carrying `404` returns `False` and propagates on the first try.

2. **`wait_exponential(multiplier=1, max=30) + wait_random(0, 2)`** — Tenacity lets you add wait strategies. The exponential term grows the base delay (roughly 1s, 2s, 4s, 8s) while `max=30` caps it; the random term adds up to 2 seconds of jitter so a fleet of workers does not retry in lockstep after a shared outage.

3. **`stop_after_attempt(5)`** — Bounds the worst case. Five attempts against a capped delay keeps a single stubborn object from stalling the batch. Pair the attempt cap with the delay cap; neither alone is sufficient.

4. **`reraise=True`** — Without this, tenacity wraps the final failure in a `RetryError`, and your `except RasterioIOError` clause never fires. Re-raising the original exception keeps the exit-code mapping in `main` working.

5. **Typed permanent exceptions** — `CrsMismatch` and `UnsupportedFormat` exist so a permanent condition carries its own exit code (`10` and `11`) instead of collapsing into a generic runtime failure. They are raised *inside* the retried function but are invisible to the predicate, so they escape immediately.

6. **`before_sleep_log`** — Emits a `WARNING` before each backoff sleep, so the log makes the retry sequence auditable: you see attempt 2 of 5, attempt 3 of 5, and finally either a success line or the propagated error.

## Named Gotcha: Retrying a write duplicates output

The most damaging mistake is putting the retry around code that also writes. Reads are idempotent — running `read_window` five times reads the same bytes five times and changes nothing. A write is not: if `gdal.Warp` or an upload succeeds on the object store but the response times out on the way back, the retry runs the write a second time, leaving a duplicated or half-flushed file. Blanket-retrying is doubly wrong when the underlying error is a `404` you should have failed on in a few milliseconds; instead you burn the full backoff budget writing garbage.

The fix has two parts. First, decorate only the pure read, exactly as above — never the function that produces output. Second, if you must retry a write, make it atomic: write to a temporary key such as `scene_001.tif.tmp`, verify the byte count, then issue a single rename to the final path so a partial object is never visible. Permanent errors still bypass the retry entirely, so a missing source never triggers a wasteful write attempt in the first place.

## Verification

Run against a real object and read the log. A healthy transient recovery shows the retry warnings followed by a success line; an exhausted or permanent failure shows the give-up path and a non-zero exit code:

```bash
# Success after transient blips: expect WARNING retry lines then an OK read.
python read_with_retry.py /vsis3/my-bucket/scenes/scene_001.tif
echo "exit=$?"    # 0

# Permanent 404: expect ZERO retry lines and an immediate failure.
python read_with_retry.py /vsis3/my-bucket/scenes/missing.tif
echo "exit=$?"    # 1, and no "before sleep" WARNING appears
```

A correct run against a flaky object prints lines like `Retrying read_window in 2.3 seconds as it raised RasterioIOError` up to four times, then `read ... block: shape=(512, 512)`. A permanent `404` prints no retry warnings at all — that absence is the proof that classification worked. To capture the exhausted-retry case in a structured feed for a [dead-letter queue](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/building-a-dead-letter-queue-for-failed-geometry-transforms/), catch the re-raised `RasterioIOError` in `main` and serialize the URL and message before exiting.

## FAQ

<details class="faq-item">
<summary>How do I tell a transient GDAL error from a permanent one?</summary>

Inspect the exception. A `RasterioIOError` whose message mentions HTTP 500, 502, 503, 504, connection reset, or timeout is almost always transient and worth retrying. A message mentioning `404`, no such file, not recognized as a supported file format, or a CRS mismatch you raise yourself is permanent and must fail fast with an exit code.
</details>

<details class="faq-item">
<summary>Why add wait_random jitter on top of wait_exponential?</summary>

Pure exponential backoff makes every worker in a batch retry at the same instant after a shared outage, producing a synchronized thundering herd that re-triggers throttling. Adding `wait_random` spreads the retries across a window so the storage backend sees a smoother request rate and recovers.
</details>

<details class="faq-item">
<summary>Is it safe to retry a GDAL write the same way as a read?</summary>

No. Reads are idempotent, so re-running them is harmless. Writes are not: a retried `gdal.Warp` or upload can produce duplicate or half-written output. Wrap only the read in the retry, or make the write atomic by writing to a temp path and renaming after success.
</details>

<details class="faq-item">
<summary>What stop condition should I use for a batch of thousands of files?</summary>

Use `stop_after_attempt(5)` combined with a per-call ceiling from `wait_exponential`'s `max` argument. Five attempts with a capped delay bounds worst-case latency per file to well under a minute, so one slow object cannot stall the whole batch while still surviving a short backend blip.
</details>

---

## Related

- [Error Handling in Spatial Pipelines](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/) — parent guide covering failure capture, exit-code conventions, and recovery patterns for batch raster and vector workflows
- [Building a Dead-Letter Queue for Failed Geometry Transforms](/spatial-batch-processing-async-workflows/error-handling-in-spatial-pipelines/building-a-dead-letter-queue-for-failed-geometry-transforms/) — where to route reads that exhaust their retry budget instead of losing them
