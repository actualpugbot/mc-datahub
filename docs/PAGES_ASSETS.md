# Pages asset bundle

`pages/` is a curated static asset bundle for the pugtools.com mob tools
(**Mob Sound Editor**, **Mob Voice Recorder**, Mob Profiles and the quizzes). It
is generated locally and **committed**, because its sources (the gitignored
`workspace/` here and the `mob-voice-over` asset repo) are not available in CI.

```
pages/mob-images/<file>.png|gif         shared mob thumbnails
pages/mob-voice/mob_config.json         Mob Voice Recorder mob sets + version presets
pages/mob-voice/sounds/index.json       wiki sound library index
pages/mob-voice/sounds/<mob>/*.ogg      wiki original clips (impression challenge)
pages/mob-sounds/<hash[0:2]>/<hash>.ogg game sound objects (content-addressed)
```

## Regenerate the bundle

```bash
# defaults MOB_VOICE_REPO to ~/dev/mob-voice-over
npm run build:pages
# or point at a specific checkout:
MOB_VOICE_REPO=/path/to/mob-voice-over npm run build:pages
```

This writes the `mob-images/` and `mob-voice/` subtrees. The `mob-sounds/`
store is materialised separately by `scripts/download-mob-sounds.mjs`. Commit
the result and push to `master`.

## Consumed by

pugtools.com does not hot-link a hosted copy. Its build copies what it needs
into its own `apps/web/public/` (see pugtools `scripts/build-mob-sound-assets.mjs`),
so every asset is served same-origin. The one exception is the Mob Voice
Recorder, which falls back per file to the raw GitHub mirror of this repo
(`https://raw.githubusercontent.com/actualpugbot/mc-datahub/master/pages/...`)
for wiki clips outside its bundled trim. Moving or renaming anything under
`pages/mob-voice/sounds/` on `master` breaks that fallback.

There is no GitHub Pages site. The old Pages workflow never deployed (Pages was
never enabled on the repo) and was removed.
