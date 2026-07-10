---
title: "Validating CLI Config with Pydantic for GIS Workflows"
description: "Model a geospatial CLI's config with Pydantic so invalid EPSG codes, negative worker counts, and unknown keys fail fast with a clear exit code 2."
slug: "validating-cli-config-with-pydantic-for-gis-workflows"
type: "article"
breadcrumb:
  - label: "Home"
    url: "/"
  - label: "Configuration File Management for GIS CLI Tools"
    url: "/cli-architecture-design-patterns/configuration-file-management/"
  - label: "Validating CLI Config with Pydantic for GIS Workflows"
    url: "/cli-architecture-design-patterns/configuration-file-management/validating-cli-config-with-pydantic-for-gis-workflows/"
datePublished: "2025-07-10"
dateModified: "2026-07-10"
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "headline": "Validating CLI Config with Pydantic for GIS Workflows",
      "description": "Model a geospatial CLI's config with Pydantic v2 so invalid EPSG codes, negative worker counts, and unknown keys fail fast with a readable message and exit code 2.",
      "datePublished": "2025-07-10",
      "dateModified": "2026-07-10",
      "author": {"@type": "Organization", "name": "batch-processing.com"},
      "publisher": {"@type": "Organization", "name": "batch-processing.com"}
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://batch-processing.com/"},
        {"@type": "ListItem", "position": 2, "name": "Configuration File Management for GIS CLI Tools", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/"},
        {"@type": "ListItem", "position": 3, "name": "Validating CLI Config with Pydantic for GIS Workflows", "item": "https://batch-processing.com/cli-architecture-design-patterns/configuration-file-management/validating-cli-config-with-pydantic-for-gis-workflows/"}
      ]
    },
    {
      "@type": "HowTo",
      "name": "Validate a GIS CLI Config with Pydantic",
      "step": [
        {"@type": "HowToStep", "name": "Declare a BaseSettings model", "text": "Subclass pydantic-settings BaseSettings with typed fields for target_epsg, max_workers, and Path inputs."},
        {"@type": "HowToStep", "name": "Reject unknown keys", "text": "Set model_config extra to forbid so a misspelled key raises instead of being silently ignored."},
        {"@type": "HowToStep", "name": "Validate the EPSG code", "text": "Add a field_validator that calls pyproj.CRS.from_epsg to confirm the code resolves to a real coordinate system."},
        {"@type": "HowToStep", "name": "Constrain numeric and path fields", "text": "Use PositiveInt for max_workers and a validator that checks input directories exist on disk."},
        {"@type": "HowToStep", "name": "Catch ValidationError and exit 2", "text": "Wrap construction in try/except, print a readable summary of each error, and exit with code 2 for usage errors."}
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why exit with code 2 instead of 1 for a bad config?",
          "acceptedAnswer": {"@type": "Answer", "text": "Exit code 2 is the POSIX convention for usage and argument errors, which a malformed config file is. Reserving 1 for genuine runtime failures lets CI pipelines and wrapper scripts distinguish an operator typo from a crash mid-batch, so retries and alerting can branch correctly."}
        },
        {
          "@type": "Question",
          "name": "Does Pydantic coerce the string EPSG:4326 to an integer?",
          "acceptedAnswer": {"@type": "Answer", "text": "No. A field typed as int rejects the string EPSG:4326 because it is not a plain integer literal. Either type the field as int and require the config to store 4326, or accept a str and strip the EPSG: prefix inside your field_validator before calling pyproj.CRS.from_epsg."}
        },
        {
          "@type": "Question",
          "name": "How does env var precedence work in pydantic-settings?",
          "acceptedAnswer": {"@type": "Answer", "text": "By default pydantic-settings ranks sources as init arguments, then environment variables, then the dotenv file, then file secrets. An environment variable such as GIS_MAX_WORKERS therefore overrides the same value passed from a parsed config file unless you reorder sources with settings_customise_sources."}
        },
        {
          "@type": "Question",
          "name": "Can I validate that a Path field exists without a custom validator?",
          "acceptedAnswer": {"@type": "Answer", "text": "Yes. Pydantic ships path types such as DirectoryPath and FilePath that fail validation when the target does not exist or is the wrong kind. Use a plain Path plus a field_validator only when you also need to create missing output directories rather than reject them."}
        }
      ]
    }
  ]
}
</script>

# Validating CLI Config with Pydantic for GIS Workflows

Model your geospatial CLI's config as a Pydantic v2 `BaseSettings` class: type `target_epsg`, constrain `max_workers` to `PositiveInt`, use `DirectoryPath` for inputs, set `extra="forbid"` to reject unknown keys, and add a `field_validator` that runs `pyproj.CRS.from_epsg`. Wrap construction in a `try/except ValidationError` that prints each error and exits `2`. This page is part of the [Configuration File Management for GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) guide within the wider [CLI Architecture & Design Patterns for Python GIS](https://www.batch-processing.com/cli-architecture-design-patterns/) reference.

The point of a schema is to fail before the batch starts. A raster pipeline that reads `target_epsg: 99999` from a config file, opens 4,000 GeoTIFFs, warps them, and only then discovers the CRS is undefined has wasted an hour and left a half-written output directory. Validation moves that failure to the first millisecond.

## Prerequisites

- Python 3.10 or later
- `pip install pydantic>=2.5 pydantic-settings>=2.1 pyproj>=3.6`
- A working PROJ install (bundled with the `pyproj` wheel; a system GDAL/PROJ 9.x also works)

This page covers schema validation only. For merging defaults, a config file, and environment overrides into one resolved object, see the layering approach linked at the end. To move validated values onto the command line itself, pair this with [Argument Parsing with Typer](https://www.batch-processing.com/cli-architecture-design-patterns/argument-parsing-with-typer/), and to push overrides in from the shell, see [Environment Variable Sync](https://www.batch-processing.com/cli-architecture-design-patterns/environment-variable-sync/).

## Where Validation Sits

The config object is the boundary between untrusted text on disk and the geospatial code that trusts its inputs. Every value crosses that boundary exactly once, and each crossing is a checkpoint that either passes cleanly or aborts with exit `2`.

<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Config validation flow: a TOML file and environment variables feed a Pydantic settings model whose four field checks either pass to the pipeline or abort with exit code 2" style="width:100%;max-width:720px;height:auto;display:block;margin:1.5rem auto;">
  <title>Pydantic config validation checkpoints for a GIS CLI</title>
  <desc>A config file and environment variables flow into a Pydantic BaseSettings model. Inside, four checks run in sequence: extra=forbid, EPSG via pyproj, PositiveInt workers, and DirectoryPath existence. A pass arrow leads to the pipeline; any failure leads to a ValidationError box that exits with code 2.</desc>
  <!-- Sources -->
  <rect x="16" y="40" width="120" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="76" y="64" text-anchor="middle" font-size="11" fill="currentColor">config.toml</text>
  <rect x="16" y="100" width="120" height="40" rx="5" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="76" y="119" text-anchor="middle" font-size="11" fill="currentColor">GIS_ env vars</text>
  <text x="76" y="133" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.7">higher precedence</text>
  <!-- Arrows into model -->
  <line x1="136" y1="60" x2="212" y2="130" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a2)"/>
  <line x1="136" y1="120" x2="212" y2="150" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4" marker-end="url(#a2)"/>
  <!-- Model box -->
  <rect x="216" y="30" width="240" height="230" rx="8" fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="336" y="52" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ToolConfig(BaseSettings)</text>
  <rect x="236" y="66" width="200" height="34" rx="4" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <text x="336" y="87" text-anchor="middle" font-size="10.5" fill="currentColor">extra=forbid: no stray keys</text>
  <rect x="236" y="108" width="200" height="34" rx="4" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <text x="336" y="129" text-anchor="middle" font-size="10.5" fill="currentColor">target_epsg: pyproj.CRS</text>
  <rect x="236" y="150" width="200" height="34" rx="4" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <text x="336" y="171" text-anchor="middle" font-size="10.5" fill="currentColor">max_workers: PositiveInt</text>
  <rect x="236" y="192" width="200" height="34" rx="4" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" stroke-width="1"/>
  <text x="336" y="213" text-anchor="middle" font-size="10.5" fill="currentColor">input_dir: DirectoryPath</text>
  <!-- Pass arrow -->
  <line x1="456" y1="110" x2="556" y2="80" stroke="#15803d" stroke-opacity="0.7" stroke-width="1.6" marker-end="url(#a3)"/>
  <text x="512" y="78" text-anchor="middle" font-size="9.5" fill="#15803d">pass</text>
  <rect x="558" y="56" width="146" height="48" rx="6" fill="currentColor" fill-opacity="0.08" stroke="#15803d" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="631" y="77" text-anchor="middle" font-size="11" fill="currentColor">run pipeline</text>
  <text x="631" y="92" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">trusted config</text>
  <!-- Fail arrow -->
  <line x1="456" y1="200" x2="556" y2="234" stroke="#c0392b" stroke-opacity="0.7" stroke-width="1.6" marker-end="url(#a4)"/>
  <text x="512" y="232" text-anchor="middle" font-size="9.5" fill="#c0392b">fail</text>
  <rect x="558" y="210" width="146" height="60" rx="6" fill="currentColor" fill-opacity="0.08" stroke="#c0392b" stroke-opacity="0.6" stroke-width="1.3"/>
  <text x="631" y="233" text-anchor="middle" font-size="11" fill="currentColor">ValidationError</text>
  <text x="631" y="249" text-anchor="middle" font-size="10.5" fill="#c0392b">exit code 2</text>
  <text x="631" y="263" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.7">readable message</text>
  <defs>
    <marker id="a2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" opacity="0.5"/></marker>
    <marker id="a3" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#15803d" opacity="0.8"/></marker>
    <marker id="a4" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#c0392b" opacity="0.8"/></marker>
  </defs>
</svg>

## Complete Working Implementation

The module below defines the schema and a loader that reads a TOML file, constructs the model, and exits `2` with a readable summary on any validation failure. It is self-contained and runnable:

```python
#!/usr/bin/env python3
"""
Validated configuration for a geospatial batch CLI.
Usage: python config.py path/to/config.toml
"""
import sys
import tomllib
from pathlib import Path

from pydantic import (
    DirectoryPath,
    Field,
    PositiveInt,
    ValidationError,
    field_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict
from pyproj import CRS
from pyproj.exceptions import CRSError


class ToolConfig(BaseSettings):
    """Schema for the reprojection tool's config file and env overrides."""

    model_config = SettingsConfigDict(
        env_prefix="GIS_",     # GIS_MAX_WORKERS overrides max_workers
        extra="forbid",        # reject unknown keys instead of ignoring them
        frozen=True,           # config is immutable once validated
    )

    # Stored as a plain int (e.g. 32633), not the "EPSG:32633" string form.
    target_epsg: int = Field(..., description="Output CRS as an EPSG integer")
    max_workers: PositiveInt = Field(4, le=64)
    input_dir: DirectoryPath                       # must already exist
    output_dir: Path                               # created later if absent
    resample: str = Field("bilinear")

    @field_validator("target_epsg")
    @classmethod
    def epsg_must_resolve(cls, value: int) -> int:
        """Confirm the code maps to a real coordinate reference system."""
        try:
            CRS.from_epsg(value)
        except CRSError as exc:
            raise ValueError(
                f"{value} is not a valid EPSG code (pyproj: {exc})"
            ) from exc
        return value

    @field_validator("resample")
    @classmethod
    def resample_is_supported(cls, value: str) -> str:
        allowed = {"nearest", "bilinear", "cubic", "lanczos", "average"}
        if value not in allowed:
            raise ValueError(
                f"resample '{value}' not in {sorted(allowed)}"
            )
        return value


def load_config(path: Path) -> ToolConfig:
    """Parse a TOML file and validate it, or exit 2 on any error."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print(f"config error: cannot read {path}: {exc}", file=sys.stderr)
        raise SystemExit(2)

    try:
        # Values passed here rank below env vars in pydantic-settings.
        return ToolConfig(**raw)
    except ValidationError as exc:
        print(f"config invalid: {path}", file=sys.stderr)
        for err in exc.errors():
            loc = ".".join(str(p) for p in err["loc"]) or "(root)"
            print(f"  {loc}: {err['msg']}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: config.py CONFIG.toml", file=sys.stderr)
        raise SystemExit(2)

    cfg = load_config(Path(sys.argv[1]))
    crs = CRS.from_epsg(cfg.target_epsg)
    print(f"OK  target={crs.to_authority()}  workers={cfg.max_workers}")
    print(f"    input={cfg.input_dir}  resample={cfg.resample}")
```

A matching config file that passes validation:

```toml
# config.toml
target_epsg = 32633
max_workers = 8
input_dir = "./rasters"
output_dir = "./reprojected"
resample = "cubic"
```

## Step Annotations

1. **`SettingsConfigDict(extra="forbid")`** — This is the line that turns a silent typo into a hard error. Without it, a key like `max_worker` (missing the `s`) is dropped and the tool quietly runs with the default of 4. With `extra="forbid"`, Pydantic raises a `ValidationError` naming the offending key, so the operator learns immediately.

2. **`target_epsg: int` plus a `field_validator`** — Typing the field as `int` handles the coarse check (it must be a whole number), and `epsg_must_resolve` handles the semantic one. `CRS.from_epsg(9999)` raises `CRSError` because no such CRS is registered in the PROJ database, and re-raising it as `ValueError` lets Pydantic fold the message into its standard error report.

3. **`max_workers: PositiveInt = Field(4, le=64)`** — `PositiveInt` rejects `0` and negatives outright, which matters because `multiprocessing.Pool(processes=0)` raises deep inside the batch rather than at config time. The `le=64` upper bound stops a fat-fingered `max_workers = 640` from forking a process storm on a shared box.

4. **`input_dir: DirectoryPath` versus `output_dir: Path`** — `DirectoryPath` fails validation when the directory is missing, which is correct for an input you must read. The output directory is a plain `Path` because the pipeline creates it later with `mkdir(parents=True)`; validating its prior existence would be wrong.

5. **`frozen=True`** — Once validated, the config is immutable. This prevents a later stage from mutating `target_epsg` after the CRS check has already passed, keeping the validated object trustworthy for the life of the run.

6. **Iterating `exc.errors()`** — Pydantic collects every failure, not just the first. Printing `loc` and `msg` for each gives the operator a complete list to fix in one edit instead of a fix-run-fail loop. Every path through `load_config` that fails ends in `raise SystemExit(2)`.

## Named Gotcha: An Env Var Silently Overrides Your File Value

The most common surprise with `pydantic-settings` is source precedence. Because `ToolConfig` sets `env_prefix="GIS_"`, an environment variable named `GIS_MAX_WORKERS` outranks the same key passed from the parsed TOML file. Values you spread as `ToolConfig(**raw)` are init arguments, and in the default ordering environment variables sit *above* nothing except init args — but for keyword init the rank order is init args, then env, then dotenv, then secrets, meaning env wins over anything you did not pass explicitly and init wins over env for keys you did pass.

The trap appears when a CI runner exports `GIS_MAX_WORKERS=32` for an unrelated job. Your config file says `max_workers = 8`, you spread it into the model, and because you passed it explicitly it holds at 8 — but a key you *omit* from the spread quietly picks up its env value instead of the file default. To make the file authoritative, either pass every key explicitly, or override the ordering:

```python
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

class FileFirstConfig(ToolConfig):
    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings,
        env_settings, dotenv_settings, file_secret_settings,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # init_settings first means file values beat env vars.
        return (init_settings, dotenv_settings, env_settings, file_secret_settings)
```

Order the tuple from highest to lowest priority. Putting `init_settings` first makes the parsed file win; putting `env_settings` first (the default) lets the shell win. Decide deliberately rather than inheriting the default.

## Verification

Confirm both the pass and fail paths behave. A valid file prints the resolved authority and returns `0`; an invalid one prints each error and returns `2`:

```bash
# Passes: prints OK and exits 0
python config.py config.toml
echo "exit=$?"        # exit=0

# Bad EPSG, negative workers, and an unknown key
cat > broken.toml <<'EOF'
target_epsg = 99999
max_workers = -2
input_dir = "./rasters"
output_dir = "./out"
typo_key = true
EOF

python config.py broken.toml
echo "exit=$?"        # exit=2
```

The failing run reports each problem on its own line, for example `target_epsg: Value error, 99999 is not a valid EPSG code`, `max_workers: Input should be greater than 0`, and `typo_key: Extra inputs are not permitted`. Assert the exit code in CI so a regression that swallows validation is caught:

```bash
python config.py broken.toml && { echo "should have failed"; exit 1; }
test $? -eq 2 || echo "wrong exit code"
```

## Troubleshooting

| Symptom | Root Cause | Fix |
|---|---|---|
| `target_epsg` accepts `4326` but rejects `"EPSG:4326"` | Field typed as `int`; the prefixed string is not an int | Store the bare integer, or type as `str` and strip `EPSG:` in the validator |
| Unknown key ignored, tool uses defaults | `extra` left at its default of `ignore` | Set `extra="forbid"` in `model_config` |
| File value overridden unexpectedly | Env var with `env_prefix` outranks omitted file keys | Pass keys explicitly or reorder `settings_customise_sources` |
| `DirectoryPath` fails for a path you will create | `DirectoryPath` requires prior existence | Use a plain `Path` for outputs created at runtime |
| Traceback instead of clean message | `ValidationError` not caught at the boundary | Wrap construction in `try/except ValidationError` and exit `2` |

## FAQ

<details class="faq-item">
<summary>Why exit with code 2 instead of 1 for a bad config?</summary>

Exit code `2` is the POSIX convention for usage and argument errors, which a malformed config file is. Reserving `1` for genuine runtime failures lets CI pipelines and wrapper scripts distinguish an operator typo from a crash mid-batch, so retries and alerting can branch correctly.
</details>

<details class="faq-item">
<summary>Does Pydantic coerce the string EPSG:4326 to an integer?</summary>

No. A field typed as `int` rejects the string `EPSG:4326` because it is not a plain integer literal. Either type the field as `int` and require the config to store `4326`, or accept a `str` and strip the `EPSG:` prefix inside your `field_validator` before calling `pyproj.CRS.from_epsg`.
</details>

<details class="faq-item">
<summary>How does env var precedence work in pydantic-settings?</summary>

By default pydantic-settings ranks sources as init arguments, then environment variables, then the dotenv file, then file secrets. An environment variable such as `GIS_MAX_WORKERS` therefore overrides the same value passed from a parsed config file unless you reorder sources with `settings_customise_sources`.
</details>

<details class="faq-item">
<summary>Can I validate that a Path field exists without a custom validator?</summary>

Yes. Pydantic ships path types such as `DirectoryPath` and `FilePath` that fail validation when the target does not exist or is the wrong kind. Use a plain `Path` plus a `field_validator` only when you also need to create missing output directories rather than reject them.
</details>

---

## Related

- [Configuration File Management for GIS CLI Tools](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/) — parent guide covering config discovery, precedence, and formats for geospatial command-line tools
- [Layering TOML and Env Config for Raster Pipelines](https://www.batch-processing.com/cli-architecture-design-patterns/configuration-file-management/layering-toml-and-env-config-for-raster-pipelines/) — how to merge defaults, a config file, and environment overrides into one resolved object before validation runs
