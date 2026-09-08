import { stableJsonHash } from "../core/hash.js";
import type {
  AdvancementDefinition,
  BiomeDefinition,
  BlockPropertyDefinition,
  BlockDefinition,
  CollectionChange,
  CollectionDiff,
  EnchantmentDefinition,
  ItemDefinition,
  ItemStatDefinition,
  LootTableDefinition,
  ModelDefinition,
  MobAnimationDefinition,
  MobImageDefinition,
  MobModelDefinition,
  MobProfileDefinition,
  MobSoundDefinition,
  ObjectDiff,
  PaletteDefinition,
  ProcessorListDefinition,
  RecipeDefinition,
  StructureDefinition,
  StructureTemplateDefinition,
  TagDefinition,
  TemplatePoolDefinition,
  TextureDefinition,
  TranslationEntry,
  VersionDataset,
  VersionDiff,
} from "../domain/types.js";

interface IdentifiedRecord {
  id: string;
}

export class DiffEngine {
  compare(from: VersionDataset, to: VersionDataset): VersionDiff {
    return {
      fromVersion: from.version,
      toVersion: to.version,
      generatedAt: new Date().toISOString(),

      // Keyed collections.
      blocks: this.diffCollection<BlockDefinition>(from.blocks, to.blocks),
      items: this.diffCollection<ItemDefinition>(from.items, to.items),
      recipes: this.diffCollection<RecipeDefinition>(from.recipes, to.recipes),
      textures: this.diffCollection<TextureDefinition>(from.textures, to.textures),
      models: this.diffCollection<ModelDefinition>(from.models, to.models),
      palettes: this.diffCollection<PaletteDefinition>(from.palettes, to.palettes),
      itemStats: this.diffCollection<ItemStatDefinition>(from.itemStats, to.itemStats),
      blockProperties: this.diffCollection<BlockPropertyDefinition>(from.blockProperties, to.blockProperties),
      enchantments: this.diffCollection<EnchantmentDefinition>(from.enchantments, to.enchantments),
      tags: this.diffCollection<TagDefinition>(from.tags, to.tags, (tag) => `${tag.registry}/${tag.id}`),
      lootTables: this.diffCollection<LootTableDefinition>(from.lootTables, to.lootTables),
      advancements: this.diffCollection<AdvancementDefinition>(from.advancements, to.advancements),
      translations: this.diffCollection<TranslationEntry>(from.translations, to.translations, (entry) => entry.key),
      biomes: this.diffCollection<BiomeDefinition>(from.biomes, to.biomes),
      mobImages: this.diffCollection<MobImageDefinition>(from.mobImages, to.mobImages),
      mobModels: this.diffCollection<MobModelDefinition>(from.mobModels, to.mobModels),
      blockEntityModels: this.diffCollection<MobModelDefinition>(from.blockEntityModels ?? [], to.blockEntityModels ?? []),
      mobAnimations: this.diffCollection<MobAnimationDefinition>(from.mobAnimations ?? [], to.mobAnimations ?? []),
      mobSounds: this.diffCollection<MobSoundDefinition>(from.mobSounds, to.mobSounds),
      mobProfiles: this.diffCollection<MobProfileDefinition>(from.mobProfiles ?? [], to.mobProfiles ?? []),
      structures: this.diffCollection<StructureDefinition>(from.structures ?? [], to.structures ?? []),
      templatePools: this.diffCollection<TemplatePoolDefinition>(from.templatePools ?? [], to.templatePools ?? []),
      processorLists: this.diffCollection<ProcessorListDefinition>(from.processorLists ?? [], to.processorLists ?? []),
      structureTemplates: this.diffCollection<StructureTemplateDefinition>(
        from.structureTemplates ?? [],
        to.structureTemplates ?? [],
      ),

      // Whole-object datasets: no stable per-record id to key on.
      anvilMechanics: this.diffObject(from.anvilMechanics, to.anvilMechanics),
      sulfurCube: this.diffObject(from.sulfurCube, to.sulfurCube),
      treeFeatures: this.diffObject(from.treeFeatures, to.treeFeatures),
      fishingOdds: this.diffObject(from.fishingOdds, to.fishingOdds),
      lootOdds: this.diffObject(from.lootOdds, to.lootOdds),
      banners: this.diffObject(from.banners, to.banners),
      villagerTrades: this.diffObject(from.villagerTrades, to.villagerTrades),
      oreGeneration: this.diffObject(from.oreGeneration, to.oreGeneration),
      renderData: this.diffObject(from.renderData, to.renderData),
      mobSoundMinecraftWiki: this.diffObject(from.mobSoundMinecraftWiki, to.mobSoundMinecraftWiki),
      resourcePack: this.diffObject(from.resourcePack, to.resourcePack),
    };
  }

  private diffCollection<T>(from: T[], to: T[], keyOf: (entry: T) => string = defaultKeyOf): CollectionDiff<T> {
    const fromMap = new Map(from.map((entry) => [keyOf(entry), entry]));
    const toMap = new Map(to.map((entry) => [keyOf(entry), entry]));
    const added: T[] = [];
    const removed: T[] = [];
    const changed: CollectionChange<T>[] = [];
    let unchangedCount = 0;

    for (const [id, after] of toMap) {
      const before = fromMap.get(id);
      if (!before) {
        added.push(after);
        continue;
      }

      if (stableJsonHash(before) !== stableJsonHash(after)) {
        changed.push({ id, before, after });
      } else {
        unchangedCount += 1;
      }
    }

    for (const [id, before] of fromMap) {
      if (!toMap.has(id)) {
        removed.push(before);
      }
    }

    return {
      added: added.sort((left, right) => keyOf(left).localeCompare(keyOf(right))),
      removed: removed.sort((left, right) => keyOf(left).localeCompare(keyOf(right))),
      changed: changed.sort((left, right) => left.id.localeCompare(right.id)),
      unchangedCount,
    };
  }

  /**
   * Datasets like `treeFeatures` and `lootOdds` are one object, not a keyed collection. Reporting the
   * status plus the object's own changed top-level keys says where to look without embedding two full
   * copies of something as large as `renderData` in every diff.
   */
  private diffObject(before: unknown, after: unknown): ObjectDiff {
    if (before === undefined && after === undefined) {
      return { status: "unchanged", changedFields: [] };
    }
    if (before === undefined) {
      return { status: "added", changedFields: topLevelKeys(after) };
    }
    if (after === undefined) {
      return { status: "removed", changedFields: topLevelKeys(before) };
    }
    if (stableJsonHash(before) === stableJsonHash(after)) {
      return { status: "unchanged", changedFields: [] };
    }

    return { status: "changed", changedFields: changedTopLevelFields(before, after) };
  }
}

function topLevelKeys(value: unknown): string[] {
  return isPlainObject(value) ? Object.keys(value).sort((left, right) => left.localeCompare(right)) : [];
}

function changedTopLevelFields(before: unknown, after: unknown): string[] {
  if (!isPlainObject(before) || !isPlainObject(after)) {
    // A scalar or array has no named fields to report; `status` already says it changed.
    return [];
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => stableJsonHash(before[key]) !== stableJsonHash(after[key]))
    .sort((left, right) => left.localeCompare(right));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultKeyOf(entry: unknown): string {
  return (entry as IdentifiedRecord).id;
}
