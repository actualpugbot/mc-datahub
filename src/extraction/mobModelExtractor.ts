import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  MobModelCubeDefinition,
  MobModelDefinition,
  MobModelFaceName,
  MobModelLayerDefinition,
  MobModelPartDefinition,
  MobModelTextureDefinition,
  MobSoundDefinition,
} from "../domain/types.js";

const ENTITY_RENDERERS_SOURCE_PATH = "net/minecraft/client/renderer/entity/EntityRenderers.java";
const ENTITY_RENDERER_SOURCE_DIR = "net/minecraft/client/renderer/entity";
const MODEL_SOURCE_DIR = "net/minecraft/client/model";
const BLOCK_ENTITY_RENDERER_SOURCE_DIR = "net/minecraft/client/renderer/blockentity";
const TEXTURE_PREFIX = "assets/minecraft/textures/";
const LAYER_DEFINITIONS_SOURCE_PATH = "net/minecraft/client/model/geom/LayerDefinitions.java";
const RENDERER_TEXTURE_PATTERN = /textures\/entity\/[a-z0-9_./-]+\.png/gi;
const MODEL_LAYER_PATTERN = /ModelLayers\.([A-Z0-9_]+)/g;
const REGISTER_METHOD_REFERENCE_PATTERN = /register\(\s*EntityTypes?\.([A-Z0-9_]+)\s*,\s*([A-Za-z0-9_$.]+)::new/g;
const REGISTER_LAMBDA_PATTERN = /register\(\s*EntityTypes?\.([A-Z0-9_]+)\s*,\s*context\s*->\s*new\s+([A-Za-z0-9_$.]+)/g;
const FACE_NAMES = ["down", "up", "west", "north", "east", "south"] as const;

type Vec3 = [number, number, number];

interface BlockEntityModelSpec {
  id: string;
  localId: string;
  displayName: string;
  modelLayers: string[];
  texturePaths: string[];
}

/**
 * Block entities whose geometry is hardcoded in LayerDefinitions rather
 * than data-driven block-model JSON (beds/signs/bells are data-driven as
 * of 26.x and resolve through the normal block-model pipeline).
 */
const BLOCK_ENTITY_MODEL_SPECS: BlockEntityModelSpec[] = [
  {
    id: "minecraft:chest",
    localId: "chest",
    displayName: "Chest",
    modelLayers: ["chest"],
    texturePaths: ["assets/minecraft/textures/entity/chest/normal.png"],
  },
  {
    id: "minecraft:shulker_box",
    localId: "shulker_box",
    displayName: "Shulker Box",
    modelLayers: ["shulker_box"],
    texturePaths: ["assets/minecraft/textures/entity/shulker/shulker.png"],
  },
  {
    id: "minecraft:conduit",
    localId: "conduit",
    displayName: "Conduit",
    modelLayers: ["conduit_shell", "conduit_eye", "conduit_cage", "conduit_wind"],
    texturePaths: [
      "assets/minecraft/textures/entity/conduit/base.png",
      "assets/minecraft/textures/entity/conduit/closed_eye.png",
      "assets/minecraft/textures/entity/conduit/cage.png",
      "assets/minecraft/textures/entity/conduit/wind.png",
    ],
  },
  {
    id: "minecraft:banner",
    localId: "banner",
    displayName: "Banner",
    modelLayers: ["standing_banner", "standing_banner_flag", "wall_banner", "wall_banner_flag"],
    texturePaths: ["assets/minecraft/textures/entity/banner/base.png"],
  },
  {
    id: "minecraft:decorated_pot",
    localId: "decorated_pot",
    displayName: "Decorated Pot",
    modelLayers: ["decorated_pot_base", "decorated_pot_sides"],
    texturePaths: [
      "assets/minecraft/textures/entity/decorated_pot/decorated_pot_base.png",
      "assets/minecraft/textures/entity/decorated_pot/decorated_pot_side.png",
    ],
  },
  {
    id: "minecraft:bell",
    localId: "bell",
    displayName: "Bell",
    modelLayers: ["bell"],
    texturePaths: ["assets/minecraft/textures/entity/bell/bell_body.png"],
  },
];

interface ParsedLayerExpression {
  id: string;
  expression: string;
  modelClass?: string;
  modelMethod?: string;
}

interface ParsedPart {
  name: string;
  path: string;
  pivot: Vec3;
  rotation: Vec3;
  cubes: MobModelCubeDefinition[];
  children: ParsedPart[];
}

interface BakeContext {
  layerId: string;
  modelClass?: string;
  modelMethod?: string;
  sourcePath?: string;
  rawExpression: string;
  warnings: string[];
}

interface BuilderState {
  texU: number;
  texV: number;
  mirror: boolean;
}

interface MeshFactoryReference {
  modelClass?: string;
  methodName: string;
}

export class MobModelExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(mobs: MobSoundDefinition[], decompiledClientRoot: string): Promise<MobModelDefinition[]> {
    if (mobs.length === 0 || !(await fileExists(decompiledClientRoot))) {
      return [];
    }

    const [rendererClassesByMob, layerExpressions, modelSourcePaths] = await Promise.all([
      this.loadRendererClassesByMob(decompiledClientRoot),
      this.loadLayerExpressions(decompiledClientRoot),
      this.indexModelSources(decompiledClientRoot),
    ]);
    const bakedLayers = new Map<string, MobModelLayerDefinition>();
    const results: MobModelDefinition[] = [];

    for (const mob of mobs) {
      const rendererClass = rendererClassesByMob.get(mob.localId);
      const rendererData = rendererClass
        ? await this.collectRendererData(rendererClass, decompiledClientRoot, new Set<string>())
        : { modelLayers: [] as string[], texturePaths: [] as string[] };
      const layers: MobModelLayerDefinition[] = [];

      for (const layerId of rendererData.modelLayers) {
        const cacheKey = `${layerId}`;
        let layer = bakedLayers.get(cacheKey);
        if (!layer) {
          layer = await this.bakeLayer(layerId, layerExpressions.get(layerId), modelSourcePaths, decompiledClientRoot);
          bakedLayers.set(cacheKey, layer);
        }
        layers.push(layer);
      }

      results.push({
        id: mob.id,
        localId: mob.localId,
        displayName: mob.displayName,
        rendererClass,
        modelLayers: rendererData.modelLayers,
        texturePaths: rendererData.texturePaths,
        textureAssets: rendererData.texturePaths.map(toMobModelTextureAsset),
        layers,
      });
    }

    this.logger.debug(`Resolved ${results.length} mob model definitions.`);
    return results.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  /**
   * Bakes the ModelPart geometry of block entities that have no data-driven
   * block model (their shapes live in LayerDefinitions like mob models do).
   * Same layer schema as mob models so consumers can share the renderer.
   */
  async extractBlockEntityModels(decompiledClientRoot: string): Promise<MobModelDefinition[]> {
    if (!(await fileExists(decompiledClientRoot))) {
      return [];
    }

    const [layerExpressions, modelSourcePaths] = await Promise.all([
      this.loadLayerExpressions(decompiledClientRoot),
      this.indexModelSources(decompiledClientRoot),
    ]);
    const results: MobModelDefinition[] = [];

    for (const spec of BLOCK_ENTITY_MODEL_SPECS) {
      const layers: MobModelLayerDefinition[] = [];
      for (const layerId of spec.modelLayers) {
        layers.push(await this.bakeLayer(layerId, layerExpressions.get(layerId), modelSourcePaths, decompiledClientRoot));
      }
      results.push({
        id: spec.id,
        localId: spec.localId,
        displayName: spec.displayName,
        modelLayers: spec.modelLayers,
        texturePaths: spec.texturePaths,
        textureAssets: spec.texturePaths.map(toMobModelTextureAsset),
        layers,
      });
    }

    this.logger.debug(`Resolved ${results.length} block-entity model definitions.`);
    return results;
  }

  private async loadRendererClassesByMob(decompiledClientRoot: string): Promise<Map<string, string>> {
    const sourcePath = join(decompiledClientRoot, ENTITY_RENDERERS_SOURCE_PATH);
    if (!(await fileExists(sourcePath))) {
      return new Map();
    }

    const source = await fs.readFile(sourcePath, "utf8");
    const rendererClassesByMob = new Map<string, string>();

    for (const pattern of [REGISTER_METHOD_REFERENCE_PATTERN, REGISTER_LAMBDA_PATTERN]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const entityType = match[1];
        const rendererClass = match[2];
        if (entityType && rendererClass) {
          rendererClassesByMob.set(entityType.toLowerCase(), rendererClass);
        }
      }
    }

    return rendererClassesByMob;
  }

  private async collectRendererData(
    rendererClass: string,
    decompiledClientRoot: string,
    visitedClasses: Set<string>,
  ): Promise<{ modelLayers: string[]; texturePaths: string[] }> {
    const topLevelRendererClass = rendererClass.split(".")[0] ?? rendererClass;
    if (visitedClasses.has(topLevelRendererClass)) {
      return { modelLayers: [], texturePaths: [] };
    }

    visitedClasses.add(topLevelRendererClass);
    const rendererSourcePath = join(decompiledClientRoot, ENTITY_RENDERER_SOURCE_DIR, `${topLevelRendererClass}.java`);
    if (!(await fileExists(rendererSourcePath))) {
      return { modelLayers: [], texturePaths: [] };
    }

    const source = await fs.readFile(rendererSourcePath, "utf8");
    const modelLayers = new Set<string>();
    const texturePaths = new Set<string>();

    MODEL_LAYER_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(MODEL_LAYER_PATTERN)) {
      if (match[1]) {
        modelLayers.add(match[1].toLowerCase());
      }
    }

    RENDERER_TEXTURE_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(RENDERER_TEXTURE_PATTERN)) {
      if (match[0]) {
        texturePaths.add(`assets/minecraft/${match[0]}`);
      }
    }

    const superclass = parseSuperclassName(source);
    if (superclass) {
      const inherited = await this.collectRendererData(superclass, decompiledClientRoot, visitedClasses);
      inherited.modelLayers.forEach((layer) => modelLayers.add(layer));
      inherited.texturePaths.forEach((texture) => texturePaths.add(texture));
    }

    return {
      modelLayers: Array.from(modelLayers).sort(),
      texturePaths: Array.from(texturePaths).sort(),
    };
  }

  private async loadLayerExpressions(decompiledClientRoot: string): Promise<Map<string, ParsedLayerExpression>> {
    const sourcePath = join(decompiledClientRoot, LAYER_DEFINITIONS_SOURCE_PATH);
    if (!(await fileExists(sourcePath))) {
      return new Map();
    }

    const source = await fs.readFile(sourcePath, "utf8");
    const body = extractMethodBody(source, "createRoots")?.body ?? source;
    const variableExpressions = parseLayerVariableExpressions(body);
    const layers = new Map<string, ParsedLayerExpression>();

    for (const statement of splitStatements(body)) {
      const match = statement.match(/result\.put\(\s*ModelLayers\.([A-Z0-9_]+)\s*,\s*([\s\S]+)\)$/);
      if (!match || !match[1] || !match[2]) {
        continue;
      }

      const id = match[1].toLowerCase();
      const expression = resolveLayerExpression(match[2].trim(), variableExpressions, new Set<string>());
      const methodRef = findModelMethodReference(expression);
      layers.set(id, {
        id,
        expression,
        modelClass: methodRef?.modelClass,
        modelMethod: methodRef?.modelMethod,
      });
    }

    return layers;
  }

  private async indexModelSources(decompiledClientRoot: string): Promise<Map<string, string>> {
    const paths = new Map<string, string>();

    // LayerDefinitions references mesh factories from both trees (e.g.
    // ConduitRenderer.createShellLayer()). Index the block-entity renderers
    // first so net/minecraft/client/model wins simple-name collisions.
    for (const sourceDir of [BLOCK_ENTITY_RENDERER_SOURCE_DIR, MODEL_SOURCE_DIR]) {
      const root = join(decompiledClientRoot, sourceDir);
      if (!(await fileExists(root))) {
        continue;
      }

      for (const path of await listJavaFiles(root)) {
        const normalizedPath = path.replace(/\\/g, "/");
        const className = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1).replace(/\.java$/, "");
        paths.set(className, path);
      }
    }

    return paths;
  }

  private async bakeLayer(
    layerId: string,
    expression: ParsedLayerExpression | undefined,
    modelSourcePaths: Map<string, string>,
    decompiledClientRoot: string,
  ): Promise<MobModelLayerDefinition> {
    const warnings: string[] = [];
    if (!expression) {
      return { id: layerId, status: "unresolved", warnings: [`No LayerDefinitions entry was found for ${layerId}.`] };
    }

    if (!expression.modelClass || !expression.modelMethod) {
      return {
        id: layerId,
        rawExpression: expression.expression,
        status: "unresolved",
        warnings: [`Could not resolve a model class/method from ${expression.expression}.`],
      };
    }

    const sourcePath = modelSourcePaths.get(expression.modelClass);
    if (!sourcePath) {
      return {
        id: layerId,
        modelClass: expression.modelClass,
        modelMethod: expression.modelMethod,
        rawExpression: expression.expression,
        status: "unresolved",
        warnings: [`Could not find source for ${expression.modelClass}.`],
      };
    }

    const source = await fs.readFile(sourcePath, "utf8");
    const context: BakeContext = {
      layerId,
      modelClass: expression.modelClass,
      modelMethod: expression.modelMethod,
      sourcePath: toSourceRelativePath(decompiledClientRoot, sourcePath),
      rawExpression: expression.expression,
      warnings,
    };
    const baked = await bakeModelSource(source, expression.modelMethod, context, modelSourcePaths);
    return baked;
  }
}

export async function bakeModelSource(
  source: string,
  methodName: string,
  context: BakeContext,
  modelSourcePaths = new Map<string, string>(),
): Promise<MobModelLayerDefinition> {
  const rootMethod = extractMethodBody(source, methodName);
  if (!rootMethod) {
    return unresolvedLayer(context, `Could not find static method ${methodName}.`);
  }

  const textureSize = parseTextureSize(rootMethod.body) ?? parseTextureSize(context.rawExpression);
  const bodyResult = await collectMethodBodies(source, methodName, context.modelClass, modelSourcePaths, new Set<string>());
  const body = bodyResult.body;
  const parts = parseParts(body, textureSize ?? [64, 64]);
  const root = buildPartTree(parts);
  const warnings = [...context.warnings, ...bodyResult.warnings];

  if (!textureSize) {
    warnings.push("Could not resolve texture size; defaulted face UV normalization to 64x64.");
  }
  if (root.children.length === 0 && root.cubes.length === 0) {
    warnings.push("No model parts were parsed from the layer method.");
  }

  return {
    id: context.layerId,
    modelClass: context.modelClass,
    modelMethod: context.modelMethod,
    sourcePath: context.sourcePath,
    textureSize,
    root,
    rawExpression: context.rawExpression,
    status: root.children.length > 0 || root.cubes.length > 0 ? (warnings.length > 0 ? "partial" : "baked") : "unresolved",
    warnings,
  };
}

export function bakeCubeFaces(
  texU: number,
  texV: number,
  width: number,
  height: number,
  depth: number,
  textureWidth: number,
  textureHeight: number,
): MobModelCubeDefinition["faces"] {
  const u0 = texU;
  const u1 = texU + depth;
  const u2 = texU + depth + width;
  const u22 = texU + depth + width + width;
  const u3 = texU + depth + width + depth;
  const u4 = texU + depth + width + depth + width;
  const v0 = texV;
  const v1 = texV + depth;
  const v2 = texV + depth + height;
  const pixels: Record<MobModelFaceName, [number, number, number, number]> = {
    down: [u1, v0, u2, v1],
    up: [u2, v1, u22, v0],
    west: [u0, v1, u1, v2],
    north: [u1, v1, u2, v2],
    east: [u2, v1, u3, v2],
    south: [u3, v1, u4, v2],
  };

  return Object.fromEntries(
    FACE_NAMES.map((face) => {
      const uv = pixels[face];
      return [
        face,
        {
          uv,
          normalizedUv: [uv[0] / textureWidth, uv[1] / textureHeight, uv[2] / textureWidth, uv[3] / textureHeight],
        },
      ];
    }),
  ) as MobModelCubeDefinition["faces"];
}

function parseParts(body: string, textureSize: [number, number]): ParsedPart[] {
  const builderVariables = parseBuilderVariables(body);
  const partVariables = new Map<string, ParsedPart>();
  const parts: ParsedPart[] = [];
  const rootPart: ParsedPart = { name: "root", path: "root", pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [], children: [] };
  partVariables.set("root", rootPart);

  for (const statement of splitStatements(body)) {
    const rootAlias = parseRootPartAlias(statement);
    if (rootAlias) {
      partVariables.set(rootAlias, rootPart);
      continue;
    }

    if (!statement.includes(".addOrReplaceChild(")) {
      continue;
    }

    const call = parseAddChildStatement(statement);
    if (!call) {
      continue;
    }

    const parent = resolveParentPart(call.parentExpression, partVariables, rootPart);
    const builderExpression = builderVariables.get(call.builderExpression) ?? call.builderExpression;
    const part: ParsedPart = {
      name: call.name,
      path: `${parent.path}/${call.name}`,
      pivot: call.pose.pivot,
      rotation: call.pose.rotation,
      cubes: parseCubeBuilder(builderExpression, textureSize),
      children: [],
    };
    parent.children.push(part);
    parts.push(part);

    if (call.assignedVariable) {
      partVariables.set(call.assignedVariable, part);
    }
  }

  return parts;
}

function buildPartTree(parts: ParsedPart[]): MobModelPartDefinition {
  const root: MobModelPartDefinition = {
    name: "root",
    path: "root",
    pivot: [0, 0, 0],
    rotation: [0, 0, 0],
    cubes: [],
    children: [],
  };
  const byPath = new Map<string, MobModelPartDefinition>([[root.path, root]]);

  for (const part of parts) {
    const converted: MobModelPartDefinition = {
      name: part.name,
      path: part.path,
      pivot: part.pivot,
      rotation: part.rotation,
      cubes: part.cubes,
      children: [],
    };
    byPath.set(converted.path, converted);
  }

  for (const part of byPath.values()) {
    if (part.path === "root") {
      continue;
    }

    const parentPath = part.path.slice(0, part.path.lastIndexOf("/")) || "root";
    const parent = byPath.get(parentPath) ?? root;
    if (!parent.children.includes(part)) {
      parent.children.push(part);
    }
  }

  sortParts(root);
  return root;
}

function sortParts(part: MobModelPartDefinition): void {
  part.children.sort((left, right) => left.name.localeCompare(right.name));
  part.children.forEach(sortParts);
}

function parseBuilderVariables(body: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const statement of splitStatements(body)) {
    const match = statement.match(/^CubeListBuilder\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (match?.[1] && match[2]) {
      variables.set(match[1], match[2].trim());
    }
  }
  return variables;
}

function parseAddChildStatement(statement: string):
  | {
      assignedVariable?: string;
      parentExpression: string;
      name: string;
      builderExpression: string;
      pose: { pivot: Vec3; rotation: Vec3 };
    }
  | undefined {
  const match = statement.match(/^(?:(?:PartDefinition\s+)?(\w+)\s*=\s*)?(.+?)\s*\.\s*addOrReplaceChild\s*\(/);
  if (!match?.[2]) {
    return undefined;
  }

  const openIndex = statement.indexOf("(", statement.indexOf(".addOrReplaceChild"));
  const closeIndex = findMatching(statement, openIndex, "(", ")");
  if (openIndex < 0 || closeIndex < 0) {
    return undefined;
  }

  const args = splitTopLevelArgs(statement.slice(openIndex + 1, closeIndex));
  const name = parseStringLiteral(args[0]);
  if (!name || !args[1]) {
    return undefined;
  }

  return {
    assignedVariable: match[1],
    parentExpression: match[2].trim(),
    name,
    builderExpression: args[1].trim(),
    pose: parsePartPose(args[2]),
  };
}

function parseRootPartAlias(statement: string): string | undefined {
  const match = statement.match(/^PartDefinition\s+(\w+)\s*=\s*\w+\.getRoot\(\)$/);
  return match?.[1];
}

function resolveParentPart(parentExpression: string, partVariables: Map<string, ParsedPart>, rootPart: ParsedPart): ParsedPart {
  const normalized = parentExpression.replace(/\s+/g, "");
  if (normalized.endsWith(".getRoot()")) {
    return rootPart;
  }

  return partVariables.get(parentExpression.trim()) ?? rootPart;
}

function parseCubeBuilder(expression: string, textureSize: [number, number]): MobModelCubeDefinition[] {
  const cubes: MobModelCubeDefinition[] = [];
  const state: BuilderState = { texU: 0, texV: 0, mirror: false };
  let index = 0;

  while (index < expression.length) {
    const callMatch = /\.(texOffs|mirror|addBox)\s*\(/g;
    callMatch.lastIndex = index;
    const match = callMatch.exec(expression);
    if (!match || !match[1]) {
      break;
    }

    const openIndex = expression.indexOf("(", match.index);
    const closeIndex = findMatching(expression, openIndex, "(", ")");
    if (openIndex < 0 || closeIndex < 0) {
      break;
    }

    const args = splitTopLevelArgs(expression.slice(openIndex + 1, closeIndex));
    if (match[1] === "texOffs") {
      state.texU = parseNumber(args[0]) ?? state.texU;
      state.texV = parseNumber(args[1]) ?? state.texV;
    } else if (match[1] === "mirror") {
      state.mirror = args.length === 0 ? true : args[0]?.trim() !== "false";
    } else {
      const cube = parseAddBox(args, state, textureSize);
      if (cube) {
        cubes.push(cube);
      }
    }

    index = closeIndex + 1;
  }

  return cubes;
}

function parseAddBox(args: string[], state: BuilderState, textureSize: [number, number]): MobModelCubeDefinition | undefined {
  let cursor = 0;
  const name = parseStringLiteral(args[0]);
  if (name) {
    cursor = 1;
  }

  const values = args.slice(cursor, cursor + 6).map(parseNumber);
  if (values.some((value) => value === undefined)) {
    return undefined;
  }

  const [x, y, z, width, height, depth] = values as [number, number, number, number, number, number];
  const deformation = parseCubeDeformation(args[cursor + 6]);

  return {
    ...(name ? { name } : {}),
    origin: [x, y, z],
    size: [width, height, depth],
    deformation,
    mirror: state.mirror,
    texOffs: [state.texU, state.texV],
    faces: bakeCubeFaces(state.texU, state.texV, width, height, depth, textureSize[0], textureSize[1]),
  };
}

function parsePartPose(expression: string | undefined): { pivot: Vec3; rotation: Vec3 } {
  if (!expression || expression.includes("PartPose.ZERO")) {
    return { pivot: [0, 0, 0], rotation: [0, 0, 0] };
  }

  const call = parseCall(expression);
  if (!call) {
    return { pivot: [0, 0, 0], rotation: [0, 0, 0] };
  }

  const values = call.args.map(parseNumber);
  if (call.name.endsWith("offsetAndRotation") && values.length >= 6) {
    return {
      pivot: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0],
      rotation: [values[3] ?? 0, values[4] ?? 0, values[5] ?? 0],
    };
  }

  if (call.name.endsWith("offset") && values.length >= 3) {
    return { pivot: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0], rotation: [0, 0, 0] };
  }

  return { pivot: [0, 0, 0], rotation: [0, 0, 0] };
}

function parseCubeDeformation(expression: string | undefined): Vec3 {
  if (!expression || expression.includes("CubeDeformation.NONE")) {
    return [0, 0, 0];
  }

  const call = parseCall(expression.replace(/^new\s+/, ""));
  if (!call || !call.name.endsWith("CubeDeformation")) {
    return [0, 0, 0];
  }

  const values = call.args.map(parseNumber).filter((value): value is number => value !== undefined);
  if (values.length === 1) {
    return [values[0] ?? 0, values[0] ?? 0, values[0] ?? 0];
  }

  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function parseLayerVariableExpressions(source: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const statement of splitStatements(source)) {
    const match = statement.match(/^LayerDefinition\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (match?.[1] && match[2]) {
      variables.set(match[1], match[2].trim());
    }
  }
  return variables;
}

function resolveLayerExpression(expression: string, variables: Map<string, string>, seen: Set<string>): string {
  const trimmed = expression.trim();
  const variableMatch = trimmed.match(/^(\w+)([\s\S]*)$/);
  const variableName = variableMatch?.[1];
  const suffix = variableMatch?.[2] ?? "";
  if (!variableName || seen.has(variableName)) {
    return trimmed;
  }

  const resolved = variables.get(variableName);
  if (!resolved) {
    return trimmed;
  }

  seen.add(variableName);
  return `${resolveLayerExpression(resolved, variables, seen)}${suffix}`;
}

function findModelMethodReference(expression: string): { modelClass: string; modelMethod: string } | undefined {
  const pattern = /\b([A-Z][A-Za-z0-9_]*)\.([a-zA-Z][A-Za-z0-9_]*)\s*\(/g;
  for (const match of expression.matchAll(pattern)) {
    const modelClass = match[1];
    const modelMethod = match[2];
    if (modelClass && modelMethod && modelClass !== "LayerDefinition" && modelClass !== "MeshTransformer") {
      return { modelClass, modelMethod };
    }
  }
  return undefined;
}

function parseTextureSize(source: string): [number, number] | undefined {
  const match = source.match(/LayerDefinition\.create\([\s\S]*?,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

function extractMethodBody(source: string, methodName: string): { name: string; body: string } | undefined {
  const pattern = new RegExp(
    `(?:public|private|protected)\\s+static\\s+[^{;]+\\b${escapeRegExp(methodName)}\\s*\\([^)]*\\)\\s*\\{`,
    "g",
  );
  const match = pattern.exec(source);
  if (!match) {
    return undefined;
  }

  const openIndex = source.indexOf("{", match.index);
  const closeIndex = findMatching(source, openIndex, "{", "}");
  if (openIndex < 0 || closeIndex < 0) {
    return undefined;
  }

  return { name: methodName, body: source.slice(openIndex + 1, closeIndex) };
}

async function collectMethodBodies(
  source: string,
  methodName: string,
  modelClass: string | undefined,
  modelSourcePaths: Map<string, string>,
  visited: Set<string>,
): Promise<{ body: string; warnings: string[] }> {
  const method = extractMethodBody(source, methodName);
  if (!method) {
    return { body: "", warnings: [`Could not find helper method ${methodName}.`] };
  }

  const key = `${modelClass ?? "<local>"}.${methodName}`;
  if (visited.has(key)) {
    return { body: method.body, warnings: [] };
  }
  visited.add(key);

  const warnings: string[] = [];
  const bodies: string[] = [];
  for (const reference of findMeshFactoryReferences(method.body, methodName)) {
    const target = await resolveMethodSource(source, reference, modelClass, modelSourcePaths, warnings);
    if (!target) {
      continue;
    }

    const targetKey = `${target.modelClass}.${reference.methodName}`;
    if (visited.has(targetKey)) {
      continue;
    }

    const nested = await collectMethodBodies(target.source, reference.methodName, target.modelClass, modelSourcePaths, visited);
    bodies.push(nested.body);
    warnings.push(...nested.warnings);
  }

  bodies.push(method.body);
  return { body: bodies.filter(Boolean).join("\n"), warnings };
}

function findMeshFactoryReferences(source: string, currentMethodName: string): MeshFactoryReference[] {
  const references: MeshFactoryReference[] = [];
  const pattern = /\b(?:MeshDefinition\s+\w+\s*=\s*|LayerDefinition\.create\(\s*|return\s+)(?:(\w+)\.)?(\w+)\s*\(/g;

  for (const match of source.matchAll(pattern)) {
    addMeshFactoryReference(references, match[1], match[2], currentMethodName);
  }

  const layerCreatePattern = /LayerDefinition\.create\(\s*(?:(\w+)\.)?(\w+)\s*\(/g;
  for (const match of source.matchAll(layerCreatePattern)) {
    addMeshFactoryReference(references, match[1], match[2], currentMethodName);
  }

  return references;
}

function addMeshFactoryReference(
  references: MeshFactoryReference[],
  modelClass: string | undefined,
  methodName: string | undefined,
  currentMethodName: string,
): void {
  if (!methodName || methodName === currentMethodName || modelClass === "LayerDefinition" || modelClass === "MeshTransformer") {
    return;
  }

  if (!methodName.startsWith("create")) {
    return;
  }

  if (references.some((reference) => reference.modelClass === modelClass && reference.methodName === methodName)) {
    return;
  }

  references.push({ modelClass, methodName });
}

async function readModelSource(
  modelClass: string,
  modelSourcePaths: Map<string, string>,
  warnings: string[],
): Promise<string | undefined> {
  const sourcePath = modelSourcePaths.get(modelClass);
  if (!sourcePath) {
    warnings.push(`Could not find source for helper model class ${modelClass}.`);
    return undefined;
  }

  try {
    return await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    warnings.push(`Could not read source for helper model class ${modelClass}: ${(error as Error).message}`);
    return undefined;
  }
}

async function resolveMethodSource(
  currentSource: string,
  reference: MeshFactoryReference,
  currentClass: string | undefined,
  modelSourcePaths: Map<string, string>,
  warnings: string[],
): Promise<{ modelClass: string; source: string } | undefined> {
  if (reference.modelClass) {
    const source =
      reference.modelClass === currentClass
        ? currentSource
        : await readModelSource(reference.modelClass, modelSourcePaths, warnings);
    return source ? { modelClass: reference.modelClass, source } : undefined;
  }

  if (!currentClass) {
    return undefined;
  }

  if (extractMethodBody(currentSource, reference.methodName)) {
    return { modelClass: currentClass, source: currentSource };
  }

  const superclass = parseSuperclassName(currentSource);
  if (!superclass) {
    warnings.push(`Could not find helper method ${reference.methodName} on ${currentClass}.`);
    return undefined;
  }

  const superclassSource = await readModelSource(superclass, modelSourcePaths, warnings);
  if (!superclassSource) {
    return undefined;
  }

  if (extractMethodBody(superclassSource, reference.methodName)) {
    return { modelClass: superclass, source: superclassSource };
  }

  return resolveMethodSource(superclassSource, reference, superclass, modelSourcePaths, warnings);
}

function toMobModelTextureAsset(sourcePath: string): MobModelTextureDefinition {
  const relativePath = sourcePath.startsWith(TEXTURE_PREFIX) ? sourcePath.slice(TEXTURE_PREFIX.length) : sourcePath;
  return {
    id: `minecraft:${relativePath.replace(/\.png$/i, "")}`,
    sourcePath,
    imagePath: `images/${relativePath}`,
  };
}

function parseCall(expression: string): { name: string; args: string[] } | undefined {
  const normalized = expression.trim();
  const openIndex = normalized.indexOf("(");
  if (openIndex < 0) {
    return undefined;
  }

  const closeIndex = findMatching(normalized, openIndex, "(", ")");
  if (closeIndex < 0) {
    return undefined;
  }

  return {
    name: normalized.slice(0, openIndex).trim(),
    args: splitTopLevelArgs(normalized.slice(openIndex + 1, closeIndex)),
  };
}

function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;

    if (character === ";" && parentheses === 0 && braces === 0 && brackets === 0) {
      const statement = source.slice(start, index).replace(/\s+/g, " ").trim();
      if (statement) {
        statements.push(statement);
      }
      start = index + 1;
    }
  }

  return statements;
}

function splitTopLevelArgs(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;

    if (character === "," && parentheses === 0 && braces === 0 && brackets === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const last = value.slice(start).trim();
  if (last) {
    parts.push(last);
  }
  return parts;
}

function findMatching(value: string, openIndex: number, open: string, close: string): number {
  if (openIndex < 0) {
    return -1;
  }

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = openIndex; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function parseStringLiteral(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^"([^"]+)"$/);
  return match?.[1];
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .replace(/\(float\)/g, "")
    .replace(/[fFdD]/g, "")
    .replace(/\s+/g, "")
    .replace(/^\((.*)\)$/, "$1");
  const piMatch = normalized.match(/^(-?)Math\.PI(?:\/(\d+(?:\.\d+)?))?$/);
  if (piMatch) {
    const sign = piMatch[1] === "-" ? -1 : 1;
    const divisor = piMatch[2] ? Number.parseFloat(piMatch[2]) : 1;
    return (sign * Math.PI) / divisor;
  }

  const match = normalized.match(/^-?\d+(?:\.\d+)?$/);
  return match ? Number.parseFloat(match[0]) : undefined;
}

function parseSuperclassName(source: string): string | undefined {
  const match = source.match(/\b(?:class|record)\s+[A-Za-z0-9_$]+(?:<[^>{]+>)?\s+extends\s+([A-Za-z0-9_$.]+)/);
  return match?.[1]?.split(".").pop();
}

function unresolvedLayer(context: BakeContext, warning: string): MobModelLayerDefinition {
  return {
    id: context.layerId,
    modelClass: context.modelClass,
    modelMethod: context.modelMethod,
    sourcePath: context.sourcePath,
    rawExpression: context.rawExpression,
    status: "unresolved",
    warnings: [...context.warnings, warning],
  };
}

async function listJavaFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      files.push(path);
    }
  }

  return files;
}

function toSourceRelativePath(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
