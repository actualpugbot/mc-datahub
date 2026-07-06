# Consuming the structure-generation collections

The structure-generation extraction decodes everything a consumer needs to
assemble a random vanilla structure by the game's own jigsaw rules: the
worldgen structure definitions, their template pools and processor lists, and
every prebuilt structure template NBT converted to compact JSON.

## Files

Each processed version writes four sidecar files next to `dataset.json` in
`workspace/datasets/<version>/`:

| File | Envelope key | Contents |
| --- | --- | --- |
| `structures.json` | `structures` | One entry per `data/minecraft/worldgen/structure/*.json`. Jigsaw structures carry a normalized `jigsaw` config (`startPool`, `size`, `maxDistanceFromCenter`, `useExpansionHack`, `poolAliases`, ...). `raw` is the vanilla JSON. |
| `template-pools.json` | `pools` | One entry per `data/minecraft/worldgen/template_pool/**.json`: `fallback` plus normalized weighted `elements` (`elementType`, `location`, `processors` or `processorsInline`, `projection`, nested `elements` for list elements). |
| `processor-lists.json` | `processorLists` | One entry per `data/minecraft/worldgen/processor_list/*.json` with the raw `processors` array. |
| `structure-templates.json` | `templates` | One entry per `data/minecraft/structure/**.nbt`, decoded. Written as compact (non-pretty) JSON because of the block runs. |

## Template shape

```jsonc
{
  "id": "minecraft:village/plains/houses/plains_small_house_1",
  "key": "village/plains/houses/plains_small_house_1",
  "size": [9, 7, 9],
  // One or more random palettes of blockstate strings; indexes align across
  // palettes (the game picks one palette per placement, e.g. shipwreck wood).
  "palettes": [["minecraft:oak_planks", "minecraft:oak_stairs[facing=east,half=bottom]"]],
  // Flat runs of [x, y, z, paletteIndex]. Air, structure void, and jigsaw
  // blocks are omitted; jigsaw connectors live in `jigsaws` instead.
  "blocks": [0, 0, 0, 0, 1, 0, 0, 1],
  "jigsaws": [
    {
      "pos": [4, 0, 0],
      "orientation": "north_up",       // from the jigsaw blockstate
      "name": "minecraft:bottom",
      "pool": "minecraft:village/plains/houses",
      "target": "minecraft:building_entrance",
      "finalState": "minecraft:oak_planks", // render this at `pos` after assembly
      "jointType": "rollable",          // or "aligned"
      "placementPriority": 0,
      "selectionPriority": 0
    }
  ],
  "entityCount": 0,
  "sourcePath": "data/minecraft/structure/village/plains/houses/plains_small_house_1.nbt"
}
```

## Assembling a structure (jigsaw algorithm sketch)

1. Look up the structure in `structures.json`; only entries with a `jigsaw`
   config are pool-assembled. Resolve `pool_aliases` first if present (trial
   chambers randomize alias -> pool bindings once per structure instance).
2. Place a random weighted element from `startPool` at the origin with a
   random rotation.
3. Breadth-first over placed pieces: for each jigsaw connector (grouped by
   `selectionPriority`, descending), fetch the target pool's elements
   (weighted shuffle) followed by the fallback pool's elements. Try each
   candidate template x rotation x candidate-jigsaw whose `name` matches the
   connector's `target`, requiring face-to-face attachment (opposite
   orientations; equal rotation for `aligned` joints on vertical connectors).
4. Reject candidates whose rotated bounding box escapes
   `maxDistanceFromCenter` or collides with already-placed pieces; on
   success, recurse until the structure `size` (depth) is reached.
5. Render `finalState` at every connector position.

`orientation` values are `<facing>_<rotation hint>`: horizontal connectors use
`north|south|east|west_up`, vertical connectors use `up|down_<north|south|east|west>`.
Two connectors attach when their facings are opposite; `aligned` vertical
joints additionally keep the rotation hints matched.

## CLI

```bash
# Backfill or refresh the four sidecar files from downloaded jars:
npm run cli -- dump structures 26.2

# Inspect a collection from a processed dataset:
npm run cli -- dump collection structures 26.2
npm run cli -- dump collection template-pools 26.2
```

Full pipeline runs (`process version`) now extract these collections
automatically.
