import type {
  MinecraftRenderDataset,
  RenderValidationIssue,
  RenderValidationReport,
  ResolvedRenderModel,
} from "../domain/types.js";

const SAMPLE_FIXTURES = [
  "minecraft:grass_block",
  "minecraft:oak_log",
  "minecraft:oak_stairs",
  "minecraft:glass_pane",
  "minecraft:redstone_wire",
  "minecraft:torch",
  "minecraft:chest",
  "minecraft:shield",
  "minecraft:cow",
  "minecraft:pig",
  "minecraft:bee",
  "minecraft:villager",
  "minecraft:zombie",
  "minecraft:sheep",
];

const KNOWN_SPECIAL_RENDERER_IDS = [
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:ender_chest",
  "minecraft:white_bed",
  "minecraft:white_banner",
  "minecraft:shield",
  "minecraft:skeleton_skull",
  "minecraft:oak_sign",
  "minecraft:oak_hanging_sign",
  "minecraft:decorated_pot",
  "minecraft:conduit",
  "minecraft:shulker_box",
  "minecraft:filled_map",
  "minecraft:compass",
  "minecraft:clock",
  "minecraft:trident",
  "minecraft:spyglass",
  "minecraft:bow",
  "minecraft:crossbow",
];

export function validateRenderDataset(dataset: MinecraftRenderDataset): RenderValidationReport {
  const issues: RenderValidationIssue[] = [];
  const modelById = new Map([...dataset.blockModels, ...dataset.itemModels].map((model) => [model.id, model]));
  const textureIds = new Set(dataset.textures.map((texture) => texture.id));
  const directlyRenderedModelIds = new Set<string>();

  validateCollection("blockstates", dataset.blockstates, issues);
  validateCollection("blockModels", dataset.blockModels, issues);
  validateCollection("itemModels", dataset.itemModels, issues);
  validateCollection("itemDisplays", dataset.itemDisplays, issues);
  validateCollection("textures", dataset.textures, issues);
  validateCollection("entities", dataset.entities, issues);

  for (const blockstate of dataset.blockstates) {
    for (const modelRef of blockstate.modelRefs) {
      directlyRenderedModelIds.add(modelRef);
      if (!modelById.has(modelRef)) {
        issues.push({
          code: "missing_blockstate_model",
          severity: "error",
          id: blockstate.id,
          sourcePath: blockstate.sourcePath,
          message: `${blockstate.id} references missing model ${modelRef}.`,
        });
      }
    }
  }
  for (const item of dataset.itemDisplays) {
    if (item.modelRef) {
      directlyRenderedModelIds.add(item.modelRef);
    }
  }

  for (const model of [...dataset.blockModels, ...dataset.itemModels]) {
    if (model.parent && !modelById.has(model.parent)) {
      if (model.parent.startsWith("minecraft:builtin/")) {
        continue;
      }
      issues.push({
        code: "missing_model_parent",
        severity: "error",
        id: model.id,
        sourcePath: model.sourcePath,
        message: `${model.id} references missing parent ${model.parent}.`,
      });
    }

    if (directlyRenderedModelIds.has(model.id)) {
      validateModelFaces(model, textureIds, issues);
    }
  }

  for (const item of dataset.itemDisplays) {
    if (item.modelRef && !modelById.has(item.modelRef)) {
      issues.push({
        code: "missing_item_model",
        severity: "error",
        id: item.id,
        sourcePath: item.sourcePath,
        message: `${item.id} references missing GUI model ${item.modelRef}.`,
      });
    }
    for (const texture of item.textureLayers) {
      if (!textureIds.has(texture)) {
        issues.push({
          code: "missing_item_texture",
          severity: "error",
          id: item.id,
          sourcePath: item.sourcePath,
          message: `${item.id} references missing item texture ${texture}.`,
        });
      }
    }
  }

  for (const entityModel of dataset.entityModels) {
    const hasGeometry = entityModel.layers.some(
      (layer) => layer.root && (layer.root.children.length > 0 || layer.root.cubes.length > 0),
    );
    if (hasGeometry && entityModel.textureAssets.length === 0) {
      issues.push({
        code: "mob_geometry_without_texture",
        severity: "error",
        id: entityModel.id,
        message: `${entityModel.id} has baked geometry but no texture candidates.`,
      });
    }
    for (const texture of entityModel.textureAssets) {
      const textureId = texture.id;
      if (!textureIds.has(textureId)) {
        issues.push({
          code: "missing_mob_texture",
          severity: "error",
          id: entityModel.id,
          sourcePath: texture.sourcePath,
          message: `${entityModel.id} references missing mob texture ${textureId}.`,
        });
      }
    }
  }

  for (const knownId of KNOWN_SPECIAL_RENDERER_IDS) {
    const classified = dataset.specialRenderers.some(
      (renderer) => renderer.id === knownId || renderer.id.includes(knownId.replace(/^minecraft:/, "")),
    );
    if (!classified) {
      issues.push({
        code: "known_special_renderer_unclassified",
        severity: "error",
        id: knownId,
        message: `${knownId} is a known special-renderer case but has no classification.`,
      });
    }
  }

  for (const fixtureId of SAMPLE_FIXTURES) {
    const present =
      dataset.blockstates.some((entry) => entry.id === fixtureId) ||
      dataset.itemDisplays.some((entry) => entry.id === fixtureId) ||
      dataset.entities.some((entry) => entry.id === fixtureId);
    if (!present) {
      issues.push({
        code: "missing_validation_fixture",
        severity: "error",
        id: fixtureId,
        message: `Sample validation fixture ${fixtureId} was not exported.`,
      });
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  return {
    generatedAt: new Date().toISOString(),
    status: errorCount === 0 ? "passed" : "failed",
    fixtureIds: SAMPLE_FIXTURES,
    counts: {
      blockstates: dataset.blockstates.length,
      blockModels: dataset.blockModels.length,
      itemModels: dataset.itemModels.length,
      itemDisplays: dataset.itemDisplays.length,
      textures: dataset.textures.length,
      atlases: dataset.atlases.length,
      renderLayers: dataset.renderLayers.length,
      tints: dataset.tints.length,
      entities: dataset.entities.length,
      entityModels: dataset.entityModels.length,
      entityRenderers: dataset.entityRenderers.length,
      specialRenderers: dataset.specialRenderers.length,
      issues: issues.length,
      errors: errorCount,
    },
    issues: issues.sort((left, right) =>
      `${left.code}:${left.id ?? ""}:${left.message}`.localeCompare(`${right.code}:${right.id ?? ""}:${right.message}`),
    ),
  };
}

function validateModelFaces(model: ResolvedRenderModel, textureIds: Set<string>, issues: RenderValidationIssue[]): void {
  for (const unresolvedTexture of model.unresolvedTextures) {
    issues.push({
      code: "unresolved_face_texture",
      severity: "error",
      id: model.id,
      sourcePath: model.sourcePath,
      message: `${model.id} contains unresolved texture reference ${unresolvedTexture}.`,
    });
  }

  for (const element of model.elements) {
    for (const face of Object.values(element.faces)) {
      if (!face?.resolvedTextureId) {
        continue;
      }
      if (!textureIds.has(face.resolvedTextureId)) {
        issues.push({
          code: "missing_face_texture",
          severity: "error",
          id: model.id,
          sourcePath: model.sourcePath,
          message: `${model.id} face references missing texture ${face.resolvedTextureId}.`,
        });
      }
    }
  }
}

function validateCollection(name: string, values: { id: string }[], issues: RenderValidationIssue[]): void {
  const seen = new Set<string>();
  let previous = "";
  for (const value of values) {
    if (seen.has(value.id)) {
      issues.push({
        code: "duplicate_id",
        severity: "error",
        id: value.id,
        message: `${name} contains duplicate id ${value.id}.`,
      });
    }
    seen.add(value.id);
    if (previous && previous.localeCompare(value.id) > 0) {
      issues.push({
        code: "unstable_ordering",
        severity: "error",
        id: value.id,
        message: `${name} is not sorted by id near ${value.id}.`,
      });
    }
    previous = value.id;
  }
}
