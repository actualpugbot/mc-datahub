# Consuming `note-block-sounds.json` (pugtools Note Block Lab)

This dataset is every sound a Minecraft note block can make, resolved to
content-addressed ogg objects. It drives pugtools' Note Block Lab, whose
in-browser preview has to be pitch-accurate to the game. It assumes you already
have the version's dataset directory and (for playback) the `pages/note-block/`
object store.

## 1. Where the data lives

- Extractor: `scripts/build-note-block-sounds.mjs` → `workspace/datasets/<version>/note-block-sounds.json`
- Audio objects: `scripts/download-note-block-sounds.mjs` → `pages/note-block/<hash[0:2]>/<hash>.ogg`
- Consumer copy (pugtools): `apps/web/public/minecraft-data/<version>/note-block-sounds.json`

The file is a **top-level array**, one entry per `block.note_block.*` sound
event:

```jsonc
[
  {
    "instrument": "harp",                    // strip of the event id
    "event": "block.note_block.harp",
    "kind": "pitched",                       // "pitched" | "mobhead"
    "subtitle": "subtitles.block.note_block.note",
    "variants": [
      {
        "soundPath": "note/harp2",           // note the file is NOT named "harp"
        "assetPath": "minecraft/sounds/note/harp2.ogg",
        "hash": "…sha1…",                    // -> pages/note-block/<h0:2>/<hash>.ogg
        "size": 12345
        // pitch / volume / weight are OMITTED when they are the default 1
      }
    ]
  },
  {
    "instrument": "imitate.creeper",
    "event": "block.note_block.imitate.creeper",
    "kind": "mobhead",
    "variants": [
      { "soundPath": "random/fuse", "hash": "…", "size": 28874, "pitch": 0.5 }
    ]
  }
]
```

In **26.2** there are **26** entries: **20 pitched** (the 16 classic instruments
plus the four copper `trumpet` oxidation timbres — `trumpet`, `trumpet_exposed`,
`trumpet_oxidized`, `trumpet_weathered`) and **6** `imitate.<mob>` mob-head
sounds (`creeper`, `ender_dragon`, `piglin`, `skeleton`, `wither_skeleton`,
`zombie`). There is no seventh mob head.

## 2. The one thing to know about the values

**The 25 notes are not in this file.** Every pitched instrument ships exactly
one sample, and the game produces its 25 notes by resampling it. Reproduce that
with a playback rate, not with 25 files:

| Concept | Value | Equivalent |
| --- | --- | --- |
| Note blockstate | `note` = 0..24 | 25 semitones, two octaves |
| Natural pitch | `note` = 12 | playbackRate 1.0 |
| Pitch multiplier | `2^((note - 12) / 12)` | playbackRate 0.5 .. 2.0 |
| Per-variant `pitch` | e.g. creeper's `0.5` | multiplies the above |

`kind: "mobhead"` sounds are **unpitched one-shots** — the note blockstate does
not repitch them. Pick among their `variants` by `weight` (default 1), exactly
as the game does, and honour each variant's `pitch`/`volume`.

> The extractor deliberately differs from `mobSoundExtractor.ts` here: when an
> `imitate.*` event references an `entity.*` event via `type: "event"`, the
> reference's own `pitch`/`volume` are **folded into** the resolved variant. The
> mob extractor drops them, which would lose `imitate.creeper`'s `pitch: 0.5`.

## 3. The audio bytes

Objects are content-addressed and immutable:

```
pages/note-block/<hash[0:2]>/<hash>.ogg
```

39 objects, ~443 KB total for 26.2. Serve them same-origin if you decode with
WebAudio — `fetch` + `decodeAudioData` is CORS-sensitive, unlike `<audio>`
streaming. (pugtools copies them into `public/note-block-lab/sounds/`.)

## 4. Playing a note (framework-agnostic)

```js
// One decoded AudioBuffer per instrument, cached by hash.
const buffer = await decodeOnce(`/note-block-lab/sounds/${h.slice(0, 2)}/${h}.ogg`);

function playNote(ctx, buffer, variant, note, pitched) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = pitched
    ? 2 ** ((note - 12) / 12) * (variant.pitch ?? 1)
    : (variant.pitch ?? 1);          // mob heads ignore the note
  const gain = ctx.createGain();
  gain.gain.value = variant.volume ?? 1;
  src.connect(gain).connect(ctx.destination);
  src.start();                        // sample-accurate: pass a ctx.currentTime offset
}
```

## 5. Which block makes which instrument

The instrument comes from the block **below** the note block — or, for the six
mob-head sounds, the head **above** it. The `instrument` blockstate is
recomputed by the game from those neighbours, so a schematic only needs to place
the right base block; the `note` blockstate is what persists and sets the pitch.

## 6. Regenerating

```bash
node scripts/build-note-block-sounds.mjs 26.2      # resolve sounds.json -> hashes
node scripts/download-note-block-sounds.mjs 26.2   # fetch the oggs into pages/
```

The extractor is standalone — it reads `workspace/versions/<v>/metadata.json`
for the asset index and needs only network access, not a decompiled client.

## 7. What this data does not cover (show, don't fake)

- **Attenuation / 3D falloff.** Note blocks are audible ~48 blocks away in game;
  nothing here models distance.
- **The copper trumpet's oxidation timbres** are present as separate entries but
  a note block picks one from the copper block's oxidation state — that mapping
  is game logic, not data.
- **Player-head "custom" note blocks.** Vanilla has no such sound event; do not
  invent one.
- **Redstone timing.** The 0.1 s redstone tick and repeater delays are the
  consumer's problem, not this dataset's.
