/*
 * Assembles the GitHub Pages asset bundle served at
 * https://actualpugbot.github.io/mc-datahub/ for the pugtools.com mob tools
 * (Mob Sound Editor + Mob Voice Recorder).
 *
 * The heavy media lives in sibling working repos (gitignored `workspace/` here,
 * and the mob-voice-over asset repo), so this copies a curated, deduped subtree
 * into a committed `pages/` directory that the Pages workflow publishes.
 *
 * Published layout (URL = origin + path):
 *   pages/index.html                      simple landing page
 *   pages/mob-images/<file>.png|gif       shared mob thumbnails (both tools)
 *   pages/mob-voice/mob_config.json       voice recorder mob sets + presets
 *   pages/mob-voice/sounds/index.json     wiki sound library index
 *   pages/mob-voice/sounds/<mob>/*.ogg    wiki original clips (impression game)
 *   pages/mob-sounds/<hash[0:2]>/<hash>.ogg  game sound objects (content-addressed)
 *
 * The content-addressed `mob-sounds/` store is materialised separately by
 * scripts/download-mob-sounds.mjs (a one-shot pull from Mojang's CDN, then
 * committed). This script only owns the mob-images/ + mob-voice/ subtrees and
 * leaves mob-sounds/ untouched, so the two can run in any order.
 *
 * Usage:
 *   node scripts/build-pages-assets.mjs
 *   MOB_VOICE_REPO=/path/to/mob-voice-over node scripts/build-pages-assets.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const home = os.homedir();

const voiceRepo = process.env.MOB_VOICE_REPO ?? path.join(home, "dev", "mob-voice-over");
const voiceAssets = path.join(voiceRepo, "public", "assets");
const mobsImagesSrc = path.join(voiceAssets, "mobs");
const mobSoundsSrc = path.join(voiceAssets, "mob_sounds");
const mobConfigSrc = path.join(voiceRepo, "public", "mob_config.json");

const pagesDir = path.join(repoRoot, "pages");
const mobImagesDest = path.join(pagesDir, "mob-images");
const mobVoiceDest = path.join(pagesDir, "mob-voice");
const mobVoiceSoundsDest = path.join(mobVoiceDest, "sounds");

function requireDir(label, dir) {
  if (!existsSync(dir)) {
    console.error(`[build-pages-assets] missing ${label}: ${dir}`);
    console.error("  Set MOB_VOICE_REPO to the mob-voice-over checkout, or run its sound-download script first.");
    process.exit(1);
  }
}

requireDir("mob images", mobsImagesSrc);
requireDir("wiki sounds", mobSoundsSrc);

console.log(`[build-pages-assets] repo: ${repoRoot}`);
console.log(`[build-pages-assets] voice repo: ${voiceRepo}`);

// Only clean the subtrees this script owns; the content-addressed mob-sounds/
// store (scripts/download-mob-sounds.mjs) is preserved.
mkdirSync(pagesDir, { recursive: true });
rmSync(mobImagesDest, { recursive: true, force: true });
rmSync(mobVoiceDest, { recursive: true, force: true });
mkdirSync(mobImagesDest, { recursive: true });
mkdirSync(mobVoiceSoundsDest, { recursive: true });

// 1) Shared mob thumbnails (flat png/gif set used by both tools).
cpSync(mobsImagesSrc, mobImagesDest, { recursive: true });
const imageCount = readdirSync(mobImagesDest).length;

// 2) Wiki sound library (per-mob ogg dirs + index.json) for the voice recorder.
cpSync(mobSoundsSrc, mobVoiceSoundsDest, { recursive: true });
let soundCount = 0;
for (const mob of readdirSync(mobVoiceSoundsDest, { withFileTypes: true })) {
  if (mob.isDirectory()) {
    soundCount += readdirSync(path.join(mobVoiceSoundsDest, mob.name)).filter((f) => f.endsWith(".ogg")).length;
  }
}

// 3) Voice recorder config.
if (existsSync(mobConfigSrc)) {
  cpSync(mobConfigSrc, path.join(mobVoiceDest, "mob_config.json"));
}

// 4) Landing page (so the Pages root is not a 404).
writeFileSync(
  path.join(pagesDir, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>mc-datahub assets</title><meta name="robots" content="noindex"></head>
<body style="font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1>mc-datahub assets</h1>
<p>Static asset origin for the pugtools.com mob tools. Cross-origin reads are allowed.</p>
<ul><li><code>/mob-images/</code> — shared mob thumbnails</li>
<li><code>/mob-voice/sounds/</code> — wiki original clips + index.json</li>
<li><code>/mob-voice/mob_config.json</code> — mob sets &amp; version presets</li>
<li><code>/mob-sounds/</code> — content-addressed game sound objects</li></ul>
</body></html>\n`,
);

console.log(`[build-pages-assets] mob images: ${imageCount}`);
console.log(`[build-pages-assets] wiki sounds: ${soundCount}`);
console.log(`[build-pages-assets] wrote ${pagesDir}`);
