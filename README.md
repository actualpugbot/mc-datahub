# mc-datahub

`mc-datahub` is a modular TypeScript pipeline for tracking Minecraft Java Edition releases, downloading artifacts, extracting structured data, and exposing the results through both a CLI and a REST API.

## What It Does

- Polls the official Minecraft articles feed and detects new release or snapshot posts.
- Resolves the latest release and snapshot metadata from Mojang's version manifest.
- Downloads client and server JARs into versioned workspace directories.
- Orchestrates a decompilation pipeline that can plug into Tiny Remapper and Vineflower.
- Extracts normalized block, item, recipe, model, and texture datasets from vanilla assets and data packs.
- Extracts additional data-pack collections: enchantments, registry tags, loot tables, advancements, and `en_us` translations.
- Derives source-based `item-stats` and `block-properties` datasets from decompiled client source when available.
- Exports extracted texture PNGs alongside each versioned dataset.
- Derives mob image metadata from client entity renderers and exports representative mob PNGs.
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
    enchantments.json
    tags.json
    loot-tables.json
    advancements.json
    translations.json
    textures.json
    images/             Extracted texture PNG files
    mob-images.json
    mob-images/         Exported mob entity PNG files
    mob-models.json     Source-derived model layers, cubes, pivots, and skin UVs
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
- `mob-images.json` plus `mob-images/`: mob image metadata and exported representative entity PNG files
- `mob-models.json`: source-derived mob model layers with exact cube geometry, pivots, rotations, texture sizes, and per-face UV rectangles for 3D rendering
- `palettes.json`: extracted and curated color palettes
- `item-stats.json`: source-derived stack size, durability, food stats, rarity, fire resistance, and tool or armor stats
- `block-properties.json`: source-derived destroy time, explosion resistance, light emission, push reaction, and behavior flags
- `enchantments.json`: data-driven enchantment definitions (description key, supported items, max level, weight, anvil cost, slots)
- `tags.json`: registry tags (block, item, fluid, entity_type, …) with their resolved values
- `loot-tables.json`: loot tables with derived item drops and the loot functions they use
- `advancements.json`: advancement tree with parent, display keys, icon, criteria, and rewards
- `translations.json`: `en_us` language entries (display names) as `{ key, value }` pairs
- `biomes.json`: biome ids, display names, dimension/category, visual effects, tags, raw worldgen JSON, and placement metadata for surface/cave/special filtering

### Biome Consumer Contract

`biomes.json` includes every vanilla `data/minecraft/worldgen/biome/*.json` entry, including vertical and special biomes such as `deep_dark`, `dripstone_caves`, `lush_caves`, `sulfur_caves`, and `the_void`. Consumers should not hardcode those names to decide rendering behavior; use the normalized placement fields instead.

- `surfaceMap: true` marks biomes suitable for a surface-only X/Z overworld biome map.
- `placement: "underground"`, `requiresY: true`, or `vertical: true` marks cave biomes that require X/Y/Z sampling. `yRange`, when present, is the broad source-derived dimension build envelope, not a precise climate threshold.
- `surfaceClimate: false` marks biomes that should not be emitted by normal surface climate lookup, including cave and special biomes.
- `placement: "special"` and `searchable: false` marks registry/special biomes such as `the_void` that should stay out of normal map/search lists unless a UI has an explicit hidden/special mode.
- `placement: "nether"` and `placement: "end"` separate non-overworld dimension biomes from overworld surface and cave flows.

For automation, prefer `dataset.json` when you want everything in one read, and prefer the per-file JSON outputs when you only need one collection.

If you consume `mc-datahub` from another TypeScript project, you can import the dataset shapes as a typed contract instead of re-declaring them: `import type { VersionDataset } from "mc-datahub"` (or `"mc-datahub/types"`). The build emits `.d.ts` declarations for the whole public surface.

If you want an HTTP interface instead of reading files directly, the API exposes a read-only, CORS-enabled JSON endpoint per collection plus combined and diff views:

- `GET /versions/:version` — dataset summary (per-collection counts, provenance, generation time)
- `GET /versions/:version/dataset` — the full combined dataset in one response
- `GET /versions/:version/diff/:toVersion` — structured diff (`?summary=true` for counts only)
- `GET /versions/:version/{blocks,items,item-stats,block-properties,recipes,models,textures,enchantments,tags,loot-tables,advancements,translations,palettes,mob-images,mob-models,mob-sounds}`
- `GET /versions/:version/assets/<dataset-relative-path>` — serves extracted binary assets (texture/mob PNGs, dumped `.ogg`), e.g. `assets/images/block/oak_planks.png`

Every collection endpoint supports `?id=` (exact id) or `?q=` (substring) filtering and `?limit=`/`?offset=` pagination; `tags` also supports `?registry=`. A real OpenAPI 3.1 document is served at `GET /openapi.json` for Swagger UI and client codegen.

For quick manual inspection, the API now serves a small mob sound explorer landing page at `GET /mob-sounds/explorer` with two focused views:

- `GET /mob-sounds/explorer/wiki` compares one processed version against the saved minecraft.wiki snapshot.
- `GET /mob-sounds/explorer/versions` compares one processed version against another processed version locally.

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
npm run cli -- versions list
npm run cli -- dump recipes 1.21.5 --output ./recipes.json
npm run cli -- dump collection enchantments 1.21.5 --output ./enchantments.json
npm run cli -- dump mob-audio 1.21.5
npm run cli -- api serve --port 4000
```

`versions list` reports which versions already have a processed dataset on disk.

`dump collection <collection> <version>` writes any processed collection (`blocks`, `items`, `item-stats`, `block-properties`, `recipes`, `models`, `textures`, `enchantments`, `tags`, `loot-tables`, `advancements`, `translations`, `palettes`, `mob-images`, `mob-models`, `mob-sounds`, or the full `dataset`) to stdout or a `--output` file.

`dump recipes` prefers an already processed dataset and falls back to extracting directly from downloaded `client.jar` and `server.jar` files when needed.

`dump mob-audio` prefers an already processed dataset and falls back to extracting mob sound metadata from downloaded `client.jar` and `server.jar` files plus `workspace/versions/<version>/metadata.json`, then downloads the referenced `.ogg` assets into `workspace/datasets/<version>/mob-audio/` by default.

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

## Preparing Mob Sound Exports

Use a two-step flow when another project needs both the mob sound metadata JSON and the actual `.ogg` files:

1. Run `process version` for the target version. This writes `workspace/datasets/<version>/mob-sounds.json` as part of the normal dataset output.
2. Run `dump mob-audio` for the same version. This reads `mob-sounds.json` when it is available, deduplicates the referenced sound assets, and downloads the `.ogg` files into `workspace/datasets/<version>/mob-audio/` by default.

Example for the latest release:

```bash
npm run cli -- process version latest-release
npm run cli -- dump mob-audio latest-release
```

That leaves you with:

```text
workspace/datasets/<resolved-version>/mob-sounds.json
workspace/datasets/<resolved-version>/mob-audio/**/*.ogg
```

`dump mob-audio` is safe to rerun. Existing files are reused when their SHA-1 matches Mojang's asset metadata, so the command only downloads files that are missing or stale.

For downstream projects, keep the JSON and audio handoff explicit. For example, to refresh `~/dev/mob-dub` with version `26.1.1`:

```bash
cd ~/dev/mob-dub
node scripts/sync-mob-data.mjs 26.1.1

cd ~/dev/mc-datahub
npm run cli -- dump mob-audio 26.1.1 --output ~/dev/mob-dub/public/data/mob-audio/26.1.1
```

The `mob-dub` sync step copies `mob-sounds.json` into `public/data/mob-sounds.json`, while the `dump mob-audio` step gives it a versioned directory of raw vanilla `.ogg` files under `public/data/mob-audio/`.

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
- HTTP API routing, filtering, pagination, diff, and asset serving

## Development Tooling

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (flat config)
npm run format        # prettier --write
npm run format:check  # prettier --check (CI uses this)
npm test              # vitest
npm run build         # clean dist/, then emit JS + .d.ts declarations
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, test, and build across Node 18/20/22 on every push and pull request.
