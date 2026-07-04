import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import type { MobSoundDefinition } from "../src/domain/types.js";
import { bakeCubeFaces, MobModelExtractor } from "../src/extraction/mobModelExtractor.js";

describe("mob model extractor", () => {
  test("bakes Mojang cube UV rectangles in ModelPart face order", () => {
    const faces = bakeCubeFaces(0, 0, 8, 8, 6, 64, 64);

    expect(faces.down!.uv).toEqual([6, 0, 14, 6]);
    expect(faces.up!.uv).toEqual([14, 6, 22, 0]);
    expect(faces.west!.uv).toEqual([0, 6, 6, 14]);
    expect(faces.north!.uv).toEqual([6, 6, 14, 14]);
    expect(faces.east!.uv).toEqual([14, 6, 20, 14]);
    expect(faces.south!.uv).toEqual([20, 6, 28, 14]);
    expect(faces.north!.normalizedUv).toEqual([6 / 64, 6 / 64, 14 / 64, 14 / 64]);
  });

  test("links renderer model layers and extracts part pivots, rotations, cubes, and UVs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-model-"));
    await writeJava(root, "net/minecraft/client/renderer/entity/EntityRenderers.java", [
      "package net.minecraft.client.renderer.entity;",
      "public class EntityRenderers {",
      "  static { register(EntityTypes.COW, CowRenderer::new); }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/renderer/entity/CowRenderer.java", [
      "package net.minecraft.client.renderer.entity;",
      "public class CowRenderer {",
      "  public CowRenderer(EntityRendererProvider.Context context) {",
      "    new CowModel(context.bakeLayer(ModelLayers.COW));",
      "  }",
      '  static final Identifier TEXTURE = Identifier.withDefaultNamespace("textures/entity/cow/cow.png");',
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/model/geom/LayerDefinitions.java", [
      "package net.minecraft.client.model.geom;",
      "public class LayerDefinitions {",
      "  public static Map<ModelLayerLocation, LayerDefinition> createRoots() {",
      "    Builder<ModelLayerLocation, LayerDefinition> result = ImmutableMap.builder();",
      "    LayerDefinition cowBodyLayer = CowModel.createBodyLayer();",
      "    result.put(ModelLayers.COW, cowBodyLayer);",
      "    return result.build();",
      "  }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/model/animal/cow/CowModel.java", [
      "package net.minecraft.client.model.animal.cow;",
      "public class CowModel {",
      "  public static LayerDefinition createBodyLayer() {",
      "    MeshDefinition mesh = createBaseCowModel();",
      "    return LayerDefinition.create(mesh, 64, 64);",
      "  }",
      "  public static MeshDefinition createBaseCowModel() {",
      "    MeshDefinition mesh = new MeshDefinition();",
      "    PartDefinition root = mesh.getRoot();",
      "    root.addOrReplaceChild(",
      '      "head",',
      "      CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, -4.0F, -6.0F, 8.0F, 8.0F, 6.0F),",
      "      PartPose.offset(0.0F, 4.0F, -8.0F)",
      "    );",
      "    root.addOrReplaceChild(",
      '      "body",',
      "      CubeListBuilder.create().texOffs(18, 4).addBox(-6.0F, -10.0F, -7.0F, 12.0F, 18.0F, 10.0F),",
      "      PartPose.offsetAndRotation(0.0F, 5.0F, 2.0F, (float) (Math.PI / 2), 0.0F, 0.0F)",
      "    );",
      "    CubeListBuilder leftLeg = CubeListBuilder.create().mirror().texOffs(0, 16).addBox(-2.0F, 0.0F, -2.0F, 4.0F, 12.0F, 4.0F);",
      '    root.addOrReplaceChild("left_hind_leg", leftLeg, PartPose.offset(4.0F, 12.0F, 7.0F));',
      "    return mesh;",
      "  }",
      "}",
    ]);

    const [model] = await new MobModelExtractor(createConsoleLogger(false)).extract([cowMob()], root);

    expect(model).toMatchObject({
      id: "minecraft:cow",
      localId: "cow",
      rendererClass: "CowRenderer",
      modelLayers: ["cow"],
      texturePaths: ["assets/minecraft/textures/entity/cow/cow.png"],
      textureAssets: [
        {
          id: "minecraft:entity/cow/cow",
          sourcePath: "assets/minecraft/textures/entity/cow/cow.png",
          imagePath: "images/entity/cow/cow.png",
        },
      ],
    });
    const layer = model?.layers[0];
    expect(layer).toMatchObject({
      id: "cow",
      status: "baked",
      modelClass: "CowModel",
      modelMethod: "createBodyLayer",
      textureSize: [64, 64],
    });
    const head = layer?.root?.children.find((part) => part.name === "head");
    expect(head?.pivot).toEqual([0, 4, -8]);
    expect(head?.cubes[0]?.origin).toEqual([-4, -4, -6]);
    expect(head?.cubes[0]?.faces.north!.uv).toEqual([6, 6, 14, 14]);

    const body = layer?.root?.children.find((part) => part.name === "body");
    expect(body?.rotation[0]).toBeCloseTo(Math.PI / 2);

    const leftLeg = layer?.root?.children.find((part) => part.name === "left_hind_leg");
    expect(leftLeg?.cubes[0]?.mirror).toBe(true);
  });

  test("follows inherited mesh factories and chained root part additions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-model-inherited-"));
    await writeJava(root, "net/minecraft/client/renderer/entity/EntityRenderers.java", [
      "package net.minecraft.client.renderer.entity;",
      "public class EntityRenderers {",
      "  static { register(EntityTypes.COW, CowRenderer::new); }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/renderer/entity/CowRenderer.java", [
      "package net.minecraft.client.renderer.entity;",
      "public class CowRenderer {",
      "  public CowRenderer(EntityRendererProvider.Context context) {",
      "    new CowModel(context.bakeLayer(ModelLayers.COW));",
      "  }",
      '  static final Identifier TEXTURE = Identifier.withDefaultNamespace("textures/entity/cow/cow.png");',
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/model/geom/LayerDefinitions.java", [
      "package net.minecraft.client.model.geom;",
      "public class LayerDefinitions {",
      "  public static Map<ModelLayerLocation, LayerDefinition> createRoots() {",
      "    Builder<ModelLayerLocation, LayerDefinition> result = ImmutableMap.builder();",
      "    result.put(ModelLayers.COW, ColdCowModel.createBodyLayer());",
      "    return result.build();",
      "  }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/model/animal/cow/CowModel.java", [
      "package net.minecraft.client.model.animal.cow;",
      "public class CowModel {",
      "  public static MeshDefinition createBaseCowModel() {",
      "    MeshDefinition mesh = new MeshDefinition();",
      "    PartDefinition root = mesh.getRoot();",
      '    root.addOrReplaceChild("head", CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, -4.0F, -6.0F, 8.0F, 8.0F, 6.0F), PartPose.offset(0.0F, 4.0F, -8.0F));',
      "    return mesh;",
      "  }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/model/animal/cow/ColdCowModel.java", [
      "package net.minecraft.client.model.animal.cow;",
      "public class ColdCowModel extends CowModel {",
      "  public static LayerDefinition createBodyLayer() {",
      "    MeshDefinition mesh = createBaseCowModel();",
      '    mesh.getRoot().addOrReplaceChild("body", CubeListBuilder.create().texOffs(18, 4).addBox(-6.0F, -10.0F, -7.0F, 12.0F, 18.0F, 10.0F), PartPose.offset(0.0F, 5.0F, 2.0F));',
      "    return LayerDefinition.create(mesh, 64, 64);",
      "  }",
      "}",
    ]);

    const [model] = await new MobModelExtractor(createConsoleLogger(false)).extract([cowMob()], root);
    const layer = model?.layers[0];

    expect(layer?.status).toBe("baked");
    expect(layer?.warnings).toEqual([]);
    expect(layer?.root?.children.map((part) => part.name)).toEqual(["body", "head"]);
  });
});

async function writeJava(root: string, path: string, lines: string[]): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), { recursive: true });
  await writeFile(fullPath, `${lines.join("\n")}\n`, "utf8");
}

function cowMob(): MobSoundDefinition {
  return {
    id: "minecraft:cow",
    localId: "cow",
    soundId: "entity.cow",
    displayName: "Cow",
    translationKey: "entity.minecraft.cow",
    category: "Creature",
    mobCategory: "CREATURE",
    soundEventCount: 0,
    soundVariantCount: 0,
    soundEvents: [],
  };
}
