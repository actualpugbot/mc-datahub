# mc-datahub

`mc-datahub` is a modular TypeScript pipeline for tracking Minecraft Java Edition releases, downloading artifacts, extracting structured data, and exposing the results through both a CLI and a REST API.

## What It Does

- Polls the official Minecraft articles feed and detects new release or snapshot posts.
- Resolves version metadata from Mojang's version manifest.
- Downloads client and server JARs into versioned workspace directories.
- Orchestrates a decompilation pipeline that can plug into Tiny Remapper and Vineflower.
- Extracts normalized block, item, recipe, model, and texture datasets from vanilla assets and data packs.
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
    items.json
    recipes.json
    textures.json
    models.json
    palettes.json
  diffs/
  state.json
```

## CLI

Build first:

```bash
npm install
npm run build
```

Run the main commands:

```bash
node dist/cli.js fetch latest
node dist/cli.js process version 1.21.5
node dist/cli.js diff versions 1.21.4 1.21.5
node dist/cli.js dump recipes 1.21.5 --output ./recipes.json
node dist/cli.js api serve --port 4000
```

During development:

```bash
npm run dev:cli -- fetch latest --no-process
```

## Decompilation Tooling

The extraction and diff pipeline work out of the box once dependencies are installed. Decompilation is designed to be independently runnable, but it depends on external Java tooling:

- `MCDATAHUB_TINY_REMAPPER_CMD`
- `MCDATAHUB_VINEFLOWER_CMD`

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

If no toolchain is configured, `process version` still downloads, extracts, and exports datasets while recording the decompile step as skipped.

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
