import type { ArchiveSource } from "../archive/archiveSource.js";
import type { JsonValue } from "../domain/types.js";

const JUKEBOX_SONG_PREFIX = "data/minecraft/jukebox_song/";

/**
 * One entry of the `jukebox_song` data registry (the per-disc metadata the
 * game itself uses: track length, redstone comparator output and the sound
 * event a jukebox plays). The owning music disc item is derived from the
 * registry key: every vanilla song `<key>` is played by `music_disc_<key>`.
 */
export interface JukeboxSongDefinition {
  id: string;
  key: string;
  itemId: string;
  translationKey: string;
  lengthInSeconds: number;
  comparatorOutput: number;
  soundEvent: string;
  sourcePath: string;
}

/**
 * Read every `data/minecraft/jukebox_song/*.json` registry file from the
 * game archives. Entries missing the required fields are skipped rather than
 * guessed at, so a future format change surfaces as a count drop instead of
 * corrupt data.
 */
export async function buildJukeboxSongs(paths: string[], source: ArchiveSource): Promise<JukeboxSongDefinition[]> {
  const songPaths = paths.filter((path) => path.startsWith(JUKEBOX_SONG_PREFIX) && path.endsWith(".json")).sort();
  const songs: JukeboxSongDefinition[] = [];

  for (const path of songPaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw)) {
      continue;
    }

    const lengthInSeconds = typeof raw.length_in_seconds === "number" ? raw.length_in_seconds : undefined;
    const comparatorOutput = typeof raw.comparator_output === "number" ? raw.comparator_output : undefined;
    const soundEvent = readSoundEvent(raw.sound_event);
    const translationKey = readTranslationKey(raw.description);
    if (lengthInSeconds === undefined || comparatorOutput === undefined || !soundEvent || !translationKey) {
      continue;
    }

    const key = path.slice(JUKEBOX_SONG_PREFIX.length, path.length - ".json".length);
    songs.push({
      id: `minecraft:${key}`,
      key,
      itemId: `minecraft:music_disc_${key}`,
      translationKey,
      lengthInSeconds,
      comparatorOutput,
      soundEvent,
      sourcePath: path,
    });
  }

  return songs.sort((left, right) => left.key.localeCompare(right.key));
}

function readSoundEvent(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return normalizeId(value);
  }
  // Inline sound event definitions carry the id under `sound_id`.
  if (isRecord(value) && typeof value.sound_id === "string") {
    return normalizeId(value.sound_id);
  }
  return undefined;
}

function readTranslationKey(value: JsonValue | undefined): string | undefined {
  if (isRecord(value) && typeof value.translate === "string") {
    return value.translate;
  }
  return undefined;
}

function normalizeId(value: string): string {
  return value.includes(":") ? value : `minecraft:${value}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
