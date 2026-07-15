<p align="center">
  <a href="https://www.batch-processing.com">
    <img src="https://www.batch-processing.com/og-image.png" alt="Python GIS CLI Toolcraft & Batch Processing" width="820">
  </a>
</p>

<h1 align="center">Python GIS CLI Toolcraft &amp; Batch Processing</h1>

<p align="center">
  Guides and runnable code for building command-line tools and batch-processing
  pipelines for geospatial work in Python.
</p>

<p align="center">
  <a href="https://www.batch-processing.com"><strong>www.batch-processing.com&nbsp;→</strong></a>
</p>

---

Geospatial work usually outgrows the throwaway-script stage faster than expected. The
moment you are reprojecting thousands of raster tiles, wiring up an internal GIS
toolchain, or packaging a spatial utility that other people depend on, you need tools
that behave predictably, fail clearly, and keep running when the input gets messy.

This repository is the source for
[www.batch-processing.com](https://www.batch-processing.com) — a collection of practical
guides on exactly that: the command-line layer and the processing layer of Python
geospatial tooling. Every guide is written for people who ship working software — Python
developers, DevOps and platform engineers, and maintainers of open-source spatial
libraries — and each one includes complete, runnable code that uses real geospatial types
(rasterio windows, GeoDataFrames, explicit EPSG codes) and explains the reasoning behind
each decision.

## What's inside

The guides are organised into two areas.

### CLI Architecture &amp; Design Patterns

Argument parsing with Typer and Click, subcommand organisation, Rich console output and
progress bars, layered configuration across TOML, YAML, and environment variables,
keeping environment variables in sync, and packaging and CI/CD for the awkward GDAL
dependency stack.

→ [Read the section](https://www.batch-processing.com/cli-architecture-design-patterns/)

### Spatial Batch Processing &amp; Async Workflows

Async I/O for raster processing, multiprocessing for GDAL tasks, chunked vector reading
with pyogrio, memory management for very large datasets, error handling that survives
partial failure (dead-letter queues, retries, structured logs), and progress tracking for
jobs that run for hours.

→ [Read the section](https://www.batch-processing.com/spatial-batch-processing-async-workflows/)

## Who it's for

- Python developers building or maintaining spatial command-line tools
- DevOps and platform engineers running geospatial pipelines in CI/CD and Kubernetes
- Open-source maintainers packaging reusable geospatial utilities
- Internal tooling teams standardising on reproducible spatial workflows

## Why it reads differently

- **Complete, runnable Python** — no pseudocode; real GDAL, rasterio, geopandas, and pyogrio.
- **Decision guides** for the calls that are easy to get wrong — *multiprocessing vs asyncio*, *pyogrio vs Fiona*.
- **Hand-drawn diagrams**, plain-language explanations, and a consistent, accessible design in light and dark themes.

## About this repository

This is the source for [www.batch-processing.com](https://www.batch-processing.com) — a
static site built with [Eleventy](https://www.11ty.dev/) and deployed on
[Cloudflare Workers](https://developers.cloudflare.com/workers/) with static assets.

```bash
npm install      # install dependencies
npm run build    # build the static site into ./_site
npm start        # local dev server with live reload
npm run deploy   # build and deploy the Cloudflare Worker
```

The content lives in `content/` as Markdown, page templates in `src/_includes/`, and
styles in `src/css/`.

---

Maintained by [**batch-processing-geospatial-cli-tools**](https://github.com/batch-processing-geospatial-cli-tools).
