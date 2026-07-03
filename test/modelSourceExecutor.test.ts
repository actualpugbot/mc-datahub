import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import type { MobModelDefinition, MobSoundDefinition } from "../src/domain/types.js";
import { MobModelExtractor } from "../src/extraction/mobModelExtractor.js";
import { transpileJavaSnippet } from "../src/extraction/modelSourceExecutor.js";

describe("model source executor", () => {
  test("transpiles loops, casts, suffixes, array literals and integer division", () => {
    const js = transpileJavaSnippet(
      [
        "int[][] SIZES = new int[][]{{4, 3, 2}, {6, 4, 5}};",
        "float placement = -3.5F;",
        "for (int i = 0; i < 2; i++) {",
        "  float xo = (i % 3 - i / 3 % 2 * 0.5F + 0.25F) / 2.0F;",
        "  placement += (float) (SIZES[i][2] * 0.5F);",
        "}",
      ].join("\n"),
    );
    expect(js).toContain("let SIZES = [[4, 3, 2], [6, 4, 5]]");
    expect(js).toContain("for (let i = 0; i < 2; i++)");
    expect(js).toContain("Math.trunc(i / 3)");
    expect(js).not.toContain("0.5F");
    expect(js).not.toContain("(float)");
  });

  test("bakes loop-generated segments with array constants and accumulators", async () => {
    const root = await modelWorkspace("segments", {
      layers: ["result.put(ModelLayers.COW, SegmentModel.createBodyLayer());"],
      models: {
        "SegmentModel.java": [
          "package net.minecraft.client.model;",
          "public class SegmentModel {",
          "  private static final int[][] BODY_SIZES = new int[][]{{4, 3, 2}, {6, 4, 5}, {3, 3, 1}};",
          "  private static String segmentName(final int i) {",
          '    return "segment" + i;',
          "  }",
          "  public static LayerDefinition createBodyLayer() {",
          "    MeshDefinition mesh = new MeshDefinition();",
          "    PartDefinition root = mesh.getRoot();",
          "    float placement = -3.5F;",
          "    for (int i = 0; i < 3; i++) {",
          "      root.addOrReplaceChild(",
          "        segmentName(i),",
          "        CubeListBuilder.create().texOffs(0, i).addBox(BODY_SIZES[i][0] * -0.5F, 0.0F, BODY_SIZES[i][2] * -0.5F, BODY_SIZES[i][0], BODY_SIZES[i][1], BODY_SIZES[i][2]),",
          "        PartPose.offset(0.0F, 24 - BODY_SIZES[i][1], placement)",
          "      );",
          "      if (i < 2) {",
          "        placement += (BODY_SIZES[i][2] + BODY_SIZES[i + 1][2]) * 0.5F;",
          "      }",
          "    }",
          "    return LayerDefinition.create(mesh, 64, 32);",
          "  }",
          "}",
        ],
      },
    });

    const layer = await primaryLayer(root);
    expect(layer?.status).toBe("baked");
    expect(layer?.bakeStrategy).toBe("executed");
    expect(layer?.textureSize).toEqual([64, 32]);
    const names = layer?.root?.children.map((part) => part.name);
    expect(names).toEqual(["segment0", "segment1", "segment2"]);
    const second = layer?.root?.children[1];
    expect(second?.pivot).toEqual([0, 20, -3.5 + (2 + 5) * 0.5]);
    expect(second?.cubes[0]?.origin).toEqual([-3, 0, -2.5]);
    expect(second?.cubes[0]?.texOffs).toEqual([0, 1]);
  });

  test("delegates through same-named cross-class methods and honors clearChild", async () => {
    const root = await modelWorkspace("piglinesque", {
      layers: ["result.put(ModelLayers.COW, OuterModel.createBodyLayer());"],
      models: {
        "OuterModel.java": [
          "package net.minecraft.client.model;",
          "public class OuterModel {",
          "  public static LayerDefinition createBodyLayer() {",
          "    return InnerModel.createBodyLayer();",
          "  }",
          "}",
        ],
        "InnerModel.java": [
          "package net.minecraft.client.model;",
          "public class InnerModel {",
          "  public static LayerDefinition createBodyLayer() {",
          "    MeshDefinition mesh = new MeshDefinition();",
          "    PartDefinition root = mesh.getRoot();",
          "    PartDefinition head = root.addOrReplaceChild(",
          '      "head",',
          "      CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, -8.0F, -4.0F, 8.0F, 8.0F, 8.0F),",
          "      PartPose.ZERO",
          "    );",
          '    head.addOrReplaceChild("hat", CubeListBuilder.create().texOffs(32, 0).addBox(-4.0F, -8.0F, -4.0F, 8.0F, 8.0F, 8.0F, new CubeDeformation(0.5F)), PartPose.ZERO);',
          '    head.clearChild("hat");',
          "    return LayerDefinition.create(mesh, 64, 64);",
          "  }",
          "}",
        ],
      },
    });

    const layer = await primaryLayer(root);
    expect(layer?.status).toBe("baked");
    expect(layer?.bakeStrategy).toBe("executed");
    const head = layer?.root?.children.find((part) => part.name === "head");
    expect(head?.cubes).toHaveLength(1);
    const hat = head?.children.find((part) => part.name === "hat");
    expect(hat?.cubes).toEqual([]);
  });

  test("replays fixed-seed RandomSource exactly like java.util.Random", async () => {
    const root = await modelWorkspace("randomized", {
      layers: ["result.put(ModelLayers.COW, TentacleModel.createBodyLayer());"],
      models: {
        "TentacleModel.java": [
          "package net.minecraft.client.model;",
          "public class TentacleModel {",
          "  public static LayerDefinition createBodyLayer() {",
          "    MeshDefinition mesh = new MeshDefinition();",
          "    PartDefinition root = mesh.getRoot();",
          "    RandomSource random = RandomSource.createThreadLocalInstance(1660L);",
          "    for (int i = 0; i < 3; i++) {",
          "      int len = random.nextInt(7) + 8;",
          '      root.addOrReplaceChild("tentacle" + i, CubeListBuilder.create().texOffs(0, 0).addBox(-1.0F, 0.0F, -1.0F, 2.0F, len, 2.0F), PartPose.ZERO);',
          "    }",
          "    return LayerDefinition.create(mesh, 64, 32);",
          "  }",
          "}",
        ],
      },
    });

    const layer = await primaryLayer(root);
    expect(layer?.bakeStrategy).toBe("executed");
    // java.util.Random (documented LCG spec) with seed 1660: nextInt(7)
    // yields 0, 5, 1 -> tentacle heights 8, 13, 9.
    const lengths = layer?.root?.children.map((part) => part.cubes[0]?.size[1]);
    expect(lengths).toEqual([8, 13, 9]);
  });

  test("resolves createRoots locals like the villager scale transformer", async () => {
    const root = await modelWorkspace("scaled", {
      layers: [
        "MeshTransformer villagerLikeScale = MeshTransformer.scaling(0.9375F);",
        "result.put(ModelLayers.COW, BoxModel.createBodyLayer().apply(villagerLikeScale));",
      ],
      models: {
        "BoxModel.java": [
          "package net.minecraft.client.model;",
          "public class BoxModel {",
          "  public static LayerDefinition createBodyLayer() {",
          "    MeshDefinition mesh = new MeshDefinition();",
          '    mesh.getRoot().addOrReplaceChild("body", CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, 0.0F, -4.0F, 8.0F, 8.0F, 8.0F), PartPose.offset(0.0F, 16.0F, 0.0F));',
          "    return LayerDefinition.create(mesh, 64, 64);",
          "  }",
          "}",
        ],
      },
    });

    const layer = await primaryLayer(root);
    expect(layer?.bakeStrategy).toBe("executed");
    // MeshTransformer.scaling(f) scales the root pose and lifts it by 24.016 * (1 - f).
    expect(layer?.root?.scale?.[0]).toBeCloseTo(0.9375);
    expect(layer?.root?.pivot[1]).toBeCloseTo(24.016 * (1 - 0.9375));
    const body = layer?.root?.children[0];
    expect(body?.pivot).toEqual([0, 16, 0]);
  });

  test("honors addBox visibleSides sets by omitting hidden faces", async () => {
    const root = await modelWorkspace("faces", {
      layers: ["result.put(ModelLayers.COW, WindModel.createBodyLayer());"],
      models: {
        "WindModel.java": [
          "package net.minecraft.client.model;",
          "public class WindModel {",
          "  public static LayerDefinition createBodyLayer() {",
          "    MeshDefinition mesh = new MeshDefinition();",
          '    mesh.getRoot().addOrReplaceChild("wind", CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, 0.0F, -4.0F, 8.0F, 8.0F, 8.0F, Set.of(Direction.NORTH, Direction.UP)), PartPose.ZERO);',
          "    return LayerDefinition.create(mesh, 64, 64);",
          "  }",
          "}",
        ],
      },
    });

    const layer = await primaryLayer(root);
    expect(layer?.bakeStrategy).toBe("executed");
    const faces = layer?.root?.children[0]?.cubes[0]?.faces ?? {};
    expect(Object.keys(faces).sort()).toEqual(["north", "up"]);
  });
});

interface WorkspaceSpec {
  layers: string[];
  models: Record<string, string[]>;
}

async function modelWorkspace(tag: string, spec: WorkspaceSpec): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `mc-datahub-executor-${tag}-`));
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
    "    context.bakeLayer(ModelLayers.COW);",
    "  }",
    '  static final Identifier TEXTURE = Identifier.withDefaultNamespace("textures/entity/cow/cow.png");',
    "}",
  ]);
  await writeJava(root, "net/minecraft/client/model/geom/LayerDefinitions.java", [
    "package net.minecraft.client.model.geom;",
    "public class LayerDefinitions {",
    "  public static Map<ModelLayerLocation, LayerDefinition> createRoots() {",
    "    Builder<ModelLayerLocation, LayerDefinition> result = ImmutableMap.builder();",
    ...spec.layers.map((line) => `    ${line}`),
    "    return result.build();",
    "  }",
    "}",
  ]);
  for (const [file, lines] of Object.entries(spec.models)) {
    await writeJava(root, `net/minecraft/client/model/${file}`, lines);
  }
  return root;
}

async function primaryLayer(root: string) {
  const models: MobModelDefinition[] = await new MobModelExtractor(createConsoleLogger(false)).extract([cowMob()], root);
  return models[0]?.layers[0];
}

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
