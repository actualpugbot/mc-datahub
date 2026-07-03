import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { AnvilMechanicsExtractor } from "../src/extraction/anvilMechanicsExtractor.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

async function createTempClientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anvil-mechanics-"));
  tempDirs.add(root);
  return root;
}

async function writeJavaFile(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

const ANVIL_MENU_SOURCE = `package net.minecraft.world.inventory;

public class AnvilMenu extends ItemCombinerMenu {
   public static final int MAX_NAME_LENGTH = 50;
   private static final int COST_FAIL = 0;
   private static final int COST_BASE = 1;
   private static final int COST_ADDED_BASE = 1;
   private static final int COST_REPAIR_MATERIAL = 1;
   private static final int COST_REPAIR_SACRIFICE = 2;
   private static final int COST_INCOMPATIBLE_PENALTY = 1;
   private static final int COST_RENAME = 1;

   public void createResult() {
      int repairAmount = Math.min(result.getDamageValue(), result.getMaxDamage() / 4);
      int additional = remaining2 + result.getMaxDamage() * 12 / 100;
      int fee = enchantment.getAnvilCost();
      if (usingBook) {
         fee = Math.max(1, fee / 2);
      }

      price += fee * level;
      if (input.getCount() > 1) {
         price = 40;
      }

      if (namingCost == price && namingCost > 0) {
         if (this.cost.get() >= 40) {
            this.cost.set(39);
         }
      }

      if (this.cost.get() >= 40 && !this.player.hasInfiniteMaterials()) {
         result = ItemStack.EMPTY;
      }

      this.access.execute((level, pos) -> {
         if (!player.hasInfiniteMaterials() && state.is(BlockTags.ANVIL) && player.getRandom().nextFloat() < 0.12F) {
            BlockState newBlockState = AnvilBlock.damage(state);
         }
      });
   }

   public static int calculateIncreasedRepairCost(final int baseCost) {
      return (int)Math.min(baseCost * 2L + 1L, 2147483647L);
   }
}`;

const PLAYER_SOURCE = `package net.minecraft.world.entity.player;

public abstract class Player extends LivingEntity {
   public int getXpNeededForNextLevel() {
      if (this.experienceLevel >= 30) {
         return 112 + (this.experienceLevel - 30) * 9;
      } else {
         return this.experienceLevel >= 15 ? 37 + (this.experienceLevel - 15) * 5 : 7 + this.experienceLevel * 2;
      }
   }
}`;

describe("anvil mechanics extractor", () => {
  test("derives costs, thresholds, formulas, and XP brackets from decompiled source", async () => {
    const root = await createTempClientRoot();
    await writeJavaFile(root, "net/minecraft/world/inventory/AnvilMenu.java", ANVIL_MENU_SOURCE);
    await writeJavaFile(root, "net/minecraft/world/entity/player/Player.java", PLAYER_SOURCE);

    const mechanics = await new AnvilMechanicsExtractor(createConsoleLogger(false)).extract(root);

    expect(mechanics).toBeDefined();
    expect(mechanics?.costBase).toBe(1);
    expect(mechanics?.costRepairMaterial).toBe(1);
    expect(mechanics?.costRepairSacrifice).toBe(2);
    expect(mechanics?.costIncompatiblePenalty).toBe(1);
    expect(mechanics?.costRename).toBe(1);
    expect(mechanics?.maxNameLength).toBe(50);
    expect(mechanics?.tooExpensiveThreshold).toBe(40);
    expect(mechanics?.renameOnlyCostClamp).toBe(39);
    expect(mechanics?.stackedItemCost).toBe(40);
    expect(mechanics?.priorWorkFormula).toEqual({ multiplier: 2, addend: 1 });
    expect(mechanics?.materialRepairFraction).toEqual({ numerator: 1, denominator: 4 });
    expect(mechanics?.sacrificeRepairBonus).toEqual({ numerator: 12, denominator: 100 });
    expect(mechanics?.bookCostFee).toEqual({ minimum: 1, divisor: 2 });
    expect(mechanics?.anvilBreakChance).toBeCloseTo(0.12);
    expect(mechanics?.xpPerLevelBrackets).toEqual([
      { minLevel: 0, base: 7, perLevelAboveMin: 2 },
      { minLevel: 15, base: 37, perLevelAboveMin: 5 },
      { minLevel: 30, base: 112, perLevelAboveMin: 9 },
    ]);
    expect(mechanics?.warnings).toEqual([]);
    expect(mechanics?.sourcePaths).toEqual([
      "net/minecraft/world/inventory/AnvilMenu.java",
      "net/minecraft/world/entity/player/Player.java",
    ]);
  });

  test("returns undefined without AnvilMenu.java and warns instead of guessing on partial source", async () => {
    const emptyRoot = await createTempClientRoot();
    expect(await new AnvilMechanicsExtractor(createConsoleLogger(false)).extract(emptyRoot)).toBeUndefined();

    const partialRoot = await createTempClientRoot();
    await writeJavaFile(
      partialRoot,
      "net/minecraft/world/inventory/AnvilMenu.java",
      "public class AnvilMenu { private static final int COST_BASE = 1; }",
    );

    const mechanics = await new AnvilMechanicsExtractor(createConsoleLogger(false)).extract(partialRoot);
    expect(mechanics?.costBase).toBe(1);
    expect(mechanics?.tooExpensiveThreshold).toBeUndefined();
    expect(mechanics?.warnings.length).toBeGreaterThan(0);
  });
});
