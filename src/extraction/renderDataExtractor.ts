import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import type { ArchiveSource } from "../archive/archiveSource.js";
import { MergedArchiveSource } from "../archive/archiveSource.js";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  AtlasRenderDefinition,
  BlockDefinition,
  BlockRenderLayerKind,
  BlockstateModelVariant,
  BlockstateRenderDefinition,
  ClientItemRenderDefinition,
  EntityRendererDefinition,
  EntityRenderDefinition,
  JsonValue,
  MinecraftRenderDataset,
  MobModelDefinition,
  RenderLayerDefinition,
  RenderModelElement,
  RenderProvenance,
  ResolvedRenderModel,
  SpecialRendererDefinition,
  TextureRenderDefinition,
  TintDefinition,
  TranslationEntry,
} from "../domain/types.js";
import { idFromAssetPath, normalizeMinecraftId } from "./normalizers.js";

const BLOCKSTATE_PREFIX = "assets/minecraft/blockstates/";
const MODEL_PREFIX = "assets/minecraft/models/";
const BLOCK_MODEL_PREFIX = "assets/minecraft/models/block/";
const ITEM_MODEL_PREFIX = "assets/minecraft/models/item/";
const CLIENT_ITEM_PREFIX = "assets/minecraft/items/";
const TEXTURE_PREFIX = "assets/minecraft/textures/";
const ATLAS_PREFIX = "assets/minecraft/atlases/";
const FACE_NAMES = ["down", "up", "north", "south", "west", "east"] as const;
const DISPLAY_CONTEXTS = [
  "gui",
  "ground",
  "fixed",
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
  "head",
] as const;

const SPECIAL_RENDERER_KINDS: Record<string, { target: SpecialRendererDefinition["target"]; ids: string[] }> = {
  banner: { target: "block_entity", ids: ["banner", "wall_banner"] },
  bed: { target: "block_entity", ids: ["bed"] },
  bow: { target: "item", ids: ["bow"] },
  chest: { target: "block_entity", ids: ["chest", "trapped_chest", "ender_chest", "copper_chest"] },
  clock: { target: "item", ids: ["clock"] },
  compass: { target: "item", ids: ["compass", "recovery_compass"] },
  conduit: { target: "block_entity", ids: ["conduit"] },
  copper_golem_statue: { target: "block_entity", ids: ["copper_golem_statue"] },
  crossbow: { target: "item", ids: ["crossbow"] },
  decorated_pot: { target: "block_entity", ids: ["decorated_pot"] },
  map: { target: "item", ids: ["filled_map", "map"] },
  hanging_sign: { target: "block_entity", ids: ["hanging_sign"] },
  shield: { target: "item", ids: ["shield"] },
  shulker_box: { target: "block_entity", ids: ["shulker_box"] },
  sign: { target: "block_entity", ids: ["sign"] },
  skull: { target: "block_entity", ids: ["skull", "head"] },
  spyglass: { target: "item", ids: ["spyglass"] },
  trident: { target: "item", ids: ["trident"] },
};

type ObjectJson = { [key: string]: JsonValue };
type Vec3 = [number, number, number];

interface RawModel {
  id: string;
  kind: "block" | "item" | "other";
  sourcePath: string;
  raw: ObjectJson;
}

interface ResolvedModelData {
  id: string;
  kind: "block" | "item" | "other";
  sourcePath: string;
  parent?: string;
  parentChain: string[];
  raw: ObjectJson;
  textures: Record<string, string>;
  elements: JsonValue[];
  display?: JsonValue;
  ambientOcclusion?: boolean;
  guiLight?: string;
}

export class RenderDataExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(
    version: string,
    sources: ArchiveSource[],
    options: {
      translations?: TranslationEntry[];
      blocks?: BlockDefinition[];
      mobModels?: MobModelDefinition[];
      decompiledClientRoot?: string;
    } = {},
  ): Promise<MinecraftRenderDataset> {
    const source = new MergedArchiveSource(sources);
    const paths = await source.listPaths();
    const translations = new Map((options.translations ?? []).map((entry) => [entry.key, entry.value]));
    const rawModels = await this.readRawModels(paths, source);
    const rawModelMap = new Map(rawModels.map((model) => [model.id, model]));
    const resolvedModels = this.resolveModels(rawModels, rawModelMap);
    const resolvedModelMap = new Map(resolvedModels.map((model) => [model.id, model]));
    const textures = await this.readTextures(paths, source);
    const textureMap = new Map(textures.map((texture) => [texture.id, texture]));
    const atlases = await this.readAtlases(paths, source);
    this.attachAtlasMembership(textures, atlases);
    const entityModels = this.enrichEntityModelTextures(
      options.mobModels ?? [],
      await this.readEntityVariantTextureAssets(paths, source),
      textureMap,
    );

    const blockstates = await this.readBlockstates(paths, source);
    const itemDisplays = await this.readClientItems(paths, source, resolvedModelMap, translations);
    const tints = this.buildTints(blockstates, itemDisplays);
    const renderLayers = this.buildRenderLayers(blockstates, resolvedModelMap, textureMap);
    const entityRenderers = await this.buildEntityRenderers(entityModels, options.decompiledClientRoot);
    const entities = this.buildEntities(entityRenderers);
    const specialRenderers = await this.buildSpecialRenderers(paths, itemDisplays, options.decompiledClientRoot);

    return {
      version,
      generatedAt: new Date().toISOString(),
      blocks: (options.blocks ?? []).slice().sort((left, right) => left.id.localeCompare(right.id)),
      blockstates,
      blockModels: resolvedModels.filter((model) => model.kind === "block").sort(byId),
      itemModels: resolvedModels.filter((model) => model.kind === "item").sort(byId),
      itemDisplays,
      textures: textures.sort(byId),
      atlases,
      renderLayers,
      tints,
      entities,
      entityModels,
      entityRenderers,
      specialRenderers,
    };
  }

  private async readRawModels(paths: string[], source: ArchiveSource): Promise<RawModel[]> {
    const modelPaths = paths.filter((path) => path.startsWith(MODEL_PREFIX) && path.endsWith(".json"));
    const models: RawModel[] = [];

    for (const path of modelPaths) {
      const raw = await source.readJson<JsonValue>(path);
      if (!isObject(raw)) {
        continue;
      }

      models.push({
        id: idFromAssetPath(MODEL_PREFIX, path),
        kind: path.startsWith(BLOCK_MODEL_PREFIX) ? "block" : path.startsWith(ITEM_MODEL_PREFIX) ? "item" : "other",
        sourcePath: path,
        raw,
      });
    }

    return models.sort(byId);
  }

  private resolveModels(models: RawModel[], modelMap: Map<string, RawModel>): ResolvedRenderModel[] {
    const cache = new Map<string, ResolvedModelData>();
    return models.map((model) => this.toResolvedRenderModel(this.resolveModel(model.id, modelMap, cache, new Set<string>())));
  }

  private resolveModel(
    id: string,
    modelMap: Map<string, RawModel>,
    cache: Map<string, ResolvedModelData>,
    visiting: Set<string>,
  ): ResolvedModelData {
    const cached = cache.get(id);
    if (cached) {
      return cached;
    }

    const model = modelMap.get(id);
    if (!model) {
      const missing: ResolvedModelData = {
        id,
        kind: "other",
        sourcePath: "",
        raw: {},
        textures: {},
        elements: [],
        parentChain: [],
      };
      cache.set(id, missing);
      return missing;
    }

    if (visiting.has(id)) {
      return {
        id,
        kind: model.kind,
        sourcePath: model.sourcePath,
        raw: model.raw,
        textures: {},
        elements: [],
        parentChain: [],
      };
    }

    visiting.add(id);
    const parent = typeof model.raw.parent === "string" ? normalizeMinecraftId(model.raw.parent) : undefined;
    const parentData = parent ? this.resolveModel(parent, modelMap, cache, visiting) : undefined;
    visiting.delete(id);

    const localTextures = isObject(model.raw.textures) ? normalizeTextureMap(model.raw.textures) : {};
    const textures = { ...(parentData?.textures ?? {}), ...localTextures };
    const result: ResolvedModelData = {
      id,
      kind: model.kind,
      sourcePath: model.sourcePath,
      parent,
      parentChain: parent ? [parent, ...(parentData?.parentChain ?? [])] : [],
      raw: model.raw,
      textures,
      elements: Array.isArray(model.raw.elements) ? model.raw.elements : (parentData?.elements ?? []),
      display: model.raw.display ?? parentData?.display,
      ambientOcclusion:
        typeof model.raw.ambientocclusion === "boolean" ? model.raw.ambientocclusion : parentData?.ambientOcclusion,
      guiLight: typeof model.raw.gui_light === "string" ? model.raw.gui_light : parentData?.guiLight,
    };
    cache.set(id, result);
    return result;
  }

  private toResolvedRenderModel(model: ResolvedModelData): ResolvedRenderModel {
    const unresolvedTextures = new Set<string>();
    const elements = model.elements.map((element) => this.resolveElement(element, model.textures, unresolvedTextures));

    return {
      id: model.id,
      kind: model.kind,
      sourcePath: model.sourcePath,
      parent: model.parent,
      parentChain: model.parentChain,
      textures: model.textures,
      unresolvedTextures: Array.from(unresolvedTextures).sort(),
      elements,
      display: model.display,
      ambientOcclusion: model.ambientOcclusion,
      guiLight: model.guiLight,
      raw: model.raw,
      provenance: { kind: "asset", path: model.sourcePath },
    };
  }

  private resolveElement(
    element: JsonValue,
    textures: Record<string, string>,
    unresolvedTextures: Set<string>,
  ): RenderModelElement {
    const object = isObject(element) ? element : {};
    const faces = isObject(object.faces) ? object.faces : {};
    const resolvedFaces: RenderModelElement["faces"] = {};

    for (const faceName of FACE_NAMES) {
      const face = faces[faceName];
      if (!isObject(face)) {
        continue;
      }

      const texture = typeof face.texture === "string" ? face.texture : undefined;
      const resolvedTextureId = texture ? resolveTextureReference(texture, textures, unresolvedTextures) : undefined;
      resolvedFaces[faceName] = {
        texture,
        resolvedTextureId,
        uv: toVec4(face.uv),
        rotation: typeof face.rotation === "number" ? face.rotation : 0,
        cullface: typeof face.cullface === "string" ? face.cullface : undefined,
        tintIndex: typeof face.tintindex === "number" ? face.tintindex : undefined,
      };
    }

    return {
      from: toVec3(object.from) ?? [0, 0, 0],
      to: toVec3(object.to) ?? [16, 16, 16],
      rotation: object.rotation,
      shade: typeof object.shade === "boolean" ? object.shade : undefined,
      faces: resolvedFaces,
    };
  }

  private async readBlockstates(paths: string[], source: ArchiveSource): Promise<BlockstateRenderDefinition[]> {
    const blockstatePaths = paths.filter((path) => path.startsWith(BLOCKSTATE_PREFIX) && path.endsWith(".json"));
    const blockstates: BlockstateRenderDefinition[] = [];

    for (const path of blockstatePaths) {
      const raw = await source.readJson<JsonValue>(path);
      const id = idFromAssetPath(BLOCKSTATE_PREFIX, path);
      const variants: Record<string, BlockstateModelVariant[]> = {};
      const multipart: BlockstateRenderDefinition["multipart"] = [];
      const modelRefs = new Set<string>();

      if (isObject(raw) && isObject(raw.variants)) {
        for (const [key, value] of Object.entries(raw.variants).sort(([left], [right]) => left.localeCompare(right))) {
          const normalized = normalizeVariantList(value, path);
          variants[key] = normalized;
          normalized.forEach((variant) => modelRefs.add(variant.model));
        }
      }

      if (isObject(raw) && Array.isArray(raw.multipart)) {
        for (const part of raw.multipart) {
          if (!isObject(part)) {
            continue;
          }
          const apply = normalizeVariantList(part.apply, path);
          apply.forEach((variant) => modelRefs.add(variant.model));
          multipart.push({
            when: part.when,
            apply,
            provenance: { kind: "asset", path },
          });
        }
      }

      blockstates.push({
        id,
        sourcePath: path,
        properties: inferBlockstateProperties(variants, multipart),
        defaultState: inferDefaultState(variants),
        variants,
        multipart,
        modelRefs: Array.from(modelRefs).sort(),
        raw,
        provenance: { kind: "asset", path },
      });
    }

    return blockstates.sort(byId);
  }

  private async readClientItems(
    paths: string[],
    source: ArchiveSource,
    modelMap: Map<string, ResolvedRenderModel>,
    translations: Map<string, string>,
  ): Promise<ClientItemRenderDefinition[]> {
    const clientItemPaths = paths.filter((path) => path.startsWith(CLIENT_ITEM_PREFIX) && path.endsWith(".json"));
    const itemPaths =
      clientItemPaths.length > 0
        ? clientItemPaths
        : paths.filter((path) => path.startsWith(ITEM_MODEL_PREFIX) && path.endsWith(".json"));
    const displays: ClientItemRenderDefinition[] = [];

    for (const path of itemPaths) {
      const raw = await source.readJson<JsonValue>(path);
      if (!isObject(raw)) {
        continue;
      }

      const id = idFromAssetPath(path.startsWith(CLIENT_ITEM_PREFIX) ? CLIENT_ITEM_PREFIX : ITEM_MODEL_PREFIX, path);
      if (id.endsWith(":generated") || id.endsWith(":handheld") || id.includes(":template_")) {
        continue;
      }

      const modelNode = path.startsWith(CLIENT_ITEM_PREFIX)
        ? raw.model
        : ({ type: "minecraft:model", model: normalizeMinecraftId(`item/${id.replace(/^minecraft:/, "")}`) } as JsonValue);
      const modelRefs = collectItemModelRefs(modelNode);
      const modelRef = modelRefs[0];
      const resolvedModel = modelRef ? modelMap.get(modelRef) : undefined;
      const textureLayers = resolvedModel
        ? Object.entries(resolvedModel.textures)
            .filter(([key]) => key.startsWith("layer"))
            .map(([, value]) => normalizeMinecraftId(value))
            .sort()
        : [];
      const specialRendererKinds = collectSpecialRendererKinds(modelNode);
      const resolvedRaw = isObject(resolvedModel?.raw) ? resolvedModel.raw : undefined;
      const overrides = resolvedRaw && Array.isArray(resolvedRaw.overrides) ? resolvedRaw.overrides : [];

      displays.push({
        id,
        displayName:
          translations.get(`item.minecraft.${id.replace(/^minecraft:/, "")}`) ??
          translations.get(`block.minecraft.${id.replace(/^minecraft:/, "")}`) ??
          humanizeId(id),
        sourcePath: path,
        modelRef,
        renderKind: inferItemRenderKind(modelNode, resolvedModel, specialRendererKinds),
        textureLayers,
        overrides,
        predicates: collectPredicates(modelNode, overrides),
        displayTransforms: collectDisplayTransforms(modelNode, resolvedModel),
        guiDescriptor: buildGuiDescriptor(id, modelNode, modelRef, specialRendererKinds),
        specialRendererKinds,
        raw,
        provenance: { kind: "asset", path },
      });
    }

    return displays.sort(byId);
  }

  private async readTextures(paths: string[], source: ArchiveSource): Promise<TextureRenderDefinition[]> {
    const texturePaths = paths.filter((path) => path.startsWith(TEXTURE_PREFIX) && path.endsWith(".png"));
    const textures: TextureRenderDefinition[] = [];

    for (const path of texturePaths) {
      const buffer = await source.readBuffer(path);
      const dimensions = readPngDimensions(buffer);
      const animationPath = `${path}.mcmeta`;
      const animation = (await source.has(animationPath)) ? await source.readJson<JsonValue>(animationPath) : undefined;
      textures.push({
        id: idFromAssetPath(TEXTURE_PREFIX, path),
        sourcePath: path,
        imagePath: `images/${path.slice(TEXTURE_PREFIX.length)}`,
        width: dimensions?.width,
        height: dimensions?.height,
        animation,
        atlases: [],
        kind: textureKindFromPath(path),
        transparency: classifyPngTransparency(buffer),
        provenance: { kind: "asset", path },
      });
    }

    return textures;
  }

  private async readEntityVariantTextureAssets(
    paths: string[],
    source: ArchiveSource,
  ): Promise<Map<string, MobModelDefinition["textureAssets"]>> {
    const variantPaths = paths.filter((path) => /^data\/minecraft\/[a-z0-9_]+_variant\/.+\.json$/i.test(path));
    const variants = new Map<string, MobModelDefinition["textureAssets"]>();

    for (const path of variantPaths) {
      const match = path.match(/^data\/minecraft\/([a-z0-9_]+)_variant\/(.+)\.json$/i);
      if (!match?.[1]) {
        continue;
      }

      const localId = match[1];
      const raw = await source.readJson<JsonValue>(path);
      const assetIds = collectVariantAssetIds(raw);
      if (assetIds.length === 0) {
        continue;
      }

      const existing = variants.get(localId) ?? [];
      for (const assetId of assetIds) {
        existing.push(toTextureAsset(assetId));
      }
      variants.set(localId, uniqueTextureAssets(existing));
    }

    return variants;
  }

  private enrichEntityModelTextures(
    mobModels: MobModelDefinition[],
    variantTextureAssets: Map<string, MobModelDefinition["textureAssets"]>,
    textureMap: Map<string, TextureRenderDefinition>,
  ): MobModelDefinition[] {
    return mobModels
      .map((mobModel) => {
        let assets = uniqueTextureAssets([
          ...(mobModel.textureAssets ?? []),
          ...(variantTextureAssets.get(mobModel.localId) ?? []),
        ]).filter((asset) => textureMap.has(asset.id));
        if (assets.length === 0 && mobModel.layers.some((layer) => layer.root)) {
          assets = Array.from(textureMap.values())
            .filter(
              (texture) =>
                texture.id.startsWith(`minecraft:entity/${mobModel.localId}/`) ||
                texture.id.startsWith(`minecraft:entity/${mobModel.localId}_`) ||
                texture.id.includes(`/${mobModel.localId}_`),
            )
            .map((texture) => ({
              id: texture.id,
              sourcePath: texture.sourcePath,
              imagePath: texture.imagePath,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
        }
        return {
          ...mobModel,
          textureAssets: assets,
          texturePaths: assets.map((asset) => asset.sourcePath).sort(),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readAtlases(paths: string[], source: ArchiveSource): Promise<AtlasRenderDefinition[]> {
    const atlasPaths = paths.filter((path) => path.startsWith(ATLAS_PREFIX) && path.endsWith(".json"));
    const atlases: AtlasRenderDefinition[] = [];

    for (const path of atlasPaths) {
      const raw = await source.readJson<JsonValue>(path);
      atlases.push({
        id: idFromAssetPath(ATLAS_PREFIX, path),
        sourcePath: path,
        sources: isObject(raw) && Array.isArray(raw.sources) ? raw.sources : [],
        raw,
        provenance: { kind: "asset", path },
      });
    }

    return atlases.sort(byId);
  }

  private attachAtlasMembership(textures: TextureRenderDefinition[], atlases: AtlasRenderDefinition[]): void {
    for (const texture of textures) {
      const pathId = texture.id.replace(/^minecraft:/, "");
      for (const atlas of atlases) {
        if (atlas.sources.some((entry) => atlasSourceMentionsTexture(entry, pathId))) {
          texture.atlases.push(atlas.id);
        }
      }
      texture.atlases.sort();
    }
  }

  private buildRenderLayers(
    blockstates: BlockstateRenderDefinition[],
    modelMap: Map<string, ResolvedRenderModel>,
    textureMap: Map<string, TextureRenderDefinition>,
  ): RenderLayerDefinition[] {
    const blocksByLayer = new Map<BlockRenderLayerKind, string[]>();

    for (const blockstate of blockstates) {
      const layer = inferBlockRenderLayer(blockstate, modelMap, textureMap);
      const existing = blocksByLayer.get(layer) ?? [];
      existing.push(blockstate.id);
      blocksByLayer.set(layer, existing);
    }

    return Array.from(blocksByLayer.entries())
      .map(([layer, blocks]) => ({
        id: `minecraft:${layer}`,
        layer,
        blocks: blocks.sort(),
        source: {
          kind: "derived",
          path: "net/minecraft/client/renderer/chunk/ChunkSectionLayer.java",
          reason:
            "Chunk terrain layer is selected from sprite transparency; per-block value is derived from resolved model textures.",
        } satisfies RenderProvenance,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private buildTints(blockstates: BlockstateRenderDefinition[], itemDisplays: ClientItemRenderDefinition[]): TintDefinition[] {
    const tints: TintDefinition[] = [];
    for (const blockstate of blockstates) {
      const tintType = inferBlockTintType(blockstate.id);
      if (tintType) {
        tints.push({
          id: blockstate.id,
          target: "block",
          tintType,
          indices: [0],
          source: {
            kind: "derived",
            path: "net/minecraft/client/color/block/BlockColors.java",
            reason: "Block color provider classification is inferred from vanilla id families.",
          },
        });
      }
    }

    for (const item of itemDisplays) {
      const tintTypes = collectTintTypes(item.raw);
      for (const tintType of tintTypes) {
        tints.push({
          id: item.id,
          target: "item",
          tintType,
          indices: [0],
          source: { kind: "asset", path: item.sourcePath },
        });
      }
    }

    return tints.sort((left, right) =>
      `${left.target}:${left.id}:${left.tintType}`.localeCompare(`${right.target}:${right.id}:${right.tintType}`),
    );
  }

  private async buildEntityRenderers(
    mobModels: MobModelDefinition[],
    decompiledClientRoot?: string,
  ): Promise<EntityRendererDefinition[]> {
    const sourceByClass = decompiledClientRoot ? await indexRendererSources(decompiledClientRoot) : new Map<string, string>();
    return mobModels
      .map((mob) => {
        const sourcePath = mob.rendererClass
          ? sourceByClass.get(mob.rendererClass.split(".")[0] ?? mob.rendererClass)
          : undefined;
        return {
          id: mob.id,
          displayName: mob.displayName,
          rendererClass: mob.rendererClass,
          sourcePath,
          modelLayers: mob.modelLayers,
          textureAssets: mob.textureAssets,
          variantTextures: Object.fromEntries(
            mob.textureAssets.map((texture) => [variantIdFromTexture(texture.id, mob.localId), texture.id]).sort(),
          ),
          overlays: inferEntityOverlays(mob),
          source: mob.rendererClass
            ? { kind: "client-source", path: sourcePath, className: mob.rendererClass }
            : { kind: "fallback", reason: "No renderer class was discovered for this entity." },
        } satisfies EntityRendererDefinition;
      })
      .sort(byId);
  }

  private buildEntities(entityRenderers: EntityRendererDefinition[]): EntityRenderDefinition[] {
    return entityRenderers
      .map((renderer) => ({
        id: renderer.id,
        displayName: renderer.displayName,
        rendererId: renderer.id,
        modelLayerIds: renderer.modelLayers,
        defaultAdultLayer: renderer.modelLayers.find((layer) => !layer.includes("baby")),
        babyLayer: renderer.modelLayers.find((layer) => layer.includes("baby")),
        variantLayerIds: renderer.modelLayers.filter((layer) => layer.includes("_")),
        textureAssets: renderer.textureAssets,
        source: renderer.source,
      }))
      .sort(byId);
  }

  private async buildSpecialRenderers(
    paths: string[],
    itemDisplays: ClientItemRenderDefinition[],
    decompiledClientRoot?: string,
  ): Promise<SpecialRendererDefinition[]> {
    const sourceByClass = decompiledClientRoot
      ? await indexSpecialRendererSources(decompiledClientRoot)
      : new Map<string, string>();
    const renderers = new Map<string, SpecialRendererDefinition>();

    for (const [kind, definition] of Object.entries(SPECIAL_RENDERER_KINDS)) {
      const className = toSpecialRendererClassName(kind);
      const sourcePath = sourceByClass.get(className);
      for (const idHint of definition.ids) {
        const matchingItems = itemDisplays.filter((item) => item.id.includes(idHint) || item.specialRendererKinds.includes(kind));
        const ids = matchingItems.length > 0 ? matchingItems.map((item) => item.id) : [`minecraft:${idHint}`];
        for (const id of ids) {
          renderers.set(`${definition.target}:${id}:${kind}`, {
            id,
            target: definition.target,
            rendererKind: kind,
            sourceClass: className,
            sourceMethod: sourcePath ? "render/extractRenderState or Unbaked.bake" : undefined,
            sourcePath,
            textures: collectSpecialTextures(kind, paths),
            modelLayerIds: [],
            geometrySource: sourcePath,
            fallbackStrategy: sourcePath
              ? undefined
              : "Renderer is classified but geometry extraction from client source has not been implemented yet.",
            source: sourcePath
              ? { kind: "client-source", path: sourcePath, className }
              : { kind: "fallback", reason: `No decompiled source found for ${className}.` },
          });
        }
      }
    }

    for (const item of itemDisplays) {
      for (const kind of item.specialRendererKinds) {
        const className = toSpecialRendererClassName(kind);
        const sourcePath = sourceByClass.get(className);
        const key = `item:${item.id}:${kind}`;
        renderers.set(key, {
          id: item.id,
          target: "item",
          rendererKind: kind,
          sourceClass: className,
          sourceMethod: sourcePath ? "Unbaked.bake" : undefined,
          sourcePath,
          textures: collectSpecialTextures(kind, paths),
          modelLayerIds: [],
          geometrySource: sourcePath,
          fallbackStrategy: sourcePath
            ? undefined
            : "Item special renderer kind came from assets/minecraft/items, but source geometry was not found.",
          source: sourcePath
            ? { kind: "client-source", path: sourcePath, className }
            : { kind: "asset", path: item.sourcePath, reason: "Special renderer kind came from item model JSON." },
        });
      }
    }

    return Array.from(renderers.values()).sort((left, right) =>
      `${left.target}:${left.id}:${left.rendererKind}`.localeCompare(`${right.target}:${right.id}:${right.rendererKind}`),
    );
  }
}

function normalizeVariantList(value: JsonValue | undefined, path: string): BlockstateModelVariant[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries
    .filter(isObject)
    .map((entry) => ({
      model: typeof entry.model === "string" ? normalizeMinecraftId(entry.model) : "",
      x: typeof entry.x === "number" ? entry.x : 0,
      y: typeof entry.y === "number" ? entry.y : 0,
      uvlock: entry.uvlock === true,
      weight: typeof entry.weight === "number" ? entry.weight : 1,
      provenance: { kind: "asset" as const, path },
    }))
    .filter((entry) => entry.model);
}

function inferBlockstateProperties(
  variants: Record<string, BlockstateModelVariant[]>,
  multipart: BlockstateRenderDefinition["multipart"],
): Record<string, string[]> {
  const properties = new Map<string, Set<string>>();
  for (const key of Object.keys(variants)) {
    for (const [name, value] of parseStateKey(key)) {
      const values = properties.get(name) ?? new Set<string>();
      values.add(value);
      properties.set(name, values);
    }
  }

  const visitWhen = (value: JsonValue | undefined): void => {
    if (!isObject(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "OR" || key === "AND") {
        if (Array.isArray(entry)) {
          entry.forEach(visitWhen);
        }
      } else if (typeof entry === "string") {
        const values = properties.get(key) ?? new Set<string>();
        entry.split("|").forEach((part) => values.add(part));
        properties.set(key, values);
      }
    }
  };
  multipart.forEach((part) => visitWhen(part.when));

  return Object.fromEntries(
    Array.from(properties.entries())
      .map(([key, values]) => [key, Array.from(values).sort()] as [string, string[]])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function inferDefaultState(variants: Record<string, BlockstateModelVariant[]>): Record<string, string> | undefined {
  if (variants[""]) {
    return {};
  }
  const firstKey = Object.keys(variants).sort()[0];
  return firstKey ? Object.fromEntries(parseStateKey(firstKey)) : undefined;
}

function parseStateKey(key: string): [string, string][] {
  if (!key) {
    return [];
  }
  return key
    .split(",")
    .map((part) => part.split("="))
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]));
}

function normalizeTextureMap(value: ObjectJson): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, texture]) => {
        if (typeof texture === "string") {
          return [key, texture.startsWith("#") ? texture : normalizeMinecraftId(texture)] as [string, string];
        }
        if (isObject(texture) && typeof texture.sprite === "string") {
          return [key, normalizeMinecraftId(texture.sprite)] as [string, string];
        }
        return undefined;
      })
      .filter((entry): entry is [string, string] => Boolean(entry))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function resolveTextureReference(
  reference: string,
  textures: Record<string, string>,
  unresolvedTextures: Set<string>,
  seen = new Set<string>(),
): string | undefined {
  if (!reference.startsWith("#")) {
    if (textures[reference]) {
      return resolveTextureReference(textures[reference], textures, unresolvedTextures, seen);
    }
    return normalizeMinecraftId(reference);
  }
  const key = reference.slice(1);
  if (seen.has(key)) {
    unresolvedTextures.add(reference);
    return undefined;
  }
  seen.add(key);
  const next = textures[key];
  if (!next) {
    unresolvedTextures.add(reference);
    return undefined;
  }
  return resolveTextureReference(next, textures, unresolvedTextures, seen);
}

function collectVariantAssetIds(raw: JsonValue): string[] {
  const assetIds = new Set<string>();
  const collect = (value: JsonValue | undefined): void => {
    if (typeof value === "string" && value.startsWith("minecraft:entity/")) {
      assetIds.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (isObject(value)) {
      collect(value.asset_id);
      collect(value.baby_asset_id);
      collect(value.asset);
      Object.values(value).forEach(collect);
    }
  };

  collect(raw);
  return Array.from(assetIds).sort();
}

function toTextureAsset(id: string): MobModelDefinition["textureAssets"][number] {
  const normalized = normalizeMinecraftId(id);
  const localPath = normalized.replace(/^minecraft:/, "");
  return {
    id: normalized,
    sourcePath: `assets/minecraft/textures/${localPath}.png`,
    imagePath: `images/${localPath}.png`,
  };
}

function uniqueTextureAssets(assets: MobModelDefinition["textureAssets"]): MobModelDefinition["textureAssets"] {
  return Array.from(new Map(assets.map((asset) => [asset.id, asset])).values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function collectItemModelRefs(value: JsonValue | undefined): string[] {
  const refs = new Set<string>();
  visitJson(value, (entry) => {
    if (isObject(entry) && typeof entry.model === "string") {
      refs.add(normalizeMinecraftId(entry.model));
    }
    if (typeof entry === "string" && entry.startsWith("minecraft:") && entry.includes("item/")) {
      refs.add(normalizeMinecraftId(entry));
    }
  });
  return Array.from(refs).sort();
}

function collectSpecialRendererKinds(value: JsonValue | undefined): string[] {
  const kinds = new Set<string>();
  visitJson(value, (entry) => {
    if (!isObject(entry)) {
      return;
    }
    if (entry.type === "minecraft:special" && isObject(entry.model) && typeof entry.model.type === "string") {
      kinds.add(entry.model.type.replace(/^minecraft:/, ""));
    }
  });
  return Array.from(kinds).sort();
}

function collectPredicates(modelNode: JsonValue | undefined, overrides: JsonValue[]): string[] {
  const predicates = new Set<string>();
  visitJson(modelNode, (entry) => {
    if (isObject(entry) && typeof entry.property === "string") {
      predicates.add(normalizeMinecraftId(entry.property));
    }
  });
  for (const override of overrides) {
    if (isObject(override) && isObject(override.predicate)) {
      Object.keys(override.predicate).forEach((key) => predicates.add(normalizeMinecraftId(key)));
    }
  }
  return Array.from(predicates).sort();
}

function collectDisplayTransforms(
  modelNode: JsonValue | undefined,
  resolvedModel: ResolvedRenderModel | undefined,
): Record<string, JsonValue> {
  const display = isObject(resolvedModel?.display) ? resolvedModel.display : {};
  const transforms: Record<string, JsonValue> = {};
  for (const context of DISPLAY_CONTEXTS) {
    if (display[context] !== undefined) {
      transforms[context] = display[context];
    }
  }
  if (isObject(modelNode) && modelNode.transformation !== undefined) {
    transforms.gui_item_model_transformation = modelNode.transformation;
  }
  return transforms;
}

function inferItemRenderKind(
  modelNode: JsonValue | undefined,
  resolvedModel: ResolvedRenderModel | undefined,
  specialKinds: string[],
): ClientItemRenderDefinition["renderKind"] {
  if (specialKinds.length > 0) {
    return "special_renderer";
  }
  if (
    isObject(modelNode) &&
    ["minecraft:condition", "minecraft:range_dispatch", "minecraft:select", "minecraft:composite"].includes(
      String(modelNode.type),
    )
  ) {
    return "composite";
  }
  if (resolvedModel?.id.includes(":block/")) {
    return "block_model_gui";
  }
  if (
    resolvedModel?.parentChain.some((parent) => parent.endsWith(":item/handheld")) ||
    resolvedModel?.parent?.endsWith(":item/handheld")
  ) {
    return "handheld_item";
  }
  if (
    resolvedModel?.parentChain.some((parent) => parent.endsWith(":item/generated")) ||
    resolvedModel?.parent?.endsWith(":item/generated")
  ) {
    return "generated_flat_item";
  }
  return "unknown";
}

function buildGuiDescriptor(
  id: string,
  modelNode: JsonValue | undefined,
  modelRef: string | undefined,
  specialKinds: string[],
): JsonValue {
  return {
    context: "gui",
    item: id,
    modelRef: modelRef ?? null,
    resolver: specialKinds.length > 0 ? "item_special_renderer" : "item_gui_model",
    specialRendererKinds: specialKinds,
    sourceModel: modelNode ?? null,
  };
}

function inferBlockRenderLayer(
  blockstate: BlockstateRenderDefinition,
  modelMap: Map<string, ResolvedRenderModel>,
  textureMap: Map<string, TextureRenderDefinition>,
): BlockRenderLayerKind {
  if (blockstate.id.includes("water") || blockstate.id.includes("ice") || blockstate.id.includes("glass")) {
    return blockstate.id.includes("glass_pane") || blockstate.id.includes("glass") ? "translucent" : "translucent";
  }

  const textures = new Set<string>();
  for (const modelRef of blockstate.modelRefs) {
    const model = modelMap.get(modelRef);
    for (const element of model?.elements ?? []) {
      for (const face of Object.values(element.faces)) {
        if (face?.resolvedTextureId) {
          textures.add(face.resolvedTextureId);
        }
      }
    }
  }

  for (const texture of textures) {
    if (textureMap.get(texture)?.transparency === "transparent") {
      return "cutout";
    }
  }

  return "solid";
}

function inferBlockTintType(id: string): string | undefined {
  if (id.includes("grass") || id.includes("fern") || id.includes("vine")) {
    return "grass";
  }
  if (id.includes("leaves") || id.includes("foliage")) {
    return "foliage";
  }
  if (id.includes("water")) {
    return "water";
  }
  if (id.includes("redstone_wire")) {
    return "redstone";
  }
  return undefined;
}

function collectTintTypes(value: JsonValue): string[] {
  const types = new Set<string>();
  visitJson(value, (entry) => {
    if (isObject(entry) && typeof entry.type === "string" && !String(entry.type).includes("model")) {
      const type = entry.type.replace(/^minecraft:/, "");
      if (["grass", "foliage", "dye", "potion", "map_color", "team", "custom_model_data", "constant"].includes(type)) {
        types.add(type);
      }
    }
  });
  return Array.from(types).sort();
}

async function indexRendererSources(decompiledClientRoot: string): Promise<Map<string, string>> {
  return indexJavaSources(join(decompiledClientRoot, "net/minecraft/client/renderer/entity"), decompiledClientRoot);
}

async function indexSpecialRendererSources(decompiledClientRoot: string): Promise<Map<string, string>> {
  return indexJavaSources(join(decompiledClientRoot, "net/minecraft/client/renderer/special"), decompiledClientRoot);
}

async function indexJavaSources(root: string, decompiledClientRoot: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!(await fileExists(root))) {
    return result;
  }
  for (const path of await listJavaFiles(root)) {
    const className = path.slice(path.lastIndexOf("/") + 1).replace(/\.java$/, "");
    result.set(className, relative(decompiledClientRoot, path).replace(/\\/g, "/"));
  }
  return result;
}

async function listJavaFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return listJavaFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".java") ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function inferEntityOverlays(mob: MobModelDefinition): string[] {
  const overlays = new Set<string>();
  for (const texture of mob.textureAssets) {
    const id = texture.id;
    if (id.includes("collar")) overlays.add("collar");
    if (id.includes("saddle")) overlays.add("saddle");
    if (id.includes("armor")) overlays.add("armor");
    if (id.includes("glow") || id.includes("eyes")) overlays.add("glow");
    if (id.includes("wool")) overlays.add("wool");
    if (id.includes("charged")) overlays.add("charged");
  }
  return Array.from(overlays).sort();
}

function variantIdFromTexture(textureId: string, localId: string): string {
  return textureId
    .replace(/^minecraft:entity\//, "")
    .replace(new RegExp(`^${escapeRegExp(localId)}[/_-]?`), "")
    .replace(/^.*\//, "")
    .replace(/_?baby$/, "baby")
    .replace(/^$/, "default");
}

function collectSpecialTextures(kind: string, paths: string[]): string[] {
  const needles = [kind, kind.replace(/_/g, "/"), kind.replace(/_/g, "")];
  if (kind === "chest") {
    needles.push("entity/chest");
  }
  if (kind === "skull") {
    needles.push("entity/skull");
  }
  if (kind === "shield") {
    needles.push("entity/shield", "entity/banner");
  }
  return paths
    .filter((path) => path.startsWith(TEXTURE_PREFIX) && needles.some((needle) => path.includes(needle)) && path.endsWith(".png"))
    .map((path) => idFromAssetPath(TEXTURE_PREFIX, path))
    .sort();
}

function toSpecialRendererClassName(kind: string): string {
  return `${kind
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("")}SpecialRenderer`;
}

function atlasSourceMentionsTexture(source: JsonValue, texturePathId: string): boolean {
  if (!isObject(source)) {
    return false;
  }
  const sourceValue = typeof source.source === "string" ? source.source : undefined;
  const prefixValue = typeof source.prefix === "string" ? source.prefix : "";
  if (source.type === "minecraft:directory" && sourceValue && texturePathId.startsWith(prefixValue)) {
    return true;
  }
  if (sourceValue && texturePathId.startsWith(`${prefixValue}${sourceValue}`)) {
    return true;
  }
  if (source.type === "minecraft:single" && source.resource === texturePathId) {
    return true;
  }
  return false;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function classifyPngTransparency(buffer: Buffer): TextureRenderDefinition["transparency"] {
  if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) {
    return "unknown";
  }
  const colorType = buffer[25];
  if (colorType === 4 || colorType === 6) {
    return "transparent";
  }
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") {
      return "transparent";
    }
    offset += 12 + length;
  }
  return "opaque";
}

function textureKindFromPath(path: string): TextureRenderDefinition["kind"] {
  if (path.includes("/textures/block/")) return "block";
  if (path.includes("/textures/item/")) return "item";
  if (path.includes("/textures/entity/")) return "entity";
  if (path.includes("/textures/environment/") || path.includes("/textures/colormap/")) return "environment";
  return "other";
}

function toVec3(value: JsonValue | undefined): Vec3 | undefined {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((entry) => typeof entry === "number")
    ? ([value[0], value[1], value[2]] as Vec3)
    : undefined;
}

function toVec4(value: JsonValue | undefined): [number, number, number, number] | undefined {
  return Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every((entry) => typeof entry === "number")
    ? ([value[0], value[1], value[2], value[3]] as [number, number, number, number])
    : undefined;
}

function visitJson(value: JsonValue | undefined, visitor: (value: JsonValue) => void): void {
  if (value === undefined) {
    return;
  }
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJson(entry, visitor));
  } else if (isObject(value)) {
    Object.values(value).forEach((entry) => visitJson(entry, visitor));
  }
}

function isObject(value: JsonValue | undefined): value is ObjectJson {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function humanizeId(id: string): string {
  return id
    .replace(/^minecraft:/, "")
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
