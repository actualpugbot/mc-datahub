# Version metadata for consumers

`process version` resolves each requested ID against Mojang's version manifest. New
`workspace/datasets/<id>/dataset.json` files carry `releaseTime` (the game's
release timestamp) and `versionType` (Mojang's `release` or `snapshot` type).
The smaller `version.json` sidecar carries the same timestamp as `releaseTime`
and the raw Mojang type as `type`. Older extracted datasets may lack these
fields; their source metadata remains in
`workspace/versions/<id>/metadata.json`.

Use `releaseTime` for game version ordering. `generatedAt` records when data
was extracted and may become newer when an old version is reprocessed. It
must not make that version the default in a selector.

Mojang marks snapshots, pre-releases, and release candidates with the raw
`snapshot` type. The exported `classifyVersion(id, type)` helper provides
`channel: "release" | "snapshot"` and the more precise `stage` (`release`,
`snapshot`, `pre-release`, or `release-candidate`). It recognizes both newer
IDs such as `26.4-snapshot-4`, `26.3-pre-3`, and `26.3-rc-1` and legacy
week IDs such as `26w14a`. Unknown IDs without a source type are treated as
previews so they cannot silently become the latest stable release.

The Mojang manifest reports versions that can be downloaded. A processed
dataset exists only when `workspace/datasets/<id>/dataset.json` exists.
`DatasetStore.listVersions()` and `GET /versions` report those available
datasets. A consumer should offer only IDs for which its required collection
or published asset is also available. Keep the latest stable release as the
default; offer available previews as explicit choices.
