/**
 * Block placement and break sounds, read out of the decompiled client.
 *
 * Three files have to be joined to answer "what does this block sound like":
 *
 *  - `SoundType.java` holds the ~130 sound-type constants, each carrying a
 *    volume, a pitch and the five sound events (break/step/place/hit/fall).
 *  - `SoundEvents.java` turns those event constants into the ids you would pass
 *    to `/playsound`, e.g. `SoundEvents.WOOD_PLACE` -> `block.wood.place`.
 *  - the processed dataset's `block-properties` says which sound type each
 *    block picked, already resolved through `.ofFullCopy()` inheritance.
 *
 * The event id is read rather than derived from the constant's name, because
 * the two disagree: `SoundType.LILY_PAD` places `block.lily_pad.place` but
 * breaks with `block.big_dripleaf.break`. Guessing from the name would be right
 * most of the time and quietly wrong for the rest.
 */
import type { BlockPropertyDefinition } from "../domain/types.js";

/**
 * `BlockBehaviour.Properties.soundType` is initialised to `SoundType.STONE`, so
 * a block that never calls `.sound(...)` is a stone-sounding block rather than
 * a silent one.
 */
export const DEFAULT_SOUND_TYPE = "stone";

/** How the game actually plays one of these events. */
export interface SoundPlayback {
  /** Sound event id, e.g. `block.wood.place`. */
  event: string;
  /** Volume the game passes to `playSound`, already worked out. */
  volume: number;
  /** Pitch the game passes to `playSound`, already worked out. */
  pitch: number;
}

export interface SoundTypeDefinition {
  /** Lowercased constant name, matching `block-properties`' `soundType`. */
  id: string;
  /** The constant's own volume, before the placement formula. */
  volume: number;
  /** The constant's own pitch, before the placement formula. */
  pitch: number;
  place?: SoundPlayback;
  break?: SoundPlayback;
  /** Remaining events, as raw ids; nothing here derives a playback for them. */
  step?: string;
  hit?: string;
  fall?: string;
}

export interface BlockSoundsDataset {
  version: string;
  generatedAt: string;
  defaultSoundType: string;
  soundTypes: SoundTypeDefinition[];
  /** Block id -> sound type id. Every registered block appears exactly once. */
  blocks: Record<string, string>;
}

/**
 * Volume the game plays a block place or break at. Both use the same formula:
 * `BlockItem.place` and `LevelEventHandler`'s 2001 event each pass
 * `(soundType.getVolume() + 1) / 2`.
 */
export function playbackVolume(soundTypeVolume: number): number {
  return (soundTypeVolume + 1) / 2;
}

/** Pitch the game plays a block place or break at: the type's pitch * 0.8. */
export function playbackPitch(soundTypePitch: number): number {
  return soundTypePitch * 0.8;
}

/**
 * `public static final SoundEvent WOOD_PLACE = register("block.wood.place");`
 * Every constant in the file uses this one shape.
 */
const SOUND_EVENT_PATTERN = /public\s+static\s+final\s+SoundEvent\s+(\w+)\s*=\s*register\(\s*"([^"]+)"/g;

export function parseSoundEventIds(source: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const match of source.matchAll(SOUND_EVENT_PATTERN)) {
    const [, constant, id] = match;
    if (constant && id) {
      ids.set(constant, id);
    }
  }
  return ids;
}

/**
 * `public static final SoundType WOOL = new SoundType(1.0F, 1.0F, SoundEvents.WOOL_BREAK, ...)`
 * The decompiler wraps long argument lists over several lines, so the body is
 * matched lazily up to the closing paren rather than line by line.
 */
const SOUND_TYPE_PATTERN = /public\s+static\s+final\s+SoundType\s+(\w+)\s*=\s*new\s+SoundType\(([\s\S]*?)\);/g;

/** Constructor order: volume, pitch, break, step, place, hit, fall. */
const CONSTRUCTOR_ARITY = 7;

export interface SoundTypeParseResult {
  soundTypes: SoundTypeDefinition[];
  /** Constants that could not be resolved, for the caller to report. */
  skipped: string[];
}

/** Newer versions register sound sets as data-pack JSON in the client jar. */
export function parseBlockSoundSetData(entries: Array<{ path: string; raw: Record<string, unknown> }>): SoundTypeParseResult {
  const soundTypes: SoundTypeDefinition[] = [];
  const skipped: string[] = [];
  for (const { path, raw } of entries) {
    const id = /(?:^|\/)block_sound_set\/([a-z0-9_]+)\.json$/.exec(path)?.[1];
    if (!id) continue;
    const volume = typeof raw.volume === "number" ? raw.volume : 1;
    const pitch = typeof raw.pitch === "number" ? raw.pitch : 1;
    const event = (key: string): string | undefined => {
      const value = raw[key];
      return typeof value === "string" ? value.replace(/^minecraft:/, "") : undefined;
    };
    const place = event("place_sound");
    const broken = event("break_sound");
    if (!place && !broken) {
      skipped.push(id);
      continue;
    }
    soundTypes.push({
      id,
      volume,
      pitch,
      ...(place ? { place: { event: place, volume: playbackVolume(volume), pitch: playbackPitch(pitch) } } : {}),
      ...(broken ? { break: { event: broken, volume: playbackVolume(volume), pitch: playbackPitch(pitch) } } : {}),
      ...(event("step_sound") ? { step: event("step_sound") } : {}),
      ...(event("hit_sound") ? { hit: event("hit_sound") } : {}),
      ...(event("fall_sound") ? { fall: event("fall_sound") } : {}),
    });
  }
  soundTypes.sort((a, b) => a.id.localeCompare(b.id));
  return { soundTypes, skipped };
}

export function parseSoundTypes(source: string, eventIds: Map<string, string>): SoundTypeParseResult {
  const soundTypes: SoundTypeDefinition[] = [];
  const skipped: string[] = [];

  for (const match of source.matchAll(SOUND_TYPE_PATTERN)) {
    const [, constant, body] = match;
    if (!constant || body === undefined) {
      continue;
    }

    const args = body
      .split(",")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    if (args.length !== CONSTRUCTOR_ARITY) {
      skipped.push(constant);
      continue;
    }

    const volume = parseJavaFloat(args[0]);
    const pitch = parseJavaFloat(args[1]);
    const events = args.slice(2).map((argument) => eventIds.get(stripSoundEventsPrefix(argument)));
    if (volume === undefined || pitch === undefined || events.some((event) => event === undefined)) {
      skipped.push(constant);
      continue;
    }

    const [breakSound, stepSound, placeSound, hitSound, fallSound] = events as [string, string, string, string, string];
    soundTypes.push({
      id: constant.toLowerCase(),
      volume,
      pitch,
      place: { event: placeSound, volume: playbackVolume(volume), pitch: playbackPitch(pitch) },
      break: { event: breakSound, volume: playbackVolume(volume), pitch: playbackPitch(pitch) },
      step: stepSound,
      hit: hitSound,
      fall: fallSound,
    });
  }

  soundTypes.sort((left, right) => left.id.localeCompare(right.id));
  return { soundTypes, skipped };
}

function stripSoundEventsPrefix(argument: string): string {
  return argument.startsWith("SoundEvents.") ? argument.slice("SoundEvents.".length) : argument;
}

/** `1.0F`, `0.3f`, `1.5` — the decompiler emits float literals with a suffix. */
function parseJavaFloat(literal: string | undefined): number | undefined {
  if (!literal) {
    return undefined;
  }
  const value = Number.parseFloat(literal.replace(/[fFdD]$/, ""));
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Set-type overrides
//
// Doors, trapdoors, buttons, pressure plates, signs, hanging signs and fence
// gates never call `.sound(...)` in `Blocks.java`. Their constructors do it
// instead - `super(properties.sound(type.soundType()))` - with a BlockSetType
// or WoodType passed in the registration lambda. A property-chain scan cannot
// see that, so without this pass an acacia door would be reported as stone.
// ---------------------------------------------------------------------------

export type SetTypeRecord = "BlockSetType" | "WoodType";

/** Which accessor a block class feeds into `properties.sound(...)`. */
export type SoundAccessor = "soundType" | "hangingSignSoundType";

/**
 * Sound types a short constructor falls back to. Both records delegate their
 * one/two-argument constructor to the full one with these literals:
 * `new BlockSetType("acacia")` is WOOD, and `new WoodType("oak", ...)` is WOOD
 * with HANGING_SIGN for its hanging signs.
 */
const SET_TYPE_DEFAULTS: Record<SetTypeRecord, Record<SoundAccessor, string>> = {
  BlockSetType: { soundType: "wood", hangingSignSoundType: "wood" },
  WoodType: { soundType: "wood", hangingSignSoundType: "hanging_sign" },
};

/**
 * Sound types per set-type constant. Each record takes its sound types as the
 * only `SoundType.X` arguments, in declaration order (`soundType` first, then
 * `hangingSignSoundType` for WoodType), so reading them positionally is exact.
 */
export function parseSetTypeSounds(source: string, record: SetTypeRecord): Map<string, Record<SoundAccessor, string>> {
  const pattern = new RegExp(
    `public\\s+static\\s+final\\s+${record}\\s+(\\w+)\\s*=\\s*register\\(\\s*new\\s+${record}\\(([\\s\\S]*?)\\)\\s*\\);`,
    "g",
  );
  const result = new Map<string, Record<SoundAccessor, string>>();
  for (const match of source.matchAll(pattern)) {
    const [, constant, body] = match;
    if (!constant || body === undefined) {
      continue;
    }
    const soundTypes = [...body.matchAll(/(?:SoundType|BlockSoundSets)\.(\w+)/g)].map((found) => found[1]!.toLowerCase());
    const defaults = SET_TYPE_DEFAULTS[record];
    result.set(constant, {
      soundType: soundTypes[0] ?? defaults.soundType,
      hangingSignSoundType: soundTypes[1] ?? soundTypes[0] ?? defaults.hangingSignSoundType,
    });
  }
  return result;
}

/**
 * Block classes whose constructor overrides the sound from a set type, plus
 * every subclass of them (a WeatheringCopperDoorBlock is still a DoorBlock).
 *
 * `classSources` maps a simple class name to its decompiled source.
 */
export function parseSoundOverrideClasses(classSources: Map<string, string>): Map<string, SoundAccessor> {
  const overrides = new Map<string, SoundAccessor>();
  const parents = new Map<string, string>();
  for (const [name, source] of classSources) {
    if (/properties\.sound\(\s*type\.(?:hangingSignSoundType|hangingSignSoundSet)\(\)\s*\)/.test(source)) {
      overrides.set(name, "hangingSignSoundType");
    } else if (/properties\.sound\(\s*type\.(?:soundType|blockSoundSet)\(\)\s*\)/.test(source)) {
      overrides.set(name, "soundType");
    }
    const parent = new RegExp(`class\\s+${name}\\b[^{]*?\\bextends\\s+(\\w+)`).exec(source)?.[1];
    if (parent) {
      parents.set(name, parent);
    }
  }
  // Walk each class up its parent chain until it reaches an overriding class.
  for (const name of classSources.keys()) {
    if (overrides.has(name)) {
      continue;
    }
    const seen = new Set<string>();
    let current = parents.get(name);
    while (current && !seen.has(current)) {
      seen.add(current);
      const accessor = overrides.get(current);
      if (accessor) {
        overrides.set(name, accessor);
        break;
      }
      current = parents.get(current);
    }
  }
  return overrides;
}

export interface SetTypeRef {
  record: SetTypeRecord;
  constant: string;
}

export interface RegistrationTypes {
  /** Symbol of a plain `Block X = register(...)` statement -> its set type. */
  exact: Map<string, SetTypeRef>;
  /** Symbol of a `WeatheringCopperCollection` statement -> its set type. */
  collections: Map<string, SetTypeRef>;
}

/**
 * The set type each `Blocks.java` registration passes to its block class.
 * Statements are cut at the next class-level declaration so a helper method
 * after the last constant can never lend its type to that constant.
 */
export function parseRegistrationTypes(blocksSource: string): RegistrationTypes {
  const exact = new Map<string, SetTypeRef>();
  const collections = new Map<string, SetTypeRef>();
  const statements = blocksSource.split(/\n(?=\s{3}(?:public|private|protected)?\s*static\s)/);
  for (const statement of statements) {
    const header = /^\s*public\s+static\s+final\s+([\w<>]+)\s+(\w+)\s*=/.exec(statement);
    if (!header) {
      continue;
    }
    const [, declaredType, symbol] = header;
    // Any argument position: weighted pressure plates pass their redstone
    // weight first, `new WeightedPressurePlateBlock(15, BlockSetType.GOLD, p)`.
    const ref = /new\s+\w+\([^)]*?\b(BlockSetType|WoodType)\.(\w+)/.exec(statement);
    if (!declaredType || !symbol || !ref) {
      continue;
    }
    const value: SetTypeRef = { record: ref[1] as SetTypeRecord, constant: ref[2]! };
    if (declaredType.startsWith("WeatheringCopperCollection")) {
      collections.set(symbol, value);
    } else {
      exact.set(symbol, value);
    }
  }
  return { exact, collections };
}

/** Prefixes a copper collection adds to its base symbol, in any combination. */
const COPPER_VARIANT_PREFIX = /^(?:(?:WAXED|EXPOSED|WEATHERED|OXIDIZED)_)+$/;

/**
 * The registration a block came from: an exact symbol match first, otherwise a
 * copper collection whose symbol this block's symbol extends with nothing but
 * weathering/waxing prefixes. Requiring those exact prefixes is what stops
 * `OAK_DOOR` from ever claiming `DARK_OAK_DOOR`.
 */
export function resolveRegistrationType(symbol: string, registrations: RegistrationTypes): SetTypeRef | undefined {
  const direct = registrations.exact.get(symbol);
  if (direct) {
    return direct;
  }
  for (const [base, ref] of registrations.collections) {
    if (symbol === base) {
      return ref;
    }
    if (symbol.endsWith(`_${base}`) && COPPER_VARIANT_PREFIX.test(symbol.slice(0, symbol.length - base.length))) {
      return ref;
    }
  }
  return undefined;
}

export interface SetTypeSources {
  blockSetTypeSource: string;
  woodTypeSource: string;
  blocksSource: string;
  /** Simple class name -> decompiled source, for every class in the block package. */
  blockClassSources: Map<string, string>;
}

export interface BuildBlockSoundsResult {
  dataset: BlockSoundsDataset;
  /** Sound-type constants whose arguments did not parse. */
  skippedSoundTypes: string[];
  /** Blocks whose declared sound type is not in `SoundType.java`. */
  unknownSoundTypes: string[];
  /** Blocks that fell back to the STONE default. */
  defaultedBlocks: string[];
  /** Blocks whose sound came from their BlockSetType/WoodType. */
  setTypeOverrides: string[];
  /**
   * Blocks built from an overriding class whose set type could not be found.
   * Non-empty means the registration shape moved; these keep their declared or
   * default sound rather than a guess.
   */
  unresolvedSetTypes: string[];
}

/**
 * Join the sound-type table with each block's declared type.
 *
 * `blockIds` is the authoritative block list (the registry), so the result
 * covers every block rather than only the ones that set a sound explicitly.
 */
export function buildBlockSounds(
  version: string,
  soundTypeSource: string,
  soundEventsSource: string,
  blockProperties: BlockPropertyDefinition[],
  blockIds: string[],
  setTypes?: SetTypeSources,
  registrySoundTypes?: SoundTypeParseResult,
): BuildBlockSoundsResult {
  const eventIds = parseSoundEventIds(soundEventsSource);
  const { soundTypes, skipped } = registrySoundTypes ?? parseSoundTypes(soundTypeSource, eventIds);
  const known = new Set(soundTypes.map((soundType) => soundType.id));

  const declared = new Map<string, string>();
  for (const definition of blockProperties) {
    if (definition.soundType) {
      declared.set(definition.id, definition.soundType.toLowerCase());
    }
  }

  // The constructor's `properties.sound(type.soundType())` runs after the
  // property chain, so a set type wins over anything declared in Blocks.java.
  const setTypeOverrides: string[] = [];
  const unresolvedSetTypes: string[] = [];
  if (setTypes) {
    const typeTables: Record<SetTypeRecord, Map<string, Record<SoundAccessor, string>>> = {
      BlockSetType: parseSetTypeSounds(setTypes.blockSetTypeSource, "BlockSetType"),
      WoodType: parseSetTypeSounds(setTypes.woodTypeSource, "WoodType"),
    };
    const overrideClasses = parseSoundOverrideClasses(setTypes.blockClassSources);
    const registrations = parseRegistrationTypes(setTypes.blocksSource);

    for (const definition of blockProperties) {
      const accessor = definition.implementationClass ? overrideClasses.get(definition.implementationClass) : undefined;
      if (!accessor) {
        continue;
      }
      const ref = resolveRegistrationType(definition.sourceSymbol, registrations);
      const soundType = ref ? typeTables[ref.record].get(ref.constant)?.[accessor] : undefined;
      if (!soundType) {
        unresolvedSetTypes.push(definition.id);
        continue;
      }
      declared.set(definition.id, soundType);
      setTypeOverrides.push(definition.id);
    }
  }

  const blocks: Record<string, string> = {};
  const unknownSoundTypes: string[] = [];
  const defaultedBlocks: string[] = [];

  for (const id of [...blockIds].sort()) {
    const soundType = declared.get(id);
    if (!soundType) {
      blocks[id] = DEFAULT_SOUND_TYPE;
      defaultedBlocks.push(id);
      continue;
    }
    if (!known.has(soundType)) {
      // Never silently substitute: an unresolved type is reported so a future
      // source change shows up as a count instead of a wrong sound.
      unknownSoundTypes.push(id);
      blocks[id] = DEFAULT_SOUND_TYPE;
      continue;
    }
    blocks[id] = soundType;
  }

  return {
    dataset: {
      version,
      generatedAt: new Date().toISOString(),
      defaultSoundType: DEFAULT_SOUND_TYPE,
      soundTypes,
      blocks,
    },
    skippedSoundTypes: skipped,
    unknownSoundTypes,
    defaultedBlocks,
    setTypeOverrides: setTypeOverrides.sort(),
    unresolvedSetTypes: unresolvedSetTypes.sort(),
  };
}
