# Consuming `block-sounds.json` (pugtools Build Showcase)

What every block sounds like when it is placed or broken, with the exact volume
and pitch the game plays it at. It drives the Timelapse and Lego reveals in
pugtools' Build Showcase, which play a real placing sound for each block.

## 1. Where the data lives

- Extractor: `src/extraction/blockSoundsExtractor.ts`
- Command: `npm run cli:dev -- dump block-sounds <version>` → `workspace/datasets/<version>/block-sounds.json`
- Needs: the version's **decompiled client** and its **processed dataset** (for `block-properties.json` and the block list)
- Consumer copy (pugtools): `apps/web/public/minecraft-data/<version>/block-sounds.json`, written slimmed by `scripts/build-minecraft-data.mjs`
- Audio bytes: not in this file. Event ids resolve against the pugtools sound library (`public/sound-library/<version>/`).

```jsonc
{
  "version": "26.4-snapshot-5",
  "defaultSoundType": "stone",
  "soundTypes": [
    {
      "id": "wood",                 // lowercased sound set resource name
      "volume": 1, "pitch": 1,      // the constant's own values
      "place": { "event": "block.wood.place", "volume": 1, "pitch": 0.8 },
      "break": { "event": "block.wood.break", "volume": 1, "pitch": 0.8 },
      "step": "block.wood.step", "hit": "block.wood.hit", "fall": "block.wood.fall"
    }
  ],
  "blocks": { "minecraft:oak_door": "wood" }   // every registered block
}
```

## 2. How a block's sound is resolved (in order)

1. **Set-type override.** Doors, trapdoors, buttons, pressure plates, signs, hanging signs and fence gates set their sound in the block *constructor*: `super(properties.sound(type.soundType()))`, with a `BlockSetType` or `WoodType` from the registration lambda. Hanging signs use `type.hangingSignSoundType()`. This runs after the property chain, so it wins.
2. **Declared `.sound(SoundType.X)` or `.sound(BlockSoundSets.X)`**, from `block-properties.json` (already resolved through `.ofFullCopy()` inheritance).
3. **Default `stone`**: `BlockBehaviour.Properties` starts with the stone sound type or `BlockSoundSets.STONE`.

## 3. Playback values are already worked out

`place` and `break` carry the values the game passes to `playSound`, read from
`BlockItem.place` and `LevelEventHandler` event 2001. Both use:

- volume = `(soundType.volume + 1) / 2`
- pitch = `soundType.pitch * 0.8`

Multiply these by the chosen `sounds.json` variant's own volume and pitch.

## 4. Gotchas

- **Never derive the event id from the type name.** `SoundType.LILY_PAD` places with `block.lily_pad.place` but breaks with `block.big_dripleaf.break`. The extractor reads ids out of `SoundEvents.java`.
- **Fluids are not in here as placements.** Water and lava are placed with a bucket: `item.bucket.empty` / `item.bucket.empty_lava` at volume 1, pitch 1 (`BucketItem.playEmptySound`). Consumers special-case them.
- **Placing a block spawns no particles in vanilla.** Breaking does (`addDestroyBlockEffect`), which is what the Timelapse reveal shows when a temporary pillar comes down.
- **Read the command's report.** `skippedSoundTypes`, `unknownSoundTypes` and `unresolvedSetTypes` should all be empty. Anything listed there means the decompiled source changed shape; the affected blocks fall back to stone rather than a guess.

## 5. Version 26.4 sound-set resources

From 26.4 snapshots, Minecraft stores block sounds in the client jar under `data/minecraft/block_sound_set/*.json`. The extractor reads these source resources directly, including their volume, pitch, and explicit event IDs. Missing event keys remain absent in the output: for example, dried ghast has no place sound. The ordinary version processing pipeline writes this sidecar along with note-block sounds and mob riders.
