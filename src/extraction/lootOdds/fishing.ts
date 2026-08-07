/**
 * Fishing odds: the first public "what are the odds?" guide.
 *
 * `minecraft:gameplay/fishing` is a single pool of three nested tables:
 *   junk     weight 10, quality -2
 *   treasure weight  5, quality  2, only when `fishing_hook.in_open_water`
 *   fish     weight 85, quality -1
 *
 * With luck 0 that is a clean 10 / 5 / 85 split. Luck of the Sea raises
 * treasure and lowers junk and fish through
 * `max(floor(weight + quality * luck), 0)`.
 */

import { type LootOddsData } from "./data.js";
import { evaluateLootTable } from "./evaluator.js";
import type { FishingOdds, FishingOddsCell, OddsContext } from "./types.js";

export const FISHING_TABLE_ID = "minecraft:gameplay/fishing";

/**
 * -4 covers Bad Luck II (Unluck), 0 is a bare rod, 3 is Luck of the Sea III,
 * and 10 leaves headroom for Luck potions stacked on top of the enchantment.
 */
export const DEFAULT_LUCK_VALUES: number[] = Array.from({ length: 15 }, (_, index) => index - 4);

export interface FishingOddsOptions {
  /** Luck values to evaluate. Defaults to every integer in `[-4, 10]`. */
  luckValues?: number[];
  /** Extra context knobs merged into every cell. */
  context?: Omit<OddsContext, "luck" | "inOpenWater">;
}

/** Build the full fishing odds grid: every luck value x open / closed water. */
export function computeFishingOdds(data: LootOddsData, options: FishingOddsOptions = {}): FishingOdds {
  const luckValues = options.luckValues ?? DEFAULT_LUCK_VALUES;
  const cells: FishingOddsCell[] = [];
  const warnings = new Set<string>();

  for (const luck of luckValues) {
    for (const inOpenWater of [true, false]) {
      const result = evaluateLootTable(FISHING_TABLE_ID, {
        ...options.context,
        data,
        luck,
        inOpenWater,
      });
      for (const warning of result.warnings) warnings.add(warning);
      cells.push({
        luck,
        inOpenWater,
        categories: result.categories,
        items: result.items,
        outcomes: result.outcomes,
        pools: result.pools,
        warnings: result.warnings,
      });
    }
  }

  return {
    tableId: FISHING_TABLE_ID,
    luckValues: [...luckValues],
    cells,
    warnings: [...warnings],
  };
}

/** Look up one cell of the grid. */
export function findFishingCell(odds: FishingOdds, luck: number, inOpenWater: boolean): FishingOddsCell | undefined {
  return odds.cells.find((cell) => cell.luck === luck && cell.inOpenWater === inOpenWater);
}
