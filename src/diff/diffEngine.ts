import { stableJsonHash } from "../core/hash.js";
import type {
  BlockDefinition,
  CollectionChange,
  CollectionDiff,
  ItemDefinition,
  ModelDefinition,
  PaletteDefinition,
  RecipeDefinition,
  TextureDefinition,
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
    };
  }

  private diffCollection<T extends IdentifiedRecord>(from: T[], to: T[]): CollectionDiff<T> {
    const fromMap = new Map(from.map((entry) => [entry.id, entry]));
    const toMap = new Map(to.map((entry) => [entry.id, entry]));
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
      added: added.sort((left, right) => left.id.localeCompare(right.id)),
      removed: removed.sort((left, right) => left.id.localeCompare(right.id)),
      changed: changed.sort((left, right) => left.id.localeCompare(right.id)),
      unchangedCount,
    };
  }
}
