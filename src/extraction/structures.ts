import type { ArchiveSource } from "../archive/archiveSource.js";
import type {
  JsonValue,
  ProcessorListDefinition,
  StructureDataBundle,
  StructureDefinition,
  StructureTemplateDefinition,
  StructureTemplateJigsaw,
  TemplatePoolDefinition,
  TemplatePoolElementDefinition,
} from "../domain/types.js";
import { decodeNbt, type NbtCompound } from "./nbt.js";

const STRUCTURE_PREFIX = "data/minecraft/worldgen/structure/";
const TEMPLATE_POOL_PREFIX = "data/minecraft/worldgen/template_pool/";
const PROCESSOR_LIST_PREFIX = "data/minecraft/worldgen/processor_list/";
const TEMPLATE_NBT_PREFIX = "data/minecraft/structure/";

/** Blocks that only mark template space and never render or collide. */
const SKIPPED_TEMPLATE_BLOCKS = new Set(["minecraft:air", "minecraft:structure_void", "minecraft:jigsaw"]);

/**
 * Build the structure-generation dataset from the vanilla data pack: the
 * jigsaw structure definitions (`worldgen/structure`), their template pools
 * (`worldgen/template_pool`) and processor lists (`worldgen/processor_list`),
 * plus every prebuilt structure template (`structure/**.nbt`) decoded into a
 * compact JSON form (palettes as blockstate strings, blocks as flat
 * `[x, y, z, stateIndex]` runs, jigsaw connectors lifted out of the block
 * list). Together these are everything a consumer needs to assemble a random
 * vanilla structure by the game's own generation rules.
 */
export async function buildStructureData(paths: string[], source: ArchiveSource): Promise<StructureDataBundle> {
  const structures = await readStructures(paths, source);
  const templatePools = await readTemplatePools(paths, source);
  const processorLists = await readProcessorLists(paths, source);
  const structureTemplates = await readStructureTemplates(paths, source);

  return { structures, templatePools, processorLists, structureTemplates };
}

async function readStructures(paths: string[], source: ArchiveSource): Promise<StructureDefinition[]> {
  const structurePaths = paths.filter((path) => path.startsWith(STRUCTURE_PREFIX) && path.endsWith(".json")).sort();
  const structures: StructureDefinition[] = [];

  for (const path of structurePaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw) || typeof raw.type !== "string") {
      continue;
    }

    const key = path.slice(STRUCTURE_PREFIX.length, path.length - ".json".length);
    const definition: StructureDefinition = {
      id: `minecraft:${key}`,
      key,
      name: humanizeKey(key),
      type: normalizeId(raw.type),
      step: typeof raw.step === "string" ? raw.step : "surface_structures",
      biomes: raw.biomes ?? [],
      sourcePath: path,
      raw,
    };

    if (definition.type === "minecraft:jigsaw") {
      definition.jigsaw = {
        startPool: normalizeId(typeof raw.start_pool === "string" ? raw.start_pool : ""),
        size: typeof raw.size === "number" ? raw.size : 0,
        startHeight: raw.start_height ?? null,
        maxDistanceFromCenter: typeof raw.max_distance_from_center === "number" ? raw.max_distance_from_center : 80,
        useExpansionHack: raw.use_expansion_hack === true,
        ...(typeof raw.project_start_to_heightmap === "string"
          ? { projectStartToHeightmap: raw.project_start_to_heightmap }
          : {}),
        ...(Array.isArray(raw.pool_aliases) ? { poolAliases: raw.pool_aliases } : {}),
        ...(raw.dimension_padding !== undefined ? { dimensionPadding: raw.dimension_padding } : {}),
        ...(typeof raw.liquid_settings === "string" ? { liquidSettings: raw.liquid_settings } : {}),
      };
    }

    structures.push(definition);
  }

  return structures.sort((left, right) => left.key.localeCompare(right.key));
}

async function readTemplatePools(paths: string[], source: ArchiveSource): Promise<TemplatePoolDefinition[]> {
  const poolPaths = paths.filter((path) => path.startsWith(TEMPLATE_POOL_PREFIX) && path.endsWith(".json")).sort();
  const pools: TemplatePoolDefinition[] = [];

  for (const path of poolPaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw) || !Array.isArray(raw.elements)) {
      continue;
    }

    const key = path.slice(TEMPLATE_POOL_PREFIX.length, path.length - ".json".length);
    pools.push({
      id: `minecraft:${key}`,
      key,
      fallback: normalizeId(typeof raw.fallback === "string" ? raw.fallback : "minecraft:empty"),
      elements: raw.elements
        .map((entry) => normalizePoolEntry(entry))
        .filter((entry): entry is TemplatePoolElementDefinition => entry !== undefined),
      sourcePath: path,
    });
  }

  return pools.sort((left, right) => left.key.localeCompare(right.key));
}

function normalizePoolEntry(entry: JsonValue): TemplatePoolElementDefinition | undefined {
  if (!isRecord(entry) || !isRecord(entry.element)) {
    return undefined;
  }

  const element = normalizePoolElement(entry.element);
  if (!element) {
    return undefined;
  }

  return {
    weight: typeof entry.weight === "number" ? entry.weight : 1,
    ...element,
  };
}

function normalizePoolElement(element: Record<string, JsonValue>): Omit<TemplatePoolElementDefinition, "weight"> | undefined {
  const elementType = normalizeId(typeof element.element_type === "string" ? element.element_type : "");
  if (!elementType) {
    return undefined;
  }

  const normalized: Omit<TemplatePoolElementDefinition, "weight"> = { elementType, raw: element };

  if (typeof element.location === "string") {
    normalized.location = normalizeId(element.location);
  }
  if (typeof element.projection === "string") {
    normalized.projection = element.projection;
  }
  if (typeof element.processors === "string") {
    normalized.processors = normalizeId(element.processors);
  } else if (element.processors !== undefined) {
    // Inline processor definitions skip the registry: keep them verbatim.
    normalized.processorsInline = element.processors;
  }
  if (typeof element.feature === "string") {
    normalized.feature = normalizeId(element.feature);
  }
  if (Array.isArray(element.elements)) {
    // list_pool_element: the child elements all place together.
    normalized.elements = element.elements
      .map((child) => (isRecord(child) ? normalizePoolElement(child) : undefined))
      .filter((child): child is Omit<TemplatePoolElementDefinition, "weight"> => child !== undefined)
      .map((child) => ({ weight: 1, ...child }));
  }

  return normalized;
}

async function readProcessorLists(paths: string[], source: ArchiveSource): Promise<ProcessorListDefinition[]> {
  const processorPaths = paths.filter((path) => path.startsWith(PROCESSOR_LIST_PREFIX) && path.endsWith(".json")).sort();
  const processorLists: ProcessorListDefinition[] = [];

  for (const path of processorPaths) {
    const raw = await source.readJson<JsonValue>(path);
    if (!isRecord(raw)) {
      continue;
    }

    const key = path.slice(PROCESSOR_LIST_PREFIX.length, path.length - ".json".length);
    processorLists.push({
      id: `minecraft:${key}`,
      key,
      processors: Array.isArray(raw.processors) ? raw.processors : [],
      sourcePath: path,
    });
  }

  return processorLists.sort((left, right) => left.key.localeCompare(right.key));
}

async function readStructureTemplates(paths: string[], source: ArchiveSource): Promise<StructureTemplateDefinition[]> {
  const templatePaths = paths.filter((path) => path.startsWith(TEMPLATE_NBT_PREFIX) && path.endsWith(".nbt")).sort();
  const templates: StructureTemplateDefinition[] = [];

  for (const path of templatePaths) {
    const root = decodeNbt(await source.readBuffer(path));
    const key = path.slice(TEMPLATE_NBT_PREFIX.length, path.length - ".nbt".length);
    templates.push(normalizeTemplate(`minecraft:${key}`, key, path, root));
  }

  return templates.sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeTemplate(id: string, key: string, sourcePath: string, root: NbtCompound): StructureTemplateDefinition {
  const size = readIntTriple(root.size) ?? [0, 0, 0];
  // Templates carry either a single `palette` or a list of random `palettes`
  // (the game picks one per placement; e.g. shipwrecks pick a wood variant).
  const rawPalettes: unknown[][] = Array.isArray(root.palettes)
    ? (root.palettes as unknown[][])
    : Array.isArray(root.palette)
      ? [root.palette as unknown[]]
      : [];
  const palettes = rawPalettes.map((entries) => entries.map((entry) => blockstateString(entry)));
  const paletteBlockNames = (palettes[0] ?? []).map((state) => state.split("[", 1)[0] ?? state);

  const blocks: number[] = [];
  const jigsaws: StructureTemplateJigsaw[] = [];
  const rawBlocks = Array.isArray(root.blocks) ? root.blocks : [];

  for (const rawBlock of rawBlocks) {
    if (!isNbtRecord(rawBlock)) {
      continue;
    }

    const pos = readIntTriple(rawBlock.pos);
    const stateIndex = typeof rawBlock.state === "number" ? rawBlock.state : -1;
    if (!pos || stateIndex < 0) {
      continue;
    }

    const blockName = paletteBlockNames[stateIndex] ?? "";
    if (blockName === "minecraft:jigsaw") {
      const jigsaw = normalizeJigsawBlock(pos, palettes[0]?.[stateIndex] ?? "", rawBlock.nbt);
      if (jigsaw) {
        jigsaws.push(jigsaw);
      }
      continue;
    }
    if (SKIPPED_TEMPLATE_BLOCKS.has(blockName)) {
      continue;
    }

    blocks.push(pos[0], pos[1], pos[2], stateIndex);
  }

  return {
    id,
    key,
    size,
    palettes,
    blocks,
    jigsaws,
    entityCount: Array.isArray(root.entities) ? root.entities.length : 0,
    sourcePath,
  };
}

function normalizeJigsawBlock(
  pos: [number, number, number],
  blockstate: string,
  nbt: unknown,
): StructureTemplateJigsaw | undefined {
  if (!isNbtRecord(nbt)) {
    return undefined;
  }

  const orientationMatch = /orientation=([a-z_]+)/.exec(blockstate);
  return {
    pos,
    orientation: orientationMatch?.[1] ?? "north_up",
    name: normalizeId(typeof nbt.name === "string" ? nbt.name : "minecraft:empty"),
    pool: normalizeId(typeof nbt.pool === "string" ? nbt.pool : "minecraft:empty"),
    target: normalizeId(typeof nbt.target === "string" ? nbt.target : "minecraft:empty"),
    finalState: typeof nbt.final_state === "string" ? nbt.final_state : "minecraft:air",
    jointType: nbt.joint === "aligned" ? "aligned" : "rollable",
    placementPriority: typeof nbt.placement_priority === "number" ? nbt.placement_priority : 0,
    selectionPriority: typeof nbt.selection_priority === "number" ? nbt.selection_priority : 0,
  };
}

/** Render a palette entry (`{Name, Properties}`) as `id[prop=value,...]` with sorted properties. */
function blockstateString(entry: unknown): string {
  if (!isNbtRecord(entry) || typeof entry.Name !== "string") {
    return "minecraft:air";
  }

  const name = normalizeId(entry.Name);
  if (!isNbtRecord(entry.Properties)) {
    return name;
  }

  const properties = Object.entries(entry.Properties)
    .filter((pair): pair is [string, string] => typeof pair[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, value]) => `${property}=${value}`);
  return properties.length > 0 ? `${name}[${properties.join(",")}]` : name;
}

function readIntTriple(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    return undefined;
  }

  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return undefined;
  }

  return [x, y, z];
}

function normalizeId(value: string): string {
  if (!value) {
    return value;
  }

  return value.includes(":") ? value : `minecraft:${value}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNbtRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  return key
    .split(/[/_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
