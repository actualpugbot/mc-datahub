import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import type { MobModelDefinition } from "../src/domain/types.js";
import { MobAnimationExtractor } from "../src/extraction/mobAnimationExtractor.js";

describe("mob animation extractor", () => {
  test("parses keyframe definitions and bakes procedural setupAnim", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-anim-"));

    // A minimal declarative keyframe clip (system 1).
    await writeJava(root, "net/minecraft/client/animation/definitions/TestBeastAnimation.java", [
      "package net.minecraft.client.animation.definitions;",
      "import net.minecraft.client.animation.AnimationChannel;",
      "import net.minecraft.client.animation.AnimationDefinition;",
      "import net.minecraft.client.animation.Keyframe;",
      "import net.minecraft.client.animation.KeyframeAnimations;",
      "public class TestBeastAnimation {",
      "  public static final AnimationDefinition WIGGLE = AnimationDefinition.Builder.withLength(1.5F)",
      "    .looping()",
      '    .addAnimation("body", new AnimationChannel(AnimationChannel.Targets.ROTATION,',
      "      new Keyframe(0.0F, KeyframeAnimations.degreeVec(0.0F, 0.0F, 0.0F), AnimationChannel.Interpolations.LINEAR),",
      "      new Keyframe(0.75F, KeyframeAnimations.degreeVec(0.0F, 90.0F, 0.0F), AnimationChannel.Interpolations.LINEAR),",
      "      new Keyframe(1.5F, KeyframeAnimations.degreeVec(0.0F, 0.0F, 0.0F), AnimationChannel.Interpolations.LINEAR)",
      "    ))",
      "    .build();",
      "}",
    ]);

    // Base model class in the extends chain (stops the walk at Model).
    await writeJava(root, "net/minecraft/client/model/EntityModel.java", [
      "package net.minecraft.client.model;",
      "public abstract class EntityModel<T extends EntityRenderState> extends Model<T> {",
      "  protected EntityModel(final ModelPart root) { super(root); }",
      "}",
    ]);

    // Concrete model: procedural leg swing (system 2) + a keyframe reference.
    await writeJava(root, "net/minecraft/client/model/TestBeastModel.java", [
      "package net.minecraft.client.model;",
      "import net.minecraft.client.animation.KeyframeAnimation;",
      "import net.minecraft.client.animation.definitions.TestBeastAnimation;",
      "import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;",
      "import net.minecraft.util.Mth;",
      "public class TestBeastModel extends EntityModel<LivingEntityRenderState> {",
      '  private final ModelPart body = this.root.getChild("body");',
      '  private final ModelPart leg = this.root.getChild("leg");',
      "  private final KeyframeAnimation wiggleAnimation;",
      "  public TestBeastModel(final ModelPart root) {",
      "    super(root);",
      "    this.wiggleAnimation = TestBeastAnimation.WIGGLE.bake(root);",
      "  }",
      "  public void setupAnim(final LivingEntityRenderState state) {",
      "    super.setupAnim(state);",
      "    this.wiggleAnimation.apply(state.wiggleAnimationState, state.ageInTicks);",
      "    this.leg.xRot = Mth.cos(state.walkAnimationPos * 0.6662F) * 1.4F * state.walkAnimationSpeed;",
      "  }",
      "}",
    ]);

    await writeJava(root, "net/minecraft/client/renderer/entity/state/EntityRenderState.java", [
      "package net.minecraft.client.renderer.entity.state;",
      "public class EntityRenderState {",
      "  public float ageInTicks;",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/renderer/entity/state/LivingEntityRenderState.java", [
      "package net.minecraft.client.renderer.entity.state;",
      "public class LivingEntityRenderState extends EntityRenderState {",
      "  public float walkAnimationPos;",
      "  public float walkAnimationSpeed;",
      "}",
    ]);

    const extractor = new MobAnimationExtractor(createConsoleLogger(false));
    const [mob] = await extractor.extract([testBeast()], root);

    expect(mob).toBeDefined();
    expect(mob?.modelClass).toBe("TestBeastModel");

    // Part A — the keyframe clip passed through losslessly, converted to absolute rotation.
    const wiggle = mob?.clips.find((clip) => clip.definition === "TestBeastAnimation.WIGGLE");
    expect(wiggle).toBeDefined();
    expect(wiggle?.source).toBe("keyframe");
    expect(wiggle?.name).toBe("wiggle");
    expect(wiggle?.lengthSeconds).toBe(1.5);
    expect(wiggle?.loop).toBe(true);
    const wiggleBody = wiggle?.bones.find((bone) => bone.bone === "body");
    // degreeVec(0,90,0) -> yRot = 90 deg in radians, added to base yRot (0).
    expect(wiggleBody?.rotation?.[1]?.value[1]).toBeCloseTo(Math.PI / 2, 5);
    expect(wiggleBody?.rotation?.[0]?.value[1]).toBeCloseTo(0, 5);

    // Part B — the procedural leg swing baked into a walk clip.
    const walk = mob?.clips.find((clip) => clip.name === "walk" && clip.source === "baked");
    expect(walk).toBeDefined();
    expect(walk?.loop).toBe(true);
    const walkLeg = walk?.bones.find((bone) => bone.bone === "leg");
    expect(walkLeg?.rotation).toBeDefined();
    // xRot = cos(pos * 0.6662) * 1.4 * speed(1); at pos=0 -> 1.4, amplitude ~= 1.4.
    expect(walkLeg?.rotation?.[0]?.value[0]).toBeCloseTo(1.4, 4);
    const amplitude = Math.max(...(walkLeg?.rotation ?? []).map((keyframe) => Math.abs(keyframe.value[0])));
    expect(amplitude).toBeCloseTo(1.4, 2);

    // The body has no procedural channel (keyframe applies are no-ops in the bake).
    expect(walk?.bones.some((bone) => bone.bone === "body")).toBe(false);
  });

  test("chains super.<helper>() calls and does not collapse non-closing idle bobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-anim-super-"));
    await writeJava(root, "net/minecraft/client/model/EntityModel.java", [
      "package net.minecraft.client.model;",
      "public abstract class EntityModel<T extends EntityRenderState> extends Model<T> {",
      "  protected EntityModel(final ModelPart root) { super(root); }",
      "}",
    ]);
    // Base defines applyWalk; the derived overrides it and calls super.applyWalk.
    await writeJava(root, "net/minecraft/client/model/CritterBaseModel.java", [
      "package net.minecraft.client.model;",
      "import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;",
      "import net.minecraft.util.Mth;",
      "public class CritterBaseModel extends EntityModel<LivingEntityRenderState> {",
      '  protected final ModelPart leg = this.root.getChild("leg");',
      '  protected final ModelPart tail = this.root.getChild("tail");',
      '  protected final ModelPart head = this.root.getChild("head");',
      "  public CritterBaseModel(final ModelPart root) { super(root); }",
      "  protected void applyWalk(final LivingEntityRenderState state) {",
      "    this.leg.xRot = Mth.cos(state.walkAnimationPos * 0.6662F) * 1.4F * state.walkAnimationSpeed;",
      "  }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/model/CritterModel.java", [
      "package net.minecraft.client.model;",
      "import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;",
      "import net.minecraft.util.Mth;",
      "public class CritterModel extends CritterBaseModel {",
      "  public CritterModel(final ModelPart root) { super(root); }",
      "  protected void applyWalk(final LivingEntityRenderState state) {",
      "    super.applyWalk(state);",
      "    this.tail.xRot = Mth.cos(state.walkAnimationPos * 0.6662F) * 0.5F * state.walkAnimationSpeed;",
      "  }",
      "  public void setupAnim(final LivingEntityRenderState state) {",
      "    super.setupAnim(state);",
      "    this.applyWalk(state);",
      "    this.head.xRot = Mth.cos(state.ageInTicks * 0.09F) * 0.2F;",
      "    this.head.zRot = Mth.sin(state.ageInTicks * 0.067F) * 0.2F;",
      "  }",
      "}",
    ]);
    await writeJava(root, "net/minecraft/client/renderer/entity/state/EntityRenderState.java", [
      "package net.minecraft.client.renderer.entity.state;",
      "public class EntityRenderState { public float ageInTicks; }",
    ]);
    await writeJava(root, "net/minecraft/client/renderer/entity/state/LivingEntityRenderState.java", [
      "package net.minecraft.client.renderer.entity.state;",
      "public class LivingEntityRenderState extends EntityRenderState {",
      "  public float walkAnimationPos;",
      "  public float walkAnimationSpeed;",
      "}",
    ]);

    const extractor = new MobAnimationExtractor(createConsoleLogger(false));
    const [mob] = await extractor.extract([critter()], root);

    // super.applyWalk executed: both the base bone (leg) and the override bone (tail) animate.
    const walk = mob?.clips.find((clip) => clip.name === "walk");
    expect(walk).toBeDefined();
    expect(walk?.bones.some((bone) => bone.bone === "leg" && bone.rotation)).toBe(true);
    expect(walk?.bones.some((bone) => bone.bone === "tail" && bone.rotation)).toBe(true);

    // The incommensurate head bob (cos(t*0.09), sin(t*0.067)) never closes cleanly; the clip must
    // span a genuine period, not collapse to a spurious near-zero one.
    const idle = mob?.clips.find((clip) => clip.name === "idle");
    expect(idle).toBeDefined();
    expect(idle?.bones.some((bone) => bone.bone === "head" && bone.rotation)).toBe(true);
    expect(idle?.lengthSeconds).toBeGreaterThan(1);
    expect(idle?.approximateLoop).toBe(true);
  });

  test("marks a mob unresolved (with a warning) when the model source is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-anim-empty-"));
    const extractor = new MobAnimationExtractor(createConsoleLogger(false));
    const [mob] = await extractor.extract([testBeast()], root);
    expect(mob?.status).toBe("unresolved");
    expect(mob?.clips).toHaveLength(0);
    expect(mob?.warnings.length).toBeGreaterThan(0);
  });
});

async function writeJava(root: string, path: string, lines: string[]): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), { recursive: true });
  await writeFile(fullPath, `${lines.join("\n")}\n`, "utf8");
}

function testBeast(): MobModelDefinition {
  return {
    id: "minecraft:test_beast",
    localId: "test_beast",
    displayName: "Test Beast",
    modelLayers: ["test_beast"],
    texturePaths: [],
    textureAssets: [],
    layers: [
      {
        id: "test_beast",
        modelClass: "TestBeastModel",
        modelMethod: "createBodyLayer",
        status: "baked",
        warnings: [],
        root: {
          name: "root",
          path: "root",
          pivot: [0, 0, 0],
          rotation: [0, 0, 0],
          cubes: [],
          children: [
            { name: "body", path: "root/body", pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [], children: [] },
            { name: "leg", path: "root/leg", pivot: [-2, 12, 0], rotation: [0, 0, 0], cubes: [], children: [] },
          ],
        },
      },
    ],
  };
}

function critter(): MobModelDefinition {
  const part = (name: string, pivot: [number, number, number]) => ({
    name,
    path: `root/${name}`,
    pivot,
    rotation: [0, 0, 0] as [number, number, number],
    cubes: [],
    children: [],
  });
  return {
    id: "minecraft:critter",
    localId: "critter",
    displayName: "Critter",
    modelLayers: ["critter"],
    texturePaths: [],
    textureAssets: [],
    layers: [
      {
        id: "critter",
        modelClass: "CritterModel",
        modelMethod: "createBodyLayer",
        status: "baked",
        warnings: [],
        root: {
          name: "root",
          path: "root",
          pivot: [0, 0, 0],
          rotation: [0, 0, 0],
          cubes: [],
          children: [part("leg", [-2, 12, 0]), part("tail", [0, 8, 4]), part("head", [0, 4, -6])],
        },
      },
    ],
  };
}
