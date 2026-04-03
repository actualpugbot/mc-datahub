# mc-datahub

`mc-datahub` is a modular TypeScript pipeline for tracking Minecraft Java Edition releases, downloading artifacts, extracting structured data, and exposing the results through both a CLI and a REST API.

## What It Does

- Polls the official Minecraft articles feed and detects new release or snapshot posts.
- Resolves the latest release and snapshot metadata from Mojang's version manifest.
- Downloads client and server JARs into versioned workspace directories.
- Orchestrates a decompilation pipeline that can plug into Tiny Remapper and Vineflower.
- Extracts normalized block, item, recipe, model, and texture datasets from vanilla assets and data packs.
- Derives source-based `item-stats` and `block-properties` datasets from decompiled client source when available.
- Exports extracted texture PNGs alongside each versioned dataset.
- Derives extracted and curated palette presets from vanilla trim palettes and biome colormaps.
- Compares datasets between versions and writes structured diffs.
- Serves extracted datasets over HTTP.

## Project Layout

```text
workspace/
  cache/                Cached HTTP responses
  versions/<version>/
    downloads/          Raw client/server JARs and metadata
    mappings/           Mojang or Yarn mappings
    remapped/           Remapped JAR outputs
    decompiled/         Vineflower output
  datasets/<version>/
    dataset.json
    blocks.json
    block-properties.json
    items.json
    item-stats.json
    recipes.json
    textures.json
    images/             Extracted texture PNG files
    models.json
    palettes.json
  diffs/
  state.json
```

## Codex-Friendly Summary

If another project or Codex agent wants Minecraft data without re-implementing extraction, `mc-datahub` can provide these versioned outputs under `workspace/datasets/<version>/`:

- `dataset.json`: one combined snapshot with every extracted collection
- `blocks.json`: block ids, tags, blockstate/model references, and texture references
- `items.json`: item ids, tags, recipe links, model references, and texture references
- `recipes.json`: normalized vanilla recipe data
- `models.json`: model parent chains and texture references
- `textures.json` plus `images/`: texture metadata and exported PNG files
- `palettes.json`: extracted and curated color palettes
- `item-stats.json`: source-derived stack size, durability, food stats, rarity, fire resistance, and tool or armor stats
- `block-properties.json`: source-derived destroy time, explosion resistance, light emission, push reaction, and behavior flags

For automation, prefer `dataset.json` when you want everything in one read, and prefer the per-file JSON outputs when you only need one collection. If you want an HTTP interface instead of reading files directly, the API exposes `GET /versions/:version/blocks`, `items`, `item-stats`, `block-properties`, `recipes`, and `palettes`.

## CLI

Build first:

```bash
npm install
npm run build
```

Run the main commands:

```bash
npm run cli -- fetch latest
npm run cli -- process version 1.21.5
npm run cli -- process version latest-snapshot
npm run cli -- toolchain doctor
npm run cli -- diff versions 1.21.4 1.21.5
npm run cli -- dump recipes 1.21.5 --output ./recipes.json
npm run cli -- api serve --port 4000
```

`dump recipes` prefers an already processed dataset and falls back to extracting directly from downloaded `client.jar` and `server.jar` files when needed.

`fetch latest` now resolves the latest release and latest snapshot directly from Mojang's manifest, so `--kind any` processes both by default.

When a decompiled client source tree is available under `workspace/versions/<version>/decompiled/client`, `process version` also writes:

- `item-stats.json` with source-derived stack sizes, durability, food values, rarity, fire resistance, and tool or armor stats
- `block-properties.json` with source-derived destroy time, explosion resistance, light emission, push reaction, and related flags

During development:

```bash
npm run cli:dev -- fetch latest --no-process
```

If you want the shortest possible form for repeated use, link the package once and run the binary directly:

```bash
npm link
mc-datahub fetch latest
```

## Decompilation Tooling

The extraction and diff pipeline work out of the box once dependencies are installed. Decompilation is designed to be independently runnable, but it depends on external Java tooling:

- `MCDATAHUB_TINY_REMAPPER_CMD`
- `MCDATAHUB_VINEFLOWER_CMD`
- `MCDATAHUB_VINEFLOWER_JAR`

Both values are command templates with placeholders:

- `{input}`
- `{output}`
- `{mappings}`
- `{version}`
- `{kind}`

Example:

```bash
export MCDATAHUB_TINY_REMAPPER_CMD='java -jar /opt/remapper-helper.jar --input {input} --output {output} --mappings {mappings}'
export MCDATAHUB_VINEFLOWER_CMD='java -jar /opt/vineflower.jar {input} {output}'
```

For the common Vineflower case, you can skip the full command template and point straight at the JAR:

```bash
export MCDATAHUB_VINEFLOWER_JAR=/opt/vineflower.jar
```

`mc-datahub` also auto-detects Vineflower in these locations, in this order:

- `MCDATAHUB_VINEFLOWER_CMD`
- `MCDATAHUB_VINEFLOWER_JAR`
- `workspace/tools/vineflower.jar` or `workspace/tools/vineflower-*.jar`
- `./tools/vineflower.jar` or `./tools/vineflower-*.jar`
- a `vineflower` or `fernflower` executable on `PATH`

Use the doctor command to see exactly what was found:

```bash
npm run cli -- toolchain doctor
```

If no toolchain is configured, `process version` still downloads, extracts, and exports datasets while recording the decompile step as skipped with a more specific reason.

Today the extra source-derived datasets only depend on readable decompiled client source, so the current Vineflower setup is enough to start extracting additional data. Tiny Remapper is still useful if you want a fuller remap step before decompilation.

## Environment Variables

- `MCDATAHUB_WORKSPACE_ROOT` overrides the default `./workspace`
- `MCDATAHUB_ARTICLES_URL` overrides the Minecraft news page URL
- `MCDATAHUB_VERSION_MANIFEST_URL` overrides Mojang's version manifest URL
- `MCDATAHUB_YARN_MANIFEST_BASE_URL` overrides Fabric Meta's Yarn endpoint
- `MCDATAHUB_YARN_MAVEN_BASE_URL` overrides Fabric's Maven base URL
- `MCDATAHUB_API_HOST` sets the API bind host
- `MCDATAHUB_API_PORT` sets the API port

## Testing

```bash
npm test
```

The tests focus on the modular pieces that are easiest to regress:

- news parsing and version detection
- normalized data extraction
- structured dataset diffs
