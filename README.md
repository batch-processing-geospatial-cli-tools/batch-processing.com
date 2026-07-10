# Python GIS CLI Toolcraft & Batch Processing

**Production-grade, practitioner-focused guides for building command-line tools and batch-processing pipelines for geospatial workflows in Python.**

🌐 **[batch-processing.com](https://batch-processing.com)**

---

Modern geospatial work demands more than ad-hoc scripts. Whether you're reprojecting
thousands of raster tiles, wiring up an internal GIS toolchain, or packaging a reusable
spatial utility, this site gives you the architecture patterns, runnable code, and
production-hardening techniques to ship tools that scale.

Every guide is written for working practitioners — Python GIS developers, DevOps
engineers, and open-source maintainers — with complete, copy-pasteable implementations
that use real geospatial types (rasterio windows, GeoDataFrames, explicit EPSG codes)
and explain the reasoning behind each decision.

## What's inside

**50+ in-depth guides** across two areas:

### ⚙️ [CLI Architecture & Design Patterns](https://batch-processing.com/cli-architecture-design-patterns/)

Argument parsing with Typer & Click, subcommand organisation, Rich console output and
progress bars, layered configuration (TOML / YAML / environment variables), environment
variable sync, and packaging & CI/CD for the notoriously fragile GDAL stack.

### 🗺️ [Spatial Batch Processing & Async Workflows](https://batch-processing.com/spatial-batch-processing-async-workflows/)

Async I/O for raster processing, multiprocessing GDAL tasks, chunked vector reading with
pyogrio, memory management for terabyte-scale datasets, fault-tolerant error handling
(dead-letter queues, retries), and progress tracking for long-running batch jobs.

## Who it's for

- **Python GIS developers** building or maintaining spatial command-line tools
- **DevOps & platform engineers** running geospatial pipelines in CI/CD and Kubernetes
- **Open-source maintainers** packaging reusable geospatial utilities
- **Internal tooling teams** standardising on reproducible spatial workflows

## Why it's different

- **Complete, runnable Python** — no pseudocode; real GDAL, rasterio, geopandas, and pyogrio
- **Decision guides** for the high-stakes calls — *multiprocessing vs asyncio*, *pyogrio vs Fiona*
- **Hand-authored diagrams**, structured FAQs, and a consistent, accessible design in light and dark themes

## About this repository

This repository contains the source for **[batch-processing.com](https://batch-processing.com)** —
a static site built with [Eleventy](https://www.11ty.dev/) and deployed on
[Cloudflare Workers](https://developers.cloudflare.com/workers/) (Static Assets).

```bash
npm install      # install dependencies
npm run build    # build the static site into ./_site
npm start        # local dev server with live reload
npm run deploy   # build and deploy the Cloudflare Worker
```

---

Maintained by **[batch-processing-geospatial-cli-tools](https://github.com/batch-processing-geospatial-cli-tools)**.
