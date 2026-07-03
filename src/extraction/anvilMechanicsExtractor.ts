import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type { AnvilMechanicsDefinition, AnvilXpBracket } from "../domain/types.js";

const ANVIL_MENU_PATH = "net/minecraft/world/inventory/AnvilMenu.java";
const PLAYER_PATH = "net/minecraft/world/entity/player/Player.java";

// Names of the `private static final int COST_*` declarations in AnvilMenu.java
// mapped onto dataset fields. Values are read from source, never assumed.
const COST_CONSTANTS: Array<{ symbol: string; field: keyof AnvilMechanicsDefinition }> = [
  { symbol: "COST_BASE", field: "costBase" },
  { symbol: "COST_REPAIR_MATERIAL", field: "costRepairMaterial" },
  { symbol: "COST_REPAIR_SACRIFICE", field: "costRepairSacrifice" },
  { symbol: "COST_INCOMPATIBLE_PENALTY", field: "costIncompatiblePenalty" },
  { symbol: "COST_RENAME", field: "costRename" },
  { symbol: "MAX_NAME_LENGTH", field: "maxNameLength" },
];

/**
 * Derives anvil combine/repair mechanics from decompiled client source. The
 * anvil algorithm lives entirely in code (not data packs), so this parses the
 * constants and arithmetic out of AnvilMenu.java, plus the player XP curve
 * from Player.java, and reports anything it cannot find as a warning.
 */
export class AnvilMechanicsExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(decompiledClientRoot: string): Promise<AnvilMechanicsDefinition | undefined> {
    const anvilPath = join(decompiledClientRoot, ANVIL_MENU_PATH);
    if (!(await fileExists(anvilPath))) {
      this.logger.warn(`Skipping anvil mechanics; ${ANVIL_MENU_PATH} was not found under ${decompiledClientRoot}.`);
      return undefined;
    }

    const definition: AnvilMechanicsDefinition = { sourcePaths: [ANVIL_MENU_PATH], warnings: [] };
    const source = await readFile(anvilPath, "utf8");

    for (const { symbol, field } of COST_CONSTANTS) {
      const match = source.match(new RegExp(`static\\s+final\\s+int\\s+${symbol}\\s*=\\s*(\\d+)\\s*;`));
      if (match) {
        (definition[field] as number) = Number(match[1]);
      } else {
        definition.warnings.push(`Constant ${symbol} was not found in AnvilMenu.java.`);
      }
    }

    const tooExpensive = source.match(/this\.cost\.get\(\)\s*>=\s*(\d+)\s*&&\s*!this\.player\.hasInfiniteMaterials\(\)/);
    if (tooExpensive) {
      definition.tooExpensiveThreshold = Number(tooExpensive[1]);
    } else {
      definition.warnings.push("Too-expensive threshold check was not found in AnvilMenu.java.");
    }

    const renameClamp = source.match(/if\s*\(this\.cost\.get\(\)\s*>=\s*\d+\)\s*\{\s*this\.cost\.set\((\d+)\)\s*;/);
    if (renameClamp) {
      definition.renameOnlyCostClamp = Number(renameClamp[1]);
    } else {
      definition.warnings.push("Rename-only cost clamp was not found in AnvilMenu.java.");
    }

    const stacked = source.match(/if\s*\(\w+\.getCount\(\)\s*>\s*1\)\s*\{\s*\w+\s*=\s*(\d+)\s*;/);
    if (stacked) {
      definition.stackedItemCost = Number(stacked[1]);
    } else {
      definition.warnings.push("Stacked-item cost override was not found in AnvilMenu.java.");
    }

    const priorWork = source.match(/calculateIncreasedRepairCost[\s\S]{0,120}?Math\.min\(\s*\w+\s*\*\s*(\d+)L?\s*\+\s*(\d+)L?/);
    if (priorWork) {
      definition.priorWorkFormula = { multiplier: Number(priorWork[1]), addend: Number(priorWork[2]) };
    } else {
      definition.warnings.push("calculateIncreasedRepairCost formula was not found in AnvilMenu.java.");
    }

    const materialRepair = source.match(/Math\.min\(\w+\.getDamageValue\(\),\s*\w+\.getMaxDamage\(\)\s*\/\s*(\d+)\)/);
    if (materialRepair) {
      definition.materialRepairFraction = { numerator: 1, denominator: Number(materialRepair[1]) };
    } else {
      definition.warnings.push("Material repair fraction was not found in AnvilMenu.java.");
    }

    const sacrificeBonus = source.match(/\w+\.getMaxDamage\(\)\s*\*\s*(\d+)\s*\/\s*(\d+)/);
    if (sacrificeBonus) {
      definition.sacrificeRepairBonus = { numerator: Number(sacrificeBonus[1]), denominator: Number(sacrificeBonus[2]) };
    } else {
      definition.warnings.push("Sacrifice repair bonus was not found in AnvilMenu.java.");
    }

    const bookFee = source.match(/(\w+)\s*=\s*Math\.max\((\d+),\s*\1\s*\/\s*(\d+)\)/);
    if (bookFee) {
      definition.bookCostFee = { minimum: Number(bookFee[2]), divisor: Number(bookFee[3]) };
    } else {
      definition.warnings.push("Book fee halving was not found in AnvilMenu.java.");
    }

    const breakChance = source.match(/getRandom\(\)\.nextFloat\(\)\s*<\s*([\d.]+)F/);
    if (breakChance) {
      definition.anvilBreakChance = Number(breakChance[1]);
    } else {
      definition.warnings.push("Anvil break chance was not found in AnvilMenu.java.");
    }

    const xpBrackets = await this.extractXpBrackets(decompiledClientRoot);
    if (xpBrackets) {
      definition.xpPerLevelBrackets = xpBrackets;
      definition.sourcePaths.push(PLAYER_PATH);
    } else {
      definition.warnings.push("Player XP-per-level brackets could not be derived from Player.java.");
    }

    for (const warning of definition.warnings) {
      this.logger.warn(`Anvil mechanics: ${warning}`);
    }

    return definition;
  }

  private async extractXpBrackets(decompiledClientRoot: string): Promise<AnvilXpBracket[] | undefined> {
    const playerPath = join(decompiledClientRoot, PLAYER_PATH);
    if (!(await fileExists(playerPath))) {
      return undefined;
    }

    const source = await readFile(playerPath, "utf8");
    const methodStart = source.indexOf("int getXpNeededForNextLevel()");
    if (methodStart < 0) {
      return undefined;
    }

    const body = source.slice(methodStart, methodStart + 600);
    const brackets: AnvilXpBracket[] = [];

    for (const match of body.matchAll(/(\d+)\s*\+\s*\(this\.experienceLevel\s*-\s*(\d+)\)\s*\*\s*(\d+)/g)) {
      brackets.push({ minLevel: Number(match[2]), base: Number(match[1]), perLevelAboveMin: Number(match[3]) });
    }

    const baseBracket = body.match(/(\d+)\s*\+\s*this\.experienceLevel\s*\*\s*(\d+)/);
    if (baseBracket) {
      brackets.push({ minLevel: 0, base: Number(baseBracket[1]), perLevelAboveMin: Number(baseBracket[2]) });
    }

    if (brackets.length === 0) {
      return undefined;
    }

    return brackets.sort((left, right) => left.minLevel - right.minLevel);
  }
}
