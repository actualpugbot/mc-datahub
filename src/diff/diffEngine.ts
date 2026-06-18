import { stableJsonHash } from "../core/hash.js";
import type {
  AdvancementDefinition,
  BlockPropertyDefinition,
  BlockDefinition,
  CollectionChange,
  CollectionDiff,
  EnchantmentDefinition,
  ItemDefinition,
  ItemStatDefinition,
  LootTableDefinition,
  ModelDefinition,
  MobImageDefinition,
  MobSoundDefinition,
  PaletteDefinition,
  RecipeDefinition,
  TagDefinition,
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
      mobImages: this.diffCollection<MobImageDefinition>(from.mobImages, to.mobImages),
      mobSounds: this.diffCollection<MobSoundDefinition>(from.mobSounds, to.mobSounds),
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
}

function defaultKeyOf(entry: unknown): string {
  return (entry as IdentifiedRecord).id;
}
