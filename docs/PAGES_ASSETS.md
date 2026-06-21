# GitHub Pages asset origin

This repo publishes a curated static asset bundle to GitHub Pages for the
pugtools.com mob tools (**Mob Sound Editor** and **Mob Voice Recorder**). Those
tools fetch mob thumbnails, the wiki sound library, and config from here instead
of bundling ~70MB into the pugtools deploy (which is near Cloudflare's file-count
ceiling).

Served origin: `https://actualpugbot.github.io/mc-datahub/`

```
/mob-images/<file>.png|gif      shared mob thumbnails (both tools)
/mob-voice/mob_config.json      Mob Voice Recorder mob sets + version presets
/mob-voice/sounds/index.json    wiki sound library index
/mob-voice/sounds/<mob>/*.ogg   wiki original clips (impression challenge)
```

> Mob Sound Editor streams its *original* clips directly from Mojang's CDN
> (`resources.download.minecraft.net`), so those are **not** hosted here — only
> its mob thumbnails are.

## Regenerate the bundle

The source media lives in sibling working repos (the gitignored `workspace/`
here and the `mob-voice-over` asset repo), so the bundle is generated locally and
**committed** — CI cannot rebuild it.

```bash
# defaults MOB_VOICE_REPO to ~/dev/mob-voice-over
npm run build:pages
# or point at a specific checkout:
MOB_VOICE_REPO=/path/to/mob-voice-over npm run build:pages
```

This writes `pages/` (mob images + wiki sounds + config + a landing page).

## Publish (one-time setup + on update)

1. `npm run build:pages`
2. Commit the `pages/` tree and push to `master`.
3. In GitHub → repo **Settings → Pages → Build and deployment → Source:
   "GitHub Actions"** (one-time).
4. The `Deploy Pages assets` workflow (`.github/workflows/pages.yml`) publishes
   `pages/` on every push that touches it (or via manual "Run workflow").

GitHub Pages serves these with `Access-Control-Allow-Origin: *`, so the tools can
read them cross-origin from both `pugtools.com` (Cloudflare) and
`actualpugbot.github.io/pugtoolsdotcom` (GitHub Pages).

## Consumed by

The pugtools tool packages default their asset base to the origin above and allow
override via the `PUBLIC_MOB_ASSET_BASE` build-time env var (e.g. for local dev
against a localhost asset server).
