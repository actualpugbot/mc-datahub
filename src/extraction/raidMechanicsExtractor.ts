import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  RaidAttributeOverride,
  RaidBonusCap,
  RaidBonusSpawnRule,
  RaidCountProbability,
  RaidDifficulty,
  RaidDuration,
  RaidEnchantmentProvider,
  RaidEnvironmentAttribute,
  RaidMechanicsDataset,
  RaidOminousBottleSource,
  RaidRaiderBuffs,
  RaidRaiderInfo,
  RaidRiderRule,
  RaidRosterDifficulty,
  RaidRosterEntry,
  RaidRosterRider,
  RaidRosterWave,
  RaidRule,
} from "../domain/types.js";

const RAID = "net/minecraft/world/entity/raid/Raid.java";
const RAIDS = "net/minecraft/world/entity/raid/Raids.java";
const RAIDER = "net/minecraft/world/entity/raid/Raider.java";
const PATROLLING_MONSTER = "net/minecraft/world/entity/monster/PatrollingMonster.java";
const BAD_OMEN = "net/minecraft/world/effect/BadOmenMobEffect.java";
const RAID_OMEN = "net/minecraft/world/effect/RaidOmenMobEffect.java";
const BOTTLE_COMPONENT = "net/minecraft/world/item/component/OminousBottleAmplifier.java";
const BOTTLE_FUNCTION = "net/minecraft/world/level/storage/loot/functions/SetOminousBottleAmplifierFunction.java";
const TRIAL_SPAWNER_STATE = "net/minecraft/world/level/block/entity/trialspawner/TrialSpawnerStateData.java";
const ENCHANTMENT_PROVIDERS = "net/minecraft/world/item/enchantment/providers/VanillaEnchantmentProviders.java";
const BANNER_PATTERNS = "net/minecraft/world/level/block/entity/BannerPatterns.java";
const VILLAGER_PATHS = ["net/minecraft/world/entity/npc/villager/Villager.java", "net/minecraft/world/entity/npc/Villager.java"];
const GIVE_GIFT = "net/minecraft/world/entity/ai/behavior/GiveGiftToHero.java";
const VILLAGER_GOAL_PACKAGES = "net/minecraft/world/entity/ai/behavior/VillagerGoalPackages.java";
const BUILT_IN_LOOT_TABLES = "net/minecraft/world/level/storage/loot/BuiltInLootTables.java";
const PATROL_SPAWNER = "net/minecraft/world/level/levelgen/PatrolSpawner.java";
const DIFFICULTY_INSTANCE = "net/minecraft/world/DifficultyInstance.java";
const SERVER_LEVEL = "net/minecraft/server/level/ServerLevel.java";
const ENVIRONMENT_ATTRIBUTES = "net/minecraft/world/attribute/EnvironmentAttributes.java";
const STATS = "net/minecraft/stats/Stats.java";
const CRITERIA_TRIGGERS = "net/minecraft/advancements/triggers/CriteriaTriggers.java";
const SOUND_EVENTS = "net/minecraft/sounds/SoundEvents.java";
const RAIDERS_TAG = "data/minecraft/tags/entity_type/raiders.json";
const LOOT_TABLE_DIR = "data/minecraft/loot_table";
const ADVANCEMENTS = ["adventure/voluntary_exile", "adventure/hero_of_the_village"];
const RAIDER_CLASSES: Record<string, string> = {
  evoker: "net/minecraft/world/entity/monster/illager/Evoker.java",
  illusioner: "net/minecraft/world/entity/monster/illager/Illusioner.java",
  pillager: "net/minecraft/world/entity/monster/illager/Pillager.java",
  vindicator: "net/minecraft/world/entity/monster/illager/Vindicator.java",
  witch: "net/minecraft/world/entity/monster/Witch.java",
  ravager: "net/minecraft/world/entity/monster/Ravager.java",
};
const DIFFICULTIES: RaidDifficulty[] = ["easy", "normal", "hard"];

/** Reads source files once, records which ones were used, and turns failed seams into warnings. */
class SourceReader {
  readonly sourcePaths: string[] = [];
  readonly warnings: string[] = [];
  private readonly cache = new Map<string, string>();

  constructor(readonly root: string) {}

  async text(path: string): Promise<string> {
    const cached = this.cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const full = join(this.root, path);
    let text = "";
    if (await fileExists(full)) {
      text = await readFile(full, "utf8");
      this.sourcePaths.push(path);
    } else {
      this.warnings.push(`${path} was not found.`);
    }
    this.cache.set(path, text);
    return text;
  }

  async firstExisting(paths: string[]): Promise<string> {
    for (const path of paths) {
      if (await fileExists(join(this.root, path))) {
        return this.text(path);
      }
    }
    this.warnings.push(`None of ${paths.join(", ")} was found.`);
    return "";
  }

  async json<T>(path: string): Promise<T | undefined> {
    const text = await this.text(path);
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      this.warnings.push(`Could not parse ${path}: ${(error as Error).message}.`);
      return undefined;
    }
  }

  /** First capture group of `pattern` as a number, or undefined plus a warning naming the seam. */
  num(source: string, pattern: RegExp, label: string, group = 1): number | undefined {
    const value = this.match(source, pattern, label)?.[group];
    return value === undefined ? undefined : Number(value);
  }

  str(source: string, pattern: RegExp, label: string, group = 1): string | undefined {
    return this.match(source, pattern, label)?.[group];
  }

  match(source: string, pattern: RegExp, label: string): RegExpMatchArray | undefined {
    const found = source.match(pattern);
    if (!found) {
      this.warnings.push(`Seam not found: ${label}.`);
      return undefined;
    }
    return found;
  }

  /** `static final int NAME = N;` */
  int(source: string, name: string, label: string): number | undefined {
    return this.num(source, new RegExp(`static\\s+final\\s+int\\s+${name}\\s*=\\s*(-?\\d+)\\s*;`), `${label} ${name}`);
  }

  /** Records a rule only after confirming its code still reads the same way. */
  check(source: string, pattern: RegExp | string, label: string): boolean {
    const ok = typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
    if (!ok) {
      this.warnings.push(`Seam not found: ${label}.`);
    }
    return ok;
  }
}

/**
 * Derives raid mechanics from Raid.java and its collaborators (Raids, Raider, the omen effects, the raider
 * subclasses' applyRaidBuffs, Villager hero discounts, GiveGiftToHero, PatrolSpawner) plus the data files they
 * reference (enchantment providers, loot tables, environment attribute overrides, advancements). Every number is
 * parsed from source; the roster table is then computed exactly from the parsed spawn arrays and bonus rules.
 */
export class RaidMechanicsExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(decompiledClientRoot: string): Promise<RaidMechanicsDataset | undefined> {
    if (!(await fileExists(join(decompiledClientRoot, RAID)))) {
      this.logger.warn(`Skipping raid mechanics; ${RAID} was not found under ${decompiledClientRoot}.`);
      return undefined;
    }

    const r = new SourceReader(decompiledClientRoot);
    const raid = await r.text(RAID);
    const raids = await r.text(RAIDS);
    const raider = await r.text(RAIDER);

    const numGroupsByDifficulty: Record<string, number> = {};
    for (const match of methodBody(raid, "getNumGroups").matchAll(/case\s+(\w+)\s*->\s*(\d+)\s*;/g)) {
      numGroupsByDifficulty[match[1]!.toLowerCase()] = Number(match[2]);
    }
    if (DIFFICULTIES.some((difficulty) => numGroupsByDifficulty[difficulty] === undefined)) {
      r.warnings.push("Seam not found: Raid.getNumGroups difficulty switch.");
    }
    const groupsFor = (constant: string): number => numGroupsByDifficulty[constant.toLowerCase()] ?? Number.NaN;

    const spawnOrder: string[] = [];
    const spawnsPerWaveBeforeBonus: Record<string, number[]> = {};
    const entityIds: Record<string, string> = {};
    for (const match of raid.matchAll(/(\w+)\(EntityTypes\.(\w+),\s*new int\[\]\s*\{([^}]*)\}\)/g)) {
      const key = match[1]!.toLowerCase();
      spawnOrder.push(key);
      entityIds[key] = `minecraft:${match[2]!.toLowerCase()}`;
      spawnsPerWaveBeforeBonus[key] = match[3]!
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number);
    }
    if (spawnOrder.length === 0) {
      r.warnings.push("Seam not found: Raid.RaiderType spawnsPerWaveBeforeBonus arrays.");
    }

    const maxRaidOmenLevel =
      r.num(raid, /getMaxRaidOmenLevel\(\)\s*\{\s*return\s+(\d+)\s*;/, "Raid.getMaxRaidOmenLevel") ??
      r.int(raid, "DEFAULT_MAX_RAID_OMEN_LEVEL", "Raid");
    const bonusWaveAbove = r.num(
      raid,
      /hasBonusWave\(\)\s*\{\s*return\s+this\.raidOmenLevel\s*>\s*(\d+)\s*;/,
      "Raid.hasBonusWave",
    );
    const bonusWaveMinLevel = bonusWaveAbove === undefined ? undefined : bonusWaveAbove + 1;
    r.check(
      raid,
      /isBonusWave\s*\?\s*type\.spawnsPerWaveBeforeBonus\[this\.numGroups\]\s*:\s*type\.spawnsPerWaveBeforeBonus\[wav\]/,
      "Raid.getDefaultNumSpawns bonus index",
    );

    const enchantOdds = this.readEnchantOdds(r, raid, maxRaidOmenLevel ?? 0);
    const bonusRules = this.readBonusRules(r, raid, spawnOrder);
    const riderRules = this.readRiderRules(r, raid, groupsFor);
    const canBeLeader = await this.readCanBeLeader(r, spawnOrder);
    const rosterTable = this.buildRosterTable(
      numGroupsByDifficulty,
      spawnOrder,
      spawnsPerWaveBeforeBonus,
      bonusRules,
      riderRules,
      canBeLeader,
      bonusWaveMinLevel ?? Number.NaN,
    );

    const providers = await this.readProviders(r);
    const raidersTag = (await r.json<{ values?: unknown[] }>(RAIDERS_TAG))?.values ?? [];
    const raiderIds = raidersTag.filter((value): value is string => typeof value === "string");
    const { raiders, byRaider } = await this.readRaiders(
      r,
      raiderIds,
      spawnOrder,
      spawnsPerWaveBeforeBonus,
      providers,
      groupsFor,
    );

    const heroDuration = r.num(
      raid,
      /MobEffects\.HERO_OF_THE_VILLAGE,\s*(\d+),\s*this\.raidOmenLevel\s*-\s*\d+/,
      "Raid hero effect duration",
    );
    const heroAmplifierOffset = r.num(
      raid,
      /MobEffects\.HERO_OF_THE_VILLAGE,\s*\d+,\s*this\.raidOmenLevel\s*-\s*(\d+)/,
      "Raid hero amplifier",
    );
    const hero = await this.readHero(r, heroDuration, heroAmplifierOffset, maxRaidOmenLevel);
    const omen = await this.readOmen(
      r,
      raid,
      raids,
      maxRaidOmenLevel,
      bonusWaveMinLevel,
      enchantOdds,
      heroAmplifierOffset,
      hero.discount.byAmplifier,
    );

    const dataset: RaidMechanicsDataset = {
      waves: {
        numGroupsByDifficulty,
        spawnOrder,
        spawnsPerWaveBeforeBonus,
        bonusWave: {
          requiresRaidOmenLevelAtLeast: bonusWaveMinLevel,
          groupNumber: "numGroups + 1",
          countsFromIndex: "numGroups (the bonus wave reuses the final wave's fixed counts)",
        },
        rules: this.waveRules(r, raid, numGroupsByDifficulty),
      },
      bonusSpawns: {
        formula: "extra = cap > 0 ? random.nextInt(cap + 1) : 0, rolled independently per raider type per wave",
        rules: bonusRules,
      },
      rosterTable,
      riders: {
        rules: riderRules,
        notes: [
          "Riders are extra raiders on top of the roster counts: one per ravager when a rule matches, spawned riding it.",
          "Rider thresholds compare the group number against another difficulty's numGroups, so they do not scale with the raid's own difficulty.",
          "Riders join the raid through joinRaid, so they get finalizeSpawn and applyRaidBuffs like any wave raider, but they are never picked as captain.",
        ],
      },
      captain: await this.readCaptain(r, raid, raider),
      omen,
      enchantments: {
        oddsByRaidOmenLevel: enchantOdds,
        byRaider,
        providers,
        notes: [
          "enchantOdds is read from the raid's current raid omen level when each raider spawns.",
          "Only raiders spawned by the raid itself (joinRaid with a spawn position) receive applyRaidBuffs; raiders that wander in and join do not.",
          "The isCaptain argument of applyRaidBuffs is always false from Raid.joinRaid and no raider reads it.",
        ],
      },
      timers: this.readTimers(r, raid, raider, raids),
      geometry: await this.readGeometry(r, raid, raids),
      outcomes: this.readOutcomes(r, raid, raids),
      hero,
      patrols: await this.readPatrols(r),
      raiders,
      progression: await this.readProgression(r),
      sourcePaths: r.sourcePaths,
      warnings: r.warnings,
    };

    for (const warning of r.warnings) {
      this.logger.warn(`Raid mechanics: ${warning}`);
    }
    return dataset;
  }

  private readEnchantOdds(r: SourceReader, raid: string, maxLevel: number): Array<{ raidOmenLevel: number; odds: number }> {
    const body = methodBody(raid, "getEnchantOdds");
    const byLevel = new Map<number, number>();
    for (const match of body.matchAll(/==\s*(\d+)\s*\)?\s*(?:\{\s*return|\?)\s*([\d.]+)F/g)) {
      byLevel.set(Number(match[1]), Number(match[2]));
    }
    const fallback = r.num(body, /\?\s*[\d.]+F\s*:\s*([\d.]+)F\s*;/, "Raid.getEnchantOdds fallback");
    if (byLevel.size === 0) {
      r.warnings.push("Seam not found: Raid.getEnchantOdds level branches.");
    }
    return range(1, maxLevel).map((level) => ({ raidOmenLevel: level, odds: byLevel.get(level) ?? fallback ?? 0 }));
  }

  private readBonusRules(r: SourceReader, raid: string, spawnOrder: string[]): RaidBonusSpawnRule[] {
    const body = methodBody(raid, "getPotentialBonusSpawns");
    const rules = new Map<string, RaidBonusSpawnRule>();
    const labels = (text: string) => Array.from(text.matchAll(/case\s+(\w+)\s*:/g), (m) => m[1]!.toLowerCase());
    const constant = (value: number): RaidBonusCap => ({ constant: value });

    const tiered = body.match(
      /((?:case\s+\w+\s*:\s*)+)if\s*\(isEasy\)\s*\{\s*bonusSpawns\s*=\s*random\.nextInt\((\d+)\);\s*\}\s*else\s+if\s*\(isNormal\)\s*\{\s*bonusSpawns\s*=\s*(\d+);\s*\}\s*else\s*\{\s*bonusSpawns\s*=\s*(\d+);/,
    );
    if (tiered) {
      for (const key of labels(tiered[1]!)) {
        rules.set(key, {
          raider: key,
          capByDifficulty: {
            easy: { uniformBelow: Number(tiered[2]) },
            normal: constant(Number(tiered[3])),
            hard: constant(Number(tiered[4])),
          },
        });
      }
    }

    const waveGated = body.match(
      /((?:case\s+\w+\s*:\s*)+)if\s*\(isEasy\s*\|\|\s*wav\s*<=\s*(\d+)\s*\|\|\s*wav\s*==\s*(\d+)\)\s*\{\s*return\s+0;\s*\}\s*bonusSpawns\s*=\s*(\d+);/,
    );
    if (waveGated) {
      const cap = Number(waveGated[4]);
      for (const key of labels(waveGated[1]!)) {
        rules.set(key, {
          raider: key,
          capByDifficulty: { easy: constant(0), normal: constant(cap), hard: constant(cap) },
          zeroOnWaves: { atMost: Number(waveGated[2]), equals: [Number(waveGated[3])] },
        });
      }
    }

    const bonusOnly = body.match(/((?:case\s+\w+\s*:\s*)+)bonusSpawns\s*=\s*!isEasy\s*&&\s*isBonusWave\s*\?\s*(\d+)\s*:\s*0\s*;/);
    if (bonusOnly) {
      const cap = Number(bonusOnly[2]);
      for (const key of labels(bonusOnly[1]!)) {
        rules.set(key, {
          raider: key,
          capByDifficulty: { easy: constant(0), normal: constant(cap), hard: constant(cap) },
          onlyOnBonusWave: true,
        });
      }
    }

    const none = body.match(/((?:case\s+\w+\s*:\s*)*)default\s*:\s*return\s+0\s*;/);
    for (const key of none ? labels(none[1]!) : []) {
      rules.set(key, { raider: key, capByDifficulty: { easy: constant(0), normal: constant(0), hard: constant(0) } });
    }
    r.check(
      body,
      /bonusSpawns\s*>\s*0\s*\?\s*random\.nextInt\(bonusSpawns\s*\+\s*1\)\s*:\s*0/,
      "Raid.getPotentialBonusSpawns final roll",
    );

    for (const key of spawnOrder) {
      if (!rules.has(key)) {
        r.warnings.push(`No bonus-spawn rule parsed for raider type ${key}.`);
      }
    }
    return spawnOrder.flatMap((key) => {
      const rule = rules.get(key);
      return rule ? [rule] : [];
    });
  }

  private readRiderRules(r: SourceReader, raid: string, groupsFor: (constant: string) => number): RaidRiderRule[] {
    const body = methodBody(raid, "spawnGroup");
    const found = r.match(
      body,
      /groupNumber\s*==\s*this\.getNumGroups\(Difficulty\.(\w+)\)\)\s*\{\s*ridingRaider\s*=\s*EntityTypes\.(\w+)\.create[\s\S]*?groupNumber\s*>=\s*this\.getNumGroups\(Difficulty\.(\w+)\)\)\s*\{\s*if\s*\(ravagersSpawned\s*==\s*0\)\s*\{\s*ridingRaider\s*=\s*EntityTypes\.(\w+)\.create[\s\S]*?\}\s*else\s*\{\s*ridingRaider\s*=\s*EntityTypes\.(\w+)\.create/,
      "Raid.spawnGroup ravager rider rules",
    );
    if (!found) {
      return [];
    }
    const id = (constant: string) => `minecraft:${constant.toLowerCase()}`;
    return [
      {
        when: { waveEquals: groupsFor(found[1]!) },
        thresholdFrom: found[1]!.toLowerCase(),
        firstRavager: id(found[2]!),
        otherRavagers: id(found[2]!),
      },
      {
        when: { waveAtLeast: groupsFor(found[3]!) },
        thresholdFrom: found[3]!.toLowerCase(),
        firstRavager: id(found[4]!),
        otherRavagers: id(found[5]!),
      },
    ];
  }

  private async readCanBeLeader(r: SourceReader, keys: string[]): Promise<Record<string, boolean>> {
    const patrolling = await r.text(PATROLLING_MONSTER);
    const inherited =
      r.str(patrolling, /canBeLeader\(\)\s*\{\s*return\s+(true|false)\s*;/, "PatrollingMonster.canBeLeader") !== "false";
    const result: Record<string, boolean> = {};
    for (const key of new Set([...keys, ...Object.keys(RAIDER_CLASSES)])) {
      const path = RAIDER_CLASSES[key];
      const source = path ? await r.text(path) : "";
      const own = source.match(/canBeLeader\(\)\s*\{\s*return\s+(true|false)\s*;/)?.[1];
      result[key] = own === undefined ? inherited : own === "true";
    }
    return result;
  }

  private buildRosterTable(
    numGroups: Record<string, number>,
    spawnOrder: string[],
    spawns: Record<string, number[]>,
    rules: RaidBonusSpawnRule[],
    riderRules: RaidRiderRule[],
    canBeLeader: Record<string, boolean>,
    bonusWaveMinLevel: number,
  ): RaidRosterDifficulty[] {
    return DIFFICULTIES.flatMap((difficulty) => {
      const groups = numGroups[difficulty];
      if (groups === undefined || spawnOrder.length === 0) {
        return [];
      }
      const wave = (groupNumber: number, isBonusWave: boolean): RaidRosterWave => {
        const baseIndex = isBonusWave ? groups : groupNumber;
        const raiders = spawnOrder.map((key) => {
          const fixed = spawns[key]?.[baseIndex] ?? 0;
          const rule = rules.find((candidate) => candidate.raider === key);
          const extraDistribution = rule
            ? extraDistributionFor(rule, difficulty, groupNumber, isBonusWave)
            : [{ count: 0, probability: 1 }];
          const counts = extraDistribution.map((entry) => entry.count);
          const expectedExtra = extraDistribution.reduce((sum, entry) => sum + entry.count * entry.probability, 0);
          return {
            raider: key,
            fixed,
            randomMin: Math.min(...counts),
            randomMax: Math.max(...counts),
            extraDistribution,
            expected: fixed + expectedExtra,
          };
        });

        const ravager = raiders.find((entry) => entry.raider === "ravager");
        const rule = riderRules.find(
          (candidate) =>
            (candidate.when.waveEquals !== undefined && groupNumber === candidate.when.waveEquals) ||
            (candidate.when.waveAtLeast !== undefined && groupNumber >= candidate.when.waveAtLeast),
        );
        const riders = ravager && rule ? ridersFor(rule, ravager) : [];

        // Captain = first leader-capable raider spawned, walking raider types in spawn order.
        const captainOdds: Record<string, number> = {};
        let noneYet = 1;
        for (const entry of raiders) {
          if (!canBeLeader[entry.raider]) {
            continue;
          }
          const pNone = entry.fixed > 0 ? 0 : (entry.extraDistribution.find((d) => d.count === 0)?.probability ?? 0);
          const chance = noneYet * (1 - pNone);
          if (chance > 0) {
            captainOdds[entry.raider] = chance;
          }
          noneYet *= pNone;
        }
        if (noneYet > 0) {
          captainOdds.none = noneYet;
        }

        return {
          wave: groupNumber,
          isBonusWave,
          baseIndex,
          raiders,
          riders,
          totalMin: sum(raiders.map((e) => e.fixed + e.randomMin)) + sum(riders.map((e) => e.min)),
          totalMax: sum(raiders.map((e) => e.fixed + e.randomMax)) + sum(riders.map((e) => e.max)),
          totalExpected: sum(raiders.map((e) => e.expected)) + sum(riders.map((e) => e.expected)),
          captainOdds,
        };
      };

      return [
        {
          difficulty,
          numGroups: groups,
          waves: range(1, groups).map((groupNumber) => wave(groupNumber, false)),
          bonusWave: wave(groups + 1, true),
          bonusWaveRequiresRaidOmenLevel: bonusWaveMinLevel,
        },
      ];
    });
  }

  private waveRules(r: SourceReader, raid: string, numGroups: Record<string, number>): RaidRule[] {
    const rules: RaidRule[] = [];
    rules.push({
      rule: "The number of waves is fixed from the difficulty when the raid is created.",
      detail: Object.entries(numGroups)
        .map(([difficulty, groups]) => `${difficulty} ${groups}`)
        .join(", "),
    });
    if (r.check(raid, /shouldSpawnGroup\(\)\s*\{\s*return\s+this\.raidCooldownTicks\s*==\s*0/, "Raid.shouldSpawnGroup")) {
      rules.push({
        rule: "A wave spawns only when the between-wave countdown reaches 0 and no raiders from the previous wave are alive.",
      });
    }
    if (r.check(raid, "this.getGroupsSpawned() > this.numGroups", "Raid.hasSpawnedBonusWave")) {
      rules.push({
        rule: "Once the final regular wave is cleared, the bonus wave spawns if the raid omen level qualifies at that moment; it is always the last wave.",
      });
    }
    if (r.check(raid, "Raid.RaiderType.VALUES", "Raid.spawnGroup raider order")) {
      rules.push({ rule: "Raider types spawn in RaiderType order; counts are fixed + random extra for each type." });
    }
    return rules;
  }

  private async readCaptain(r: SourceReader, raid: string, raider: string): Promise<RaidMechanicsDataset["captain"]> {
    const bannerSource = await r.text(BANNER_PATTERNS);
    const patternIds = new Map<string, string>();
    for (const match of bannerSource.matchAll(/(\w+)\s*=\s*create\("([^"]+)"\)/g)) {
      patternIds.set(match[1]!, `minecraft:${match[2]!}`);
    }
    const layers = Array.from(
      methodBody(raid, "getBannerComponentPatch").matchAll(/BannerPatterns\.(\w+),\s*DyeColor\.(\w+)/g),
      (match) => ({
        pattern: match[1]!.toLowerCase(),
        patternId: patternIds.get(match[1]!),
        color: match[2]!.toLowerCase(),
      }),
    );
    if (layers.length === 0) {
      r.warnings.push("Seam not found: Raid.getBannerComponentPatch layers.");
    }
    for (const layer of layers) {
      if (!layer.patternId) {
        r.warnings.push(`Banner pattern ${layer.pattern} was not found in BannerPatterns.java.`);
      }
    }

    const rules: Array<{ rule: string; detail?: string }> = [];
    if (r.check(raider, /hasCaptainBanner\s*&&\s*patrolLeader/, "Raider.isCaptain")) {
      rules.push({ rule: "A captain is a patrol leader wearing the ominous banner on its head." });
    }
    if (r.check(raider, /!hasRaidLeader\s*&&\s*ItemStack\.matches/, "Raider.pickUpItem banner")) {
      rules.push({
        rule: "If a wave's captain dies, a leader-capable raider of that wave in an active raid walks to a dropped ominous banner within its follow range, picks it up, and becomes the new captain.",
      });
    }
    if (r.check(raider, "raidWhenKilled.removeLeader(this.getWave())", "Raider.die leader removal")) {
      rules.push({ rule: "Killing the captain clears that wave's leader slot." });
    }

    return {
      rule: "The first raider spawned in a wave whose type canBeLeader becomes the captain and wears the ominous banner.",
      bannerDropChance: r.num(
        methodBody(raid, "setLeader"),
        /setDropChance\(EquipmentSlot\.HEAD,\s*([\d.]+)F\)/,
        "Raid.setLeader drop chance",
      ),
      ominousBannerLayers: layers,
      rules,
    };
  }

  private async readProviders(r: SourceReader): Promise<RaidEnchantmentProvider[]> {
    const source = await r.text(ENCHANTMENT_PROVIDERS);
    const providers: RaidEnchantmentProvider[] = [];
    for (const match of source.matchAll(/(RAID_\w+)\s*=\s*create\("([^"]+)"\)/g)) {
      const raw = await r.json<{ type?: string; enchantment?: string; level?: unknown }>(
        `data/minecraft/enchantment_provider/${match[2]!}.json`,
      );
      providers.push({
        key: match[1]!,
        id: `minecraft:${match[2]!}`,
        type: raw?.type,
        enchantment: raw?.enchantment,
        level: raw?.level,
      });
    }
    if (providers.length === 0) {
      r.warnings.push("No RAID_* enchantment providers were found in VanillaEnchantmentProviders.java.");
    }
    return providers;
  }

  private async readRaiders(
    r: SourceReader,
    tagIds: string[],
    spawnOrder: string[],
    spawns: Record<string, number[]>,
    providers: RaidEnchantmentProvider[],
    groupsFor: (constant: string) => number,
  ): Promise<{ raiders: RaidRaiderInfo[]; byRaider: Record<string, RaidRaiderBuffs> }> {
    const canBeLeader = await this.readCanBeLeader(r, tagIds.map(stripNamespace));
    const byRaider: Record<string, RaidRaiderBuffs> = {};
    const raiders: RaidRaiderInfo[] = [];

    for (const id of tagIds) {
      const key = stripNamespace(id);
      const path = RAIDER_CLASSES[key];
      if (!path) {
        r.warnings.push(`Raider ${id} from #minecraft:raiders has no known entity class.`);
      }
      const source = path ? await r.text(path) : "";
      const attributes = methodBody(source, "createAttributes");
      const maxHealth = attributes.match(/Attributes\.MAX_HEALTH,\s*([\d.]+)/)?.[1];
      const buffs = this.readBuffs(r, key, methodBody(source, "applyRaidBuffs"), providers, groupsFor);
      if (buffs) {
        byRaider[key] = buffs;
      }
      raiders.push({
        id,
        key,
        inRaidWaves: spawnOrder.includes(key),
        spawnsPerWaveBeforeBonus: spawns[key],
        maxHealth: maxHealth === undefined ? undefined : Number(maxHealth),
        canBeLeader: canBeLeader[key] ?? true,
        raidBuffs: buffs,
        sourcePath: path,
      });
    }
    return { raiders, byRaider };
  }

  private readBuffs(
    r: SourceReader,
    key: string,
    body: string,
    providers: RaidEnchantmentProvider[],
    groupsFor: (constant: string) => number,
  ): RaidRaiderBuffs | undefined {
    if (body.replace(/[{}\s]/g, "") === "") {
      return undefined;
    }
    const thresholds = Array.from(body.matchAll(/wave\s*>\s*raid\.getNumGroups\(Difficulty\.(\w+)\)/g), (m) => m[1]!);
    const keys = Array.from(body.matchAll(/VanillaEnchantmentProviders\.(\w+)/g), (m) => m[1]!);
    const tier = (minWave: number, providerKey: string) => {
      const provider = providers.find((candidate) => candidate.key === providerKey);
      if (!provider) {
        r.warnings.push(`Enchantment provider ${providerKey} used by ${key} was not resolved.`);
      }
      return { minWave, provider: provider?.id ?? providerKey, enchantment: provider?.enchantment, level: provider?.level };
    };
    const tiers = thresholds.map((difficulty, index) => tier(groupsFor(difficulty) + 1, keys[index] ?? ""));
    let belowLowestTier: string | undefined;
    if (keys.length === thresholds.length + 1) {
      tiers.push(tier(1, keys[keys.length - 1]!));
    } else if (keys.length === thresholds.length) {
      belowLowestTier = "No raid enchantment: the raider keeps the weapon from its normal spawn equipment.";
    } else {
      r.warnings.push(`Could not pair enchantment thresholds with providers in ${key}.applyRaidBuffs.`);
    }
    const roll = body.match(/random\.nextFloat\(\)\s*(<=|<)\s*raid\.getEnchantOdds\(\)/)?.[1];
    if (!roll) {
      r.warnings.push(`Seam not found: ${key}.applyRaidBuffs enchant roll.`);
    }
    const item = body.match(/new ItemStack\(Items\.(\w+)\)/)?.[1];
    return {
      mainHandItem: item ? `minecraft:${item.toLowerCase()}` : undefined,
      equipsOnlyWhenEnchanted: /provider\s*!=\s*null/.test(body),
      enchantRoll: `random.nextFloat() ${roll ?? "<="} enchantOdds`,
      tiers: tiers.sort((left, right) => right.minWave - left.minWave),
      belowLowestTier,
    };
  }

  private async readHero(
    r: SourceReader,
    duration: number | undefined,
    amplifierOffset: number | undefined,
    maxRaidOmenLevel: number | undefined,
  ): Promise<RaidMechanicsDataset["hero"]> {
    const raider = await r.text(RAIDER);
    const credit: Array<{ rule: string; detail?: string }> = [];
    if (
      r.check(
        raider,
        /killer\s*!=\s*null\s*&&\s*killer\.is\(EntityTypes\.PLAYER\)\)\s*\{\s*raidWhenKilled\.addHeroOfTheVillage\(killer\)/,
        "Raider.die hero credit",
      )
    ) {
      credit.push({
        rule: "Any player who lands the killing blow on any raider that belongs to the raid is added to the raid's heroes.",
      });
    }
    credit.push({
      rule: "On victory every hero who is still loaded, alive as an entity, and not a spectator receives Hero of the Village; players also get the raid_win stat and the hero_of_the_village trigger.",
    });

    const villager = await r.firstExisting(VILLAGER_PATHS);
    // 26.3 writes `0.3F + 0.0625F * heroOfTheVillage.getAmplifier()`; 26.2 wrote `0.3 + 0.0625 * amplifier`.
    const discountMatch = r.match(
      villager,
      /([\d.]+)F?\s*\+\s*([\d.]+)F?\s*\*\s*(?:heroOfTheVillage\.getAmplifier\(\)|amplifier)\s*;/,
      "Villager hero discount modifier",
    );
    const base = discountMatch ? Number(discountMatch[1]) : undefined;
    const perAmplifier = discountMatch ? Number(discountMatch[2]) : undefined;
    const minimumReduction = r.num(villager, /Math\.max\(costReduction,\s*(\d+)\)/, "Villager hero minimum reduction");
    r.check(
      villager,
      /Math\.floor\((?:heroModifier|modifier)\s*\*\s*offer\.getBaseCostA\(\)\.getCount\(\)\)/,
      "Villager hero reduction formula",
    );

    const gift = await r.text(GIVE_GIFT);
    const tableSource = await r.text(BUILT_IN_LOOT_TABLES);
    const tableIds = new Map<string, string>();
    for (const match of tableSource.matchAll(/(\w+_GIFT)\s*=\s*register\("([^"]+)"\)/g)) {
      tableIds.set(match[1]!, `minecraft:${match[2]!}`);
    }
    const byProfession: Record<string, string> = {};
    for (const match of gift.matchAll(/VillagerProfession\.(\w+),\s*BuiltInLootTables\.(\w+)/g)) {
      byProfession[`minecraft:${match[1]!.toLowerCase()}`] = tableIds.get(match[2]!) ?? match[2]!;
    }
    const nextGift = r.match(
      gift,
      /return\s+(\d+)\s*\+\s*level\.getRandom\(\)\.nextInt\((\d+)\)\s*;/,
      "GiveGiftToHero.calculateTimeUntilNextGift",
    );
    const packages = await r.text(VILLAGER_GOAL_PACKAGES);
    const timeout = r.num(packages, /new GiveGiftToHero\((\d+)\)/, "VillagerGoalPackages GiveGiftToHero timeout");
    const initial = r.num(gift, /int\s+timeUntilNextGift\s*=\s*(\d+)\s*;/, "GiveGiftToHero initial delay");
    const headTurn = r.num(gift, /timestamp\s*-\s*this\.timeSinceStart\s*>\s*(\d+)L/, "GiveGiftToHero head-turn delay");

    return {
      effectId: "minecraft:hero_of_the_village",
      duration: duration === undefined ? undefined : ticks(duration),
      amplifierFormula: `raidOmenLevel - ${amplifierOffset ?? "?"}`,
      credit,
      discount: {
        base,
        perAmplifier,
        minimumReduction,
        formula:
          "reduction = max(floor((base + perAmplifier * amplifier) * firstCostCount), minimumReduction), subtracted from the first cost item",
        byAmplifier:
          base === undefined || perAmplifier === undefined || maxRaidOmenLevel === undefined
            ? []
            : range(0, maxRaidOmenLevel - (amplifierOffset ?? 1)).map((amplifier) => ({
                amplifier,
                fraction: round(base + perAmplifier * amplifier),
              })),
      },
      gifts: {
        initialDelay: initial === undefined ? undefined : ticks(initial),
        betweenGifts: nextGift
          ? { min: ticks(Number(nextGift[1])), max: ticks(Number(nextGift[1]) + Number(nextGift[2]) - 1) }
          : undefined,
        throwDistance: r.int(gift, "THROW_GIFT_AT_DISTANCE", "GiveGiftToHero"),
        headTurnDelay: headTurn === undefined ? undefined : ticks(headTurn),
        behaviorTimeout: timeout === undefined ? undefined : ticks(timeout),
        byProfession,
        babyLootTable: tableIds.get("BABY_VILLAGER_GIFT"),
        unemployedLootTable: tableIds.get("UNEMPLOYED_GIFT"),
        notes: [
          "A villager's gift countdown only ticks down while it can see a player with Hero of the Village.",
          "Babies throw the baby table; villagers without a mapped profession (including nitwits) throw the unemployed table.",
          "Per-item gift odds live in loot-odds.json under gifts, keyed by these loot table ids.",
        ],
      },
    };
  }

  private async readOmen(
    r: SourceReader,
    raid: string,
    raids: string,
    maxLevel: number | undefined,
    bonusWaveMinLevel: number | undefined,
    enchantOdds: Array<{ raidOmenLevel: number; odds: number }>,
    heroAmplifierOffset: number | undefined,
    discount: Array<{ amplifier: number; fraction: number }>,
  ): Promise<RaidMechanicsDataset["omen"]> {
    const badOmen = await r.text(BAD_OMEN);
    const raidOmen = await r.text(RAID_OMEN);
    const bottle = await r.text(BOTTLE_COMPONENT);
    const bottleFunction = await r.text(BOTTLE_FUNCTION);
    const trial = await r.text(TRIAL_SPAWNER_STATE);

    const raidOmenTicks = r.num(
      badOmen,
      /MobEffects\.RAID_OMEN,\s*(\d+),\s*amplification/,
      "BadOmenMobEffect raid omen duration",
    );
    const conditions: string[] = [];
    if (r.check(badOmen, "!player.isSpectator()", "BadOmenMobEffect spectator check"))
      conditions.push("The holder is a player who is not a spectator.");
    if (r.check(badOmen, "Difficulty.PEACEFUL", "BadOmenMobEffect peaceful check"))
      conditions.push("The difficulty is not Peaceful.");
    if (r.check(badOmen, "level.isVillage(player.blockPosition())", "BadOmenMobEffect village check"))
      conditions.push("The player is standing in a village (ServerLevel.isVillage).");
    if (
      r.check(
        badOmen,
        /raid\s*==\s*null\s*\|\|\s*raid\.getRaidOmenLevel\(\)\s*<\s*raid\.getMaxRaidOmenLevel\(\)/,
        "BadOmenMobEffect raid level check",
      )
    ) {
      conditions.push("There is no raid at that spot, or its raid omen level is below the maximum.");
    }
    conditions.push(
      "When all hold, Bad Omen is removed and replaced with Raid Omen of the same amplifier; the player's position is stored as the raid omen position.",
    );

    const triggerAt = r.num(raidOmen, /remainingDuration\s*==\s*(\d+)/, "RaidOmenMobEffect trigger tick");
    r.check(raidOmen, "createOrExtendRaid(player, raidOmenPosition)", "RaidOmenMobEffect raid start");

    const addPerAmplifier = r.num(raid, /effect\.getAmplifier\(\)\s*\+\s*(\d+)/, "Raid.absorbRaidOmen level increment");
    const clampMin = r.num(
      raid,
      /(?:Mth|Math)\.clamp\(\s*(?:\(long\))?this\.raidOmenLevel,\s*(\d+),\s*this\.getMaxRaidOmenLevel\(\)\)/,
      "Raid.absorbRaidOmen clamp",
    );
    const absorbRules: string[] = [];
    if (
      r.check(
        raids,
        /!raid\.isStarted\(\)\s*\|\|\s*raid\.getRaidOmenLevel\(\)\s*<\s*raid\.getMaxRaidOmenLevel\(\)/,
        "Raids.createOrExtendRaid absorb condition",
      )
    ) {
      absorbRules.push(
        "Raid Omen is absorbed into the raid at the stored position while the raid has not started yet, or while its level is below the maximum (so it can also raise a running raid).",
      );
    }
    absorbRules.push(
      `Each absorb adds amplifier + ${addPerAmplifier ?? "?"} to the raid omen level, clamped to ${clampMin ?? "?"}..${maxLevel ?? "?"}.`,
    );
    if (
      r.check(
        raid,
        /if\s*\(!this\.hasFirstWaveSpawned\(\)\)\s*\{\s*player\.awardStat\(Stats\.RAID_TRIGGER\)/,
        "Raid.absorbRaidOmen stat",
      )
    ) {
      absorbRules.push(
        "Before the first wave spawns, absorbing also awards the raid_trigger stat and fires the voluntary_exile criteria trigger.",
      );
    }
    if (
      r.check(
        raids,
        /PoiTypeTags\.VILLAGE\),\s*raidPosition,\s*\d+,\s*PoiManager\.Occupancy\.IS_OCCUPIED/,
        "Raids.createOrExtendRaid POI centering",
      )
    ) {
      absorbRules.push(
        "A new raid is centered on the average position of occupied village POIs near the stored position, or on the position itself when there are none.",
      );
    }

    const bottleDuration = r.int(bottle, "EFFECT_DURATION", "OminousBottleAmplifier");
    const bottleMin = r.int(bottle, "MIN_AMPLIFIER", "OminousBottleAmplifier");
    const bottleMax = r.int(bottle, "MAX_AMPLIFIER", "OminousBottleAmplifier");
    r.check(
      bottleFunction,
      /(?:Mth|Math)\.clamp\([^;]*getInt\(context\),\s*\d+,\s*\d+\)/,
      "SetOminousBottleAmplifierFunction clamp",
    );

    const trialPerLevel = r.int(trial, "TRIAL_OMEN_PER_BAD_OMEN_LEVEL", "TrialSpawnerStateData");
    const levelOffset = addPerAmplifier ?? 1;
    const heroOffset = heroAmplifierOffset ?? 1;

    const levels = range(1, maxLevel ?? 0).map((level) => {
      const amplifier = level - levelOffset;
      const heroAmplifier = level - heroOffset;
      return {
        raidOmenLevel: level,
        omenAmplifier: amplifier,
        effectLevel: amplifier + 1,
        bonusWave: bonusWaveMinLevel !== undefined && level >= bonusWaveMinLevel,
        enchantOdds: enchantOdds.find((entry) => entry.raidOmenLevel === level)?.odds ?? 0,
        heroOfTheVillageAmplifier: heroAmplifier,
        heroDiscountFraction: discount.find((entry) => entry.amplifier === heroAmplifier)?.fraction,
        trialOmen: trialPerLevel === undefined ? undefined : ticks(trialPerLevel * (amplifier + 1)),
      };
    });

    return {
      maxRaidOmenLevel: maxLevel,
      levels,
      badOmen: {
        effectId: "minecraft:bad_omen",
        raidOmenDuration: raidOmenTicks === undefined ? undefined : ticks(raidOmenTicks),
        conditions,
      },
      raidOmen: {
        effectId: "minecraft:raid_omen",
        triggersAtRemainingTicks: triggerAt,
        rules: [
          "When Raid Omen reaches its last tick it starts or extends the raid at the stored raid omen position, even if the player has since walked away.",
          "Removing Raid Omen early (milk, death) cancels the raid start.",
        ],
      },
      absorb: { levelAddedPerAmplifier: `amplifier + ${addPerAmplifier ?? "?"}`, clampMin, rules: absorbRules },
      canStartRaid: await this.readEnvironmentAttribute(r, "CAN_START_RAID"),
      ominousBottle: {
        itemId: "minecraft:ominous_bottle",
        badOmenDuration: bottleDuration === undefined ? undefined : ticks(bottleDuration),
        amplifierMin: bottleMin,
        amplifierMax: bottleMax,
        sources: await this.readBottleSources(r),
      },
      trialOmen: {
        perBadOmenLevel: trialPerLevel === undefined ? undefined : ticks(trialPerLevel),
        formula:
          "At an ominous-capable trial spawner, Bad Omen is removed and replaced with Trial Omen lasting perBadOmenLevel * (amplifier + 1) ticks.",
      },
    };
  }

  /** Every loot table that applies set_ominous_bottle_amplifier, with its amplifier range and the tables that pull it in. */
  private async readBottleSources(r: SourceReader): Promise<RaidOminousBottleSource[]> {
    const tables = await this.readLootTables(r);
    const sources: RaidOminousBottleSource[] = [];
    for (const [id, text] of tables) {
      if (!text.includes("set_ominous_bottle_amplifier")) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        r.warnings.push(`Could not parse loot table ${id}.`);
        continue;
      }
      const referencedBy = Array.from(tables.entries())
        .filter(([otherId, otherText]) => otherId !== id && otherText.includes(`"${id}"`))
        .map(([otherId]) => otherId)
        .sort();
      for (const modifier of findObjects(
        parsed,
        (value) =>
          value.type === "minecraft:set_ominous_bottle_amplifier" || value.function === "minecraft:set_ominous_bottle_amplifier",
      )) {
        const provider = modifier.amplifier;
        const { min, max } = intRange(provider);
        sources.push({
          lootTable: id,
          amplifierMin: min,
          amplifierMax: max,
          amplifierProvider: provider,
          requiresCaptain: /"is_captain"\s*:\s*true/.test(text),
          referencedBy,
        });
      }
    }
    if (sources.length === 0) {
      r.warnings.push("No loot table applies set_ominous_bottle_amplifier.");
    }
    r.sourcePaths.push(...sources.map((source) => `${LOOT_TABLE_DIR}/${stripNamespace(source.lootTable)}.json`));
    return sources.sort((left, right) => left.lootTable.localeCompare(right.lootTable));
  }

  private lootTableCache?: Map<string, string>;

  private async readLootTables(r: SourceReader): Promise<Map<string, string>> {
    if (this.lootTableCache) {
      return this.lootTableCache;
    }
    const tables = new Map<string, string>();
    const base = join(r.root, LOOT_TABLE_DIR);
    if (!(await fileExists(base))) {
      r.warnings.push(`${LOOT_TABLE_DIR} was not found.`);
      return tables;
    }
    for (const file of await readdir(base, { recursive: true })) {
      const relative = String(file).replace(/\\/g, "/");
      if (relative.endsWith(".json")) {
        tables.set(`minecraft:${relative.slice(0, -".json".length)}`, await readFile(join(base, relative), "utf8"));
      }
    }
    this.lootTableCache = tables;
    return tables;
  }

  /** An environment attribute's registered default plus every dimension type, biome, and timeline that overrides it. */
  private async readEnvironmentAttribute(r: SourceReader, constant: string): Promise<RaidEnvironmentAttribute> {
    const source = await r.text(ENVIRONMENT_ATTRIBUTES);
    const found = r.match(
      source,
      new RegExp(
        `${constant}\\s*=\\s*register\\(\\s*"([^"]+)",\\s*EnvironmentAttribute\\.builder\\(AttributeTypes\\.BOOLEAN\\)\\.defaultValue\\((true|false)\\)`,
      ),
      `EnvironmentAttributes.${constant}`,
    );
    const id = found ? `minecraft:${found[1]!}` : `minecraft:gameplay/${constant.toLowerCase()}`;
    const overrides: RaidAttributeOverride[] = [];
    const root = r.root;
    for (const [kind, dir] of [
      ["dimension_type", "data/minecraft/dimension_type"],
      ["biome", "data/minecraft/worldgen/biome"],
      ["timeline", "data/minecraft/timeline"],
    ] as const) {
      const full = join(root, dir);
      if (!(await fileExists(full))) {
        continue;
      }
      for (const file of (await readdir(full)).filter((name) => name.endsWith(".json")).sort()) {
        const text = await readFile(join(full, file), "utf8");
        if (!text.includes(`"${id}"`)) {
          continue;
        }
        let json: {
          attributes?: Record<string, unknown>;
          tracks?: Record<string, { keyframes?: Array<{ ticks: number; value: unknown }>; modifier?: string }>;
        };
        try {
          json = JSON.parse(text) as typeof json;
        } catch {
          r.warnings.push(`Could not parse ${dir}/${file}.`);
          continue;
        }
        const entryId = `minecraft:${file.slice(0, -".json".length)}`;
        r.sourcePaths.push(`${dir}/${file}`);
        if (kind === "timeline") {
          const track = json.tracks?.[id];
          overrides.push({ kind, id: entryId, keyframes: track?.keyframes, modifier: track?.modifier });
        } else {
          const value = json.attributes?.[id];
          overrides.push({ kind, id: entryId, value: typeof value === "boolean" ? value : undefined });
        }
      }
    }
    return { id, defaultValue: found ? found[2] === "true" : undefined, overrides };
  }

  private readTimers(r: SourceReader, raid: string, raider: string, raids: string): RaidMechanicsDataset["timers"] {
    const timers: RaidMechanicsDataset["timers"] = {};
    const add = (key: string, value: number | undefined, note: string) => {
      if (value !== undefined) {
        timers[key] = { ...ticks(value), note };
      }
    };
    add(
      "raidTimeout",
      r.int(raid, "RAID_TIMEOUT_TICKS", "Raid"),
      "A raid that has been active (loaded and ongoing) this long is stopped with no winner.",
    );
    add(
      "betweenWaves",
      r.int(raid, "DEFAULT_PRE_RAID_TICKS", "Raid"),
      "Countdown before the first wave and between waves; the boss bar fills during it.",
    );
    add(
      "postRaidVictoryDelay",
      r.int(raid, "POST_RAID_TICK_LIMIT", "Raid"),
      "After the last wave is cleared the raid waits this long, then declares victory.",
    );
    add(
      "celebration",
      r.int(raid, "MAX_CELEBRATION_TICKS", "Raid"),
      "Victory/defeat boss bar lingers this long before the raid is removed; raiders celebrate during a loss.",
    );
    add(
      "heroOfTheVillage",
      r.int(raid, "HERO_OF_THE_VILLAGE_DURATION", "Raid"),
      "Duration of the Hero of the Village effect given on victory.",
    );
    add(
      "maxNoActionTime",
      r.int(raid, "MAX_NO_ACTION_TIME", "Raid"),
      "Raider noActionTime value above which it stops joining raids and can start counting as outside the raid.",
    );
    const noActionStep = r.num(raider, /noActionTime\s*\+=\s*(\d+)\s*;/, "Raider.updateNoActionTime");
    if (noActionStep !== undefined && timers.maxNoActionTime) {
      add(
        "idleBeforeOutsideCount",
        Math.ceil(timers.maxNoActionTime.ticks / noActionStep),
        `Raiders add ${noActionStep} to noActionTime per tick, so maxNoActionTime is reached after this much real time without targeting a player or iron golem.`,
      );
    }
    const outside = r.int(raid, "OUTSIDE_RAID_BOUNDS_TIMEOUT", "Raid");
    const updateEvery = r.num(
      raid,
      /this\.ticksActive\s*%\s*(\d+)L\s*==\s*0L\)\s*\{\s*this\.updatePlayers\(level\);\s*this\.updateRaiders/,
      "Raid raider update interval",
    );
    if (outside !== undefined && updateEvery !== undefined) {
      add(
        "outsideRaidRemoval",
        outside * updateEvery,
        `An idle raider outside the village gains 1 count per raider update (every ${updateEvery} ticks) and is dropped from the raid at ${outside} counts.`,
      );
    }
    add(
      "raiderMinAgeBeforeIdleChecks",
      r.num(raid, /raider\.tickCount\s*>\s*(\d+)/, "Raid.updateRaiders tickCount gate"),
      "Idle/outside checks only apply to raiders older than this.",
    );
    add(
      "joinNearbyRaidCheck",
      r.num(raider, /getGameTime\(\)\s*%\s*(\d+)L\s*==\s*0L/, "Raider.aiStep join interval"),
      "A raider that can join raids looks for a raid at its position this often.",
    );
    add(
      "unreachableBannerRetry",
      r.num(raider, /getGameTime\(\)\s*\+\s*(\d+)L\)/, "Raider banner retry"),
      "A dropped ominous banner a raider could not path to is ignored this long.",
    );
    r.check(raids, /getNoActionTime\(\)\s*<=\s*\d+/, "Raids.canJoinRaid noActionTime gate");
    return timers;
  }

  private async readGeometry(r: SourceReader, raid: string, raids: string): Promise<RaidMechanicsDataset["geometry"]> {
    const serverLevel = await r.text(SERVER_LEVEL);
    const villageSections = r.num(
      serverLevel,
      /isVillage\(final BlockPos pos\)\s*\{\s*return\s+this\.isCloseToVillage\(pos,\s*(\d+)\)/,
      "ServerLevel.isVillage",
    );
    const raidRadiusSqr = r.num(serverLevel, /getNearbyRaid\(pos,\s*(\d+)\)/, "ServerLevel.getRaidAt radius");
    const removalSqr = r.int(raid, "RAID_REMOVAL_THRESHOLD_SQR", "Raid");
    const find = methodBody(raid, "findRandomSpawnPos");
    const howFar = r.match(
      find,
      /howFar\s*=\s*([\d.]+)F\s*\*\s*secondsRemaining\s*-\s*([\d.]+)F/,
      "Raid.findRandomSpawnPos howFar",
    );
    const ringScale = r.num(find, /Mth\.cos\(angle\)\s*\*\s*([\d.]+)F\s*\*\s*howFar/, "Raid.findRandomSpawnPos ring scale");
    const jitter = r.num(find, /random\.nextInt\((\d+)\)\s*\*\s*Mth\.floor\(howFar\)/, "Raid.findRandomSpawnPos jitter");
    const perSecond = r.num(find, /raidCooldownTicks\s*\/\s*(\d+)/, "Raid.findRandomSpawnPos seconds");
    const cooldown = r.int(raid, "DEFAULT_PRE_RAID_TICKS", "Raid") ?? 0;
    const slope = howFar ? Number(howFar[1]) : undefined;
    const offset = howFar ? Number(howFar[2]) : undefined;
    const tick = methodBody(raid, "tick");
    const horn = methodBody(raid, "playSound");
    const sounds = await r.text(SOUND_EVENTS);

    return {
      raidRadius: raidRadiusSqr === undefined ? undefined : Math.sqrt(raidRadiusSqr),
      raiderRemovalDistance: removalSqr === undefined ? undefined : Math.sqrt(removalSqr),
      villagePoiSearchRadius: r.num(raids, /PoiTypeTags\.VILLAGE\),\s*raidPosition,\s*(\d+)/, "Raids POI search radius"),
      villageCheck: `A position is "in a village" when it is within ${villageSections ?? "?"} section(s) (16-block chunk sections) of a section holding a village POI (ServerLevel.isVillage).`,
      centerRelocationSectionRadius: r.int(raid, "SECTION_RADIUS_FOR_FINDING_NEW_VILLAGE_CENTER", "Raid"),
      waveSpawn: {
        formula:
          "secondsRemaining = floor(cooldownTicks / 20); howFar = slope * secondsRemaining - offset; x = centerX + floor(cos(angle) * ringScale * howFar) + nextInt(jitterMultiplierBelow) * floor(howFar), same for z with sin; angle starts random and steps by PI / angleStepDivisor per try",
        ringScale,
        howFarSlope: slope,
        howFarOffset: offset,
        jitterMultiplierBelow: jitter,
        angleStepDivisor: r.num(find, /Math\.PI\s*\*\s*i\s*\/\s*([\d.]+)F/, "Raid.findRandomSpawnPos angle step"),
        maxVerticalOffset: r.num(
          find,
          /spawnY\s*-\s*this\.center\.getY\(\)\)\s*<=\s*(\d+)/,
          "Raid.findRandomSpawnPos vertical limit",
        ),
        loadedChunkMargin: r.num(find, /int\s+delta\s*=\s*(\d+)/, "Raid.findRandomSpawnPos chunk margin"),
        triesWhileCountingDown: r.num(
          methodBody(raid, "getValidSpawnPos"),
          /findRandomSpawnPos\(level,\s*(\d+)\)/,
          "Raid.getValidSpawnPos tries",
        ),
        triesAtWaveStart: r.num(tick, /findRandomSpawnPos\(level,\s*(\d+)\)/, "Raid.tick fallback tries"),
        maxFailedSpawnAttempts: r.num(tick, /attempt\s*>\s*(\d+)/, "Raid.tick failed attempts"),
        allowInsideVillageAtOrBelowSeconds: r.num(
          find,
          /secondsRemaining\s*<=\s*(\d+)/,
          "Raid.findRandomSpawnPos village threshold",
        ),
        rules: [
          "During the countdown the raid looks for a spawn position every 5 ticks until it finds one, then keeps that cached position for the wave (re-searching only if its chunk stops ticking).",
          "The very first search happens at the start of the countdown, so the usual spawn ring is the widest one in bySecondsRemaining.",
          "A candidate must be on the world surface, within the vertical limit of the center, in loaded entity-ticking chunks, and either valid for a ravager to spawn or air above snow.",
          "Candidates inside the village are rejected until few enough seconds remain.",
          "If no cached position exists when the countdown ends, it searches again right at the center (howFar is negative at 0 seconds, so within a few blocks).",
        ],
        bySecondsRemaining:
          slope === undefined || offset === undefined || ringScale === undefined
            ? []
            : range(0, Math.floor(cooldown / (perSecond ?? 20))).map((secondsRemaining) => {
                // Java float arithmetic: 0.22F * seconds - 0.24F.
                const value = Math.fround(Math.fround(Math.fround(slope) * secondsRemaining) - Math.fround(offset));
                return {
                  secondsRemaining,
                  howFar: round(value),
                  ringRadius: round(ringScale * value),
                  jitterStep: Math.floor(value),
                };
              }),
      },
      horn: {
        soundEvent: (() => {
          const name = r.str(sounds, /RAID_HORN\s*=\s*registerForHolder\("([^"]+)"\)/, "SoundEvents.RAID_HORN");
          return name ? `minecraft:${name}` : undefined;
        })(),
        rangeBlocks: r.num(horn, /int\s+range\s*=\s*(\d+)/, "Raid.playSound range"),
        playedAtDistance: r.num(horn, /float\s+distAway\s*=\s*([\d.]+)F/, "Raid.playSound distance"),
      },
    };
  }

  private readOutcomes(r: SourceReader, raid: string, raids: string): RaidMechanicsDataset["outcomes"] {
    const tick = methodBody(raid, "tick");
    const outcomes: RaidMechanicsDataset["outcomes"] = { victory: [], loss: [], stopped: [] };
    if (
      r.check(tick, /this\.isStarted\(\)\s*&&\s*!this\.hasMoreWaves\(\)\s*&&\s*raidersAlive\s*==\s*0/, "Raid victory condition")
    ) {
      outcomes.victory.push({
        rule: "Every wave (including the bonus wave when it applies) has spawned and no raiders are left alive for the post-raid delay.",
      });
    }
    if (
      r.check(
        tick,
        /if\s*\(this\.groupsSpawned\s*>\s*0\)\s*\{\s*this\.status\s*=\s*Raid\.RaidStatus\.LOSS/,
        "Raid loss condition",
      )
    ) {
      outcomes.loss.push({
        rule: "After at least one wave has spawned, the raid center is no longer a village and no village section within the relocation radius exists.",
        detail: "Typically every villager bed/job site/bell POI is gone or unclaimed. Raiders celebrate.",
      });
      outcomes.stopped.push({
        rule: "The same village check fails before the first wave spawns: the raid is cancelled instead of lost.",
      });
    }
    if (r.check(tick, /Difficulty\.PEACEFUL\)\s*\{\s*this\.stop\(\)/, "Raid peaceful stop")) {
      outcomes.stopped.push({ rule: "The difficulty is Peaceful." });
    }
    if (r.check(tick, /this\.ticksActive\s*>=\s*\d+L\)\s*\{\s*this\.stop\(\)/, "Raid timeout stop")) {
      outcomes.stopped.push({ rule: "The raid has been active for the raidTimeout timer." });
    }
    if (r.check(raids, /GameRules\.RAIDS\)\)\s*\{\s*raid\.stop\(\)/, "Raids gamerule stop")) {
      outcomes.stopped.push({ rule: "The raids game rule is turned off (it also prevents new raids)." });
    }
    if (r.check(tick, /attempt\s*>\s*\d+\)\s*\{\s*this\.stop\(\)/, "Raid spawn failure stop")) {
      outcomes.stopped.push({ rule: "No valid wave spawn position could be found after repeated attempts when a wave is due." });
    }
    outcomes.stopped.push({ rule: "Victory and loss both end with the celebration timer, after which the raid is removed." });
    return outcomes;
  }

  private async readPatrols(r: SourceReader): Promise<RaidMechanicsDataset["patrols"]> {
    const spawner = await r.text(PATROL_SPAWNER);
    const patrolling = await r.text(PATROLLING_MONSTER);
    const difficulty = await r.text(DIFFICULTY_INSTANCE);

    const interval = r.match(spawner, /nextTick\s*\+\s*(\d+)\s*\+\s*random\.nextInt\((\d+)\)/, "PatrolSpawner interval");
    const offset = r.match(
      spawner,
      /\((\d+)\s*\+\s*random\.nextInt\((\d+)\)\)\s*\*\s*\(random\.nextBoolean\(\)/,
      "PatrolSpawner offset",
    );
    const sizeAdd = r.num(spawner, /getEffectiveDifficulty\(\)\)\s*\+\s*(\d+)/, "PatrolSpawner group size");
    const despawnSqr = r.num(patrolling, /distSqr\s*>\s*([\d.]+)/, "PatrollingMonster despawn distance");
    // x += nextInt(n) - nextInt(n) moves each member -(n-1)..(n-1) blocks from the previous one.
    const spread = r.num(spawner, /random\.nextInt\((\d+)\)\s*-\s*random\.nextInt\(\d+\)/, "PatrolSpawner spread");

    const calc = methodBody(difficulty, "calculateDifficulty");
    const baseScale = r.num(calc, /float\s+scale\s*=\s*([\d.]+)F/, "DifficultyInstance base scale");
    const globalScale = r.num(calc, /\*\s*([\d.]+)F;\s*scale\s*\+=\s*globalScale/, "DifficultyInstance global scale");
    const localHard = r.match(calc, /isHard\s*\?\s*([\d.]+)F\s*:\s*([\d.]+)F/, "DifficultyInstance local scale");
    const moon = r.num(calc, /moonBrightness\s*\*\s*([\d.]+)F/, "DifficultyInstance moon scale");
    const easyFactor = r.num(calc, /localScale\s*\*=\s*([\d.]+)F/, "DifficultyInstance easy factor");
    const byDifficulty: Record<string, { min: number; max: number }> = {};
    if (
      baseScale !== undefined &&
      globalScale !== undefined &&
      localHard &&
      moon !== undefined &&
      easyFactor !== undefined &&
      sizeAdd !== undefined
    ) {
      DIFFICULTIES.forEach((name, index) => {
        const id = index + 1;
        const local = (name === "hard" ? Number(localHard[1]) : Number(localHard[2])) + Math.min(moon, globalScale);
        const maxScale = baseScale + globalScale + local * (name === "easy" ? easyFactor : 1);
        byDifficulty[name] = {
          min: Math.ceil(Math.fround(id * baseScale)) + sizeAdd,
          max: Math.ceil(Math.fround(id * maxScale)) + sizeAdd,
        };
      });
    }

    const rules: string[] = [];
    if (r.check(spawner, "GameRules.SPAWN_PATROLS", "PatrolSpawner game rule"))
      rules.push("Only runs while the spawn_patrols game rule is on and hostile spawning is enabled.");
    if (r.check(spawner, "level.isBrightOutside()", "PatrolSpawner daytime"))
      rules.push("When the attempt timer expires it only continues during the day.");
    rules.push(
      "A random non-spectator player is picked; the patrol spawns offset from them on both axes with a random sign, at the surface.",
    );
    if (r.check(spawner, "EnvironmentAttributes.CAN_PILLAGER_PATROL_SPAWN", "PatrolSpawner attribute"))
      rules.push("The spawn position must allow can_pillager_patrol_spawn (see canSpawnAttribute).");
    if (r.check(spawner, "EntityTypes.PILLAGER.create(level, EntitySpawnReason.PATROL)", "PatrolSpawner pillagers"))
      rules.push("Every patrol member is a pillager.");
    rules.push(
      "The first member is the patrol leader (captain, wears the ominous banner) and picks the patrol target; if the leader cannot spawn, the whole patrol is skipped.",
    );
    rules.push(
      "Each member needs a valid empty spawn block and passes the patrolling monster light check; members after the leader spread a few blocks per step.",
    );
    if (
      r.check(
        patrolling,
        /spawnReason\s*!=\s*EntitySpawnReason\.PATROL\s*&&\s*spawnReason\s*!=\s*EntitySpawnReason\.EVENT\s*&&\s*spawnReason\s*!=\s*EntitySpawnReason\.STRUCTURE/,
        "PatrollingMonster natural captain",
      )
    ) {
      rules.push(
        "Separately, any patrolling monster whose canBeLeader is true that spawns some other way (natural spawn, spawn egg, command) becomes a captain with naturalCaptainChance.",
      );
    }

    return {
      gameRule: "minecraft:spawn_patrols",
      attemptInterval: interval
        ? { min: ticks(Number(interval[1])), max: ticks(Number(interval[1]) + Number(interval[2]) - 1) }
        : undefined,
      chanceOneIn: r.num(spawner, /if\s*\(random\.nextInt\((\d+)\)\s*==\s*0\)/, "PatrolSpawner chance"),
      offset: offset ? { min: Number(offset[1]), max: Number(offset[1]) + Number(offset[2]) - 1 } : undefined,
      notWithinVillageSections: r.num(
        spawner,
        /isCloseToVillage\(player\.blockPosition\(\),\s*(\d+)\)/,
        "PatrolSpawner village distance",
      ),
      groupSize: { formula: `ceil(localEffectiveDifficulty) + ${sizeAdd ?? "?"}`, byDifficulty },
      memberSpread: spread === undefined ? undefined : spread - 1,
      maxBlockLight: r.num(patrolling, /getBrightness\(LightLayer\.BLOCK,\s*pos\)\s*>\s*(\d+)/, "PatrollingMonster light rule"),
      despawnDistanceWhilePatrolling: despawnSqr === undefined ? undefined : Math.sqrt(despawnSqr),
      naturalCaptainChance: r.num(patrolling, /nextFloat\(\)\s*<\s*([\d.]+)F/, "PatrollingMonster natural captain chance"),
      canSpawnAttribute: await this.readEnvironmentAttribute(r, "CAN_PILLAGER_PATROL_SPAWN"),
      rules,
    };
  }

  private async readProgression(r: SourceReader): Promise<RaidMechanicsDataset["progression"]> {
    const stats = await r.text(STATS);
    const triggers = await r.text(CRITERIA_TRIGGERS);
    const statIds: Record<string, string> = {};
    for (const constant of ["RAID_TRIGGER", "RAID_WIN"]) {
      const name = r.str(stats, new RegExp(`${constant}\\s*=\\s*makeCustomStat\\("([^"]+)"`), `Stats.${constant}`);
      if (name) statIds[constant] = `minecraft:${name}`;
    }
    const triggerIds: Record<string, string> = {};
    for (const constant of ["RAID_OMEN", "RAID_WIN"]) {
      const name = r.str(triggers, new RegExp(`${constant}\\s*=\\s*register\\("([^"]+)"`), `CriteriaTriggers.${constant}`);
      if (name) triggerIds[constant] = `minecraft:${name}`;
    }
    const advancements: RaidMechanicsDataset["progression"]["advancements"] = [];
    for (const path of ADVANCEMENTS) {
      const json = await r.json<{
        parent?: string;
        criteria?: Record<string, { trigger?: string }>;
        display?: { hidden?: boolean; frame?: string };
        rewards?: { experience?: number };
      }>(`data/minecraft/advancement/${path}.json`);
      if (!json) continue;
      advancements.push({
        id: `minecraft:${path}`,
        parent: json.parent,
        trigger: Object.values(json.criteria ?? {})[0]?.trigger,
        hidden: json.display?.hidden,
        frame: json.display?.frame,
        experience: json.rewards?.experience,
      });
    }
    return { stats: statIds, criteriaTriggers: triggerIds, advancements };
  }
}

function extraDistributionFor(
  rule: RaidBonusSpawnRule,
  difficulty: RaidDifficulty,
  wave: number,
  isBonusWave: boolean,
): RaidCountProbability[] {
  const zeroed =
    (rule.onlyOnBonusWave && !isBonusWave) ||
    (rule.zeroOnWaves?.atMost !== undefined && wave <= rule.zeroOnWaves.atMost) ||
    (rule.zeroOnWaves?.equals ?? []).includes(wave);
  const cap = rule.capByDifficulty[difficulty];
  const caps: Array<{ cap: number; probability: number }> = zeroed
    ? [{ cap: 0, probability: 1 }]
    : "constant" in cap
      ? [{ cap: cap.constant, probability: 1 }]
      : range(0, cap.uniformBelow - 1).map((value) => ({ cap: value, probability: 1 / cap.uniformBelow }));
  const counts = new Map<number, number>();
  for (const { cap: value, probability } of caps) {
    if (value <= 0) {
      counts.set(0, (counts.get(0) ?? 0) + probability);
      continue;
    }
    for (let count = 0; count <= value; count++) {
      counts.set(count, (counts.get(count) ?? 0) + probability / (value + 1));
    }
  }
  return Array.from(counts, ([count, probability]) => ({ count, probability })).sort((left, right) => left.count - right.count);
}

/** One rider per ravager: the first ravager's seat and the others' seats can hold different raiders. */
function ridersFor(rule: RaidRiderRule, ravager: RaidRosterEntry): RaidRosterRider[] {
  const min = ravager.fixed + ravager.randomMin;
  const max = ravager.fixed + ravager.randomMax;
  if (max === 0) {
    return [];
  }
  if (rule.firstRavager === rule.otherRavagers) {
    return [{ rider: rule.firstRavager, seats: "all", min, max, expected: ravager.expected }];
  }
  const atLeastOne = ravager.extraDistribution
    .filter((entry) => ravager.fixed + entry.count >= 1)
    .reduce((total, entry) => total + entry.probability, 0);
  const riders: RaidRosterRider[] = [
    { rider: rule.firstRavager, seats: "first", min: Math.min(min, 1), max: 1, expected: atLeastOne },
  ];
  if (max > 1) {
    riders.push({
      rider: rule.otherRavagers,
      seats: "rest",
      min: Math.max(min - 1, 0),
      max: max - 1,
      expected: ravager.expected - atLeastOne,
    });
  }
  return riders;
}

/** Text of a method's body (between its braces), or "" when the declaration is missing. */
function methodBody(source: string, name: string): string {
  const declaration = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?:throws[^{]*)?\\{`).exec(source);
  if (!declaration) {
    return "";
  }
  let depth = 0;
  const start = declaration.index + declaration[0].length - 1;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) {
      return source.slice(start + 1, index);
    }
  }
  return source.slice(start + 1);
}

function findObjects(value: unknown, predicate: (value: Record<string, unknown>) => boolean): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findObjects(entry, predicate));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap((entry) => findObjects(entry, predicate));
  return predicate(record) ? [record, ...nested] : nested;
}

function intRange(provider: unknown): { min?: number; max?: number } {
  if (typeof provider === "number") {
    return { min: provider, max: provider };
  }
  if (typeof provider === "object" && provider !== null) {
    const record = provider as Record<string, unknown>;
    if (typeof record.min === "number" && typeof record.max === "number") {
      return { min: Math.floor(record.min), max: Math.floor(record.max) };
    }
    if (typeof record.value === "number") {
      return { min: record.value, max: record.value };
    }
  }
  return {};
}

function ticks(value: number): RaidDuration {
  return { ticks: value, seconds: value / 20 };
}

function range(from: number, to: number): number[] {
  return to < from ? [] : Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function stripNamespace(value: string): string {
  const colon = value.indexOf(":");
  return colon >= 0 ? value.slice(colon + 1) : value;
}
