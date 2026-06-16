import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { createConsoleLogger } from "../src/core/logger.js";
import type { MobSoundDefinition } from "../src/domain/types.js";
import { MobImageExtractor } from "../src/extraction/mobImageExtractor.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, (directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("mob image extractor", () => {
  test("resolves renderer-linked, fallback, and generated mob images", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-image-"));
    tempDirs.add(root);

    const decompiledClientRoot = join(root, "decompiled-client");
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/EntityRenderers.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.world.entity.EntityType;

public class EntityRenderers {
   static {
      register(EntityType.ALLAY, AllayRenderer::new);
      register(EntityType.COW, CowRenderer::new);
      register(EntityType.GIANT, context -> new GiantMobRenderer(context, 6.0F));
      register(EntityType.PUFFERFISH, PufferfishRenderer::new);
      register(EntityType.SHULKER, ShulkerRenderer::new);
   }
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/AllayRenderer.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.resources.Identifier;

public class AllayRenderer extends MobRenderer {
   private static final Identifier ALLAY_LOCATION = Identifier.withDefaultNamespace("textures/entity/allay/allay.png");
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/PufferfishRenderer.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.resources.Identifier;

public class PufferfishRenderer extends MobRenderer {
   private static final Identifier PUFFER_LOCATION = Identifier.withDefaultNamespace("textures/entity/fish/pufferfish.png");
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/CowRenderer.java",
      `package net.minecraft.client.renderer.entity;

public class CowRenderer extends MobRenderer {
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/GiantMobRenderer.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.resources.Identifier;

public class GiantMobRenderer extends MobRenderer {
   private static final Identifier ZOMBIE_LOCATION = Identifier.withDefaultNamespace("textures/entity/zombie/zombie.png");
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/ShulkerRenderer.java",
      `package net.minecraft.client.renderer.entity;

public class ShulkerRenderer extends MobRenderer {
}`,
    );

    const extractor = new MobImageExtractor(createConsoleLogger(false));
    const result = await extractor.extract(
      [
        createMob("allay", "Allay"),
        createMob("cow", "Cow"),
        createMob("giant", "Giant"),
        createMob("phantom", "Phantom"),
        createMob("pufferfish", "Pufferfish"),
        createMob("shulker", "Shulker"),
      ],
      [
        new InMemoryArchiveSource({
          "assets/minecraft/textures/entity/allay/allay.png": Buffer.from([0x01]),
          "assets/minecraft/textures/entity/cow/cow_cold.png": Buffer.from([0x02]),
          "assets/minecraft/textures/entity/cow/cow_temperate.png": Buffer.from([0x03]),
          "assets/minecraft/textures/entity/cow/cow_temperate_baby.png": Buffer.from([0x04]),
          "assets/minecraft/textures/entity/fish/pufferfish.png": Buffer.from([0x05]),
          "assets/minecraft/textures/entity/shulker/shulker.png": Buffer.from([0x06]),
          "assets/minecraft/textures/entity/shulker/shulker_blue.png": Buffer.from([0x07]),
          "assets/minecraft/textures/entity/zombie/zombie.png": Buffer.from([0x08]),
        }),
      ],
      decompiledClientRoot,
    );

    const imagesByLocalId = new Map(result.map((entry) => [entry.localId, entry]));

    expect(imagesByLocalId.get("allay")).toMatchObject({
      imagePath: "mob-images/allay/allay.png",
      sourcePath: "assets/minecraft/textures/entity/allay/allay.png",
      origin: "renderer",
    });
    expect(imagesByLocalId.get("pufferfish")).toMatchObject({
      imagePath: "mob-images/fish/pufferfish.png",
      sourcePath: "assets/minecraft/textures/entity/fish/pufferfish.png",
      origin: "renderer",
    });
    expect(imagesByLocalId.get("cow")).toMatchObject({
      imagePath: "mob-images/cow/cow_temperate.png",
      sourcePath: "assets/minecraft/textures/entity/cow/cow_temperate.png",
      origin: "asset-search",
    });
    expect(imagesByLocalId.get("cow")?.variants.map((variant) => variant.imagePath)).toContain("mob-images/cow/cow_temperate_baby.png");
    expect(imagesByLocalId.get("giant")).toMatchObject({
      imagePath: "mob-images/zombie/zombie.png",
      sourcePath: "assets/minecraft/textures/entity/zombie/zombie.png",
      origin: "renderer",
    });
    expect(imagesByLocalId.get("shulker")).toMatchObject({
      imagePath: "mob-images/shulker/shulker.png",
      sourcePath: "assets/minecraft/textures/entity/shulker/shulker.png",
      origin: "asset-search",
    });
    expect(imagesByLocalId.get("phantom")).toMatchObject({
      imagePath: "mob-images/generated/phantom.png",
      origin: "generated",
    });
  });

  test("resolves renderer-linked mob images from 26.2 EntityTypes registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-image-262-"));
    tempDirs.add(root);

    const decompiledClientRoot = join(root, "decompiled-client");
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/EntityRenderers.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.world.entity.EntityTypes;

public class EntityRenderers {
   static {
      register(EntityTypes.ALLAY, AllayRenderer::new);
      register(EntityTypes.GIANT, context -> new GiantMobRenderer(context, 6.0F));
   }
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/AllayRenderer.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.resources.Identifier;

public class AllayRenderer extends MobRenderer {
   private static final Identifier ALLAY_LOCATION = Identifier.withDefaultNamespace("textures/entity/allay/allay.png");
}`,
    );
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/client/renderer/entity/GiantMobRenderer.java",
      `package net.minecraft.client.renderer.entity;

import net.minecraft.resources.Identifier;

public class GiantMobRenderer extends MobRenderer {
   private static final Identifier ZOMBIE_LOCATION = Identifier.withDefaultNamespace("textures/entity/zombie/zombie.png");
}`,
    );

    const extractor = new MobImageExtractor(createConsoleLogger(false));
    const result = await extractor.extract(
      [createMob("allay", "Allay"), createMob("giant", "Giant")],
      [
        new InMemoryArchiveSource({
          "assets/minecraft/textures/entity/allay/allay.png": Buffer.from([0x01]),
          "assets/minecraft/textures/entity/zombie/zombie.png": Buffer.from([0x02]),
        }),
      ],
      decompiledClientRoot,
    );

    const imagesByLocalId = new Map(result.map((entry) => [entry.localId, entry]));
    expect(imagesByLocalId.get("allay")).toMatchObject({
      imagePath: "mob-images/allay/allay.png",
      origin: "renderer",
    });
    expect(imagesByLocalId.get("giant")).toMatchObject({
      imagePath: "mob-images/zombie/zombie.png",
      origin: "renderer",
    });
  });
});

function createMob(localId: string, displayName: string): MobSoundDefinition {
  return {
    id: `minecraft:${localId}`,
    localId,
    soundId: localId,
    displayName,
    translationKey: `entity.minecraft.${localId}`,
    category: "Creature",
    mobCategory: "CREATURE",
    soundEventCount: 0,
    soundVariantCount: 0,
    soundEvents: [],
  };
}

async function writeJavaFile(root: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}
