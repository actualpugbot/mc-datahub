import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { createConsoleLogger } from "../src/core/logger.js";
import { RenderDataExtractor } from "../src/extraction/renderDataExtractor.js";

describe("render data extractor", () => {
  test("preserves blockstate parts and resolves model parent textures", async () => {
    const archive = new InMemoryArchiveSource({
      "assets/minecraft/blockstates/glass_pane.json": JSON.stringify({
        multipart: [
          { apply: { model: "minecraft:block/glass_pane_post" } },
          { when: { north: "true" }, apply: { model: "minecraft:block/glass_pane_side", y: 0 } },
        ],
      }),
      "assets/minecraft/models/block/pane_template.json": JSON.stringify({
        textures: { pane: "minecraft:block/glass" },
        elements: [
          {
            from: [7, 0, 7],
            to: [9, 16, 9],
            faces: {
              north: { texture: "#pane", tintindex: 0, cullface: "north" },
            },
          },
        ],
      }),
      "assets/minecraft/models/block/glass_pane_post.json": JSON.stringify({
        parent: "minecraft:block/pane_template",
      }),
      "assets/minecraft/models/block/glass_pane_side.json": JSON.stringify({
        parent: "minecraft:block/pane_template",
        textures: { pane: "minecraft:block/glass_pane_top" },
      }),
      "assets/minecraft/textures/block/glass.png": pngHeader(6),
      "assets/minecraft/textures/block/glass_pane_top.png": pngHeader(6),
      "assets/minecraft/atlases/blocks.json": JSON.stringify({
        sources: [{ type: "minecraft:directory", source: "block", prefix: "block/" }],
      }),
    });

    const data = await new RenderDataExtractor(createConsoleLogger(false)).extract("test", [archive]);
    const pane = data.blockstates.find((entry) => entry.id === "minecraft:glass_pane");
    const post = data.blockModels.find((entry) => entry.id === "minecraft:block/glass_pane_post");
    const side = data.blockModels.find((entry) => entry.id === "minecraft:block/glass_pane_side");

    expect(pane?.multipart).toHaveLength(2);
    expect(pane?.multipart[1]?.when).toEqual({ north: "true" });
    expect(pane?.properties).toEqual({ north: ["true"] });
    expect(post?.parentChain).toEqual(["minecraft:block/pane_template"]);
    expect(post?.elements[0]?.faces.north?.resolvedTextureId).toBe("minecraft:block/glass");
    expect(side?.elements[0]?.faces.north?.resolvedTextureId).toBe("minecraft:block/glass_pane_top");
    expect(data.renderLayers.find((entry) => entry.layer === "translucent")?.blocks).toContain("minecraft:glass_pane");
    expect(data.textures.find((entry) => entry.id === "minecraft:block/glass")?.atlases).toContain("minecraft:blocks");
  });

  test("exports modern GUI item descriptors and special renderer kinds", async () => {
    const archive = new InMemoryArchiveSource({
      "assets/minecraft/items/shield.json": JSON.stringify({
        model: {
          type: "minecraft:special",
          base: "minecraft:item/shield",
          model: { type: "minecraft:shield" },
        },
      }),
      "assets/minecraft/models/item/shield.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/shield" },
        display: {
          gui: {
            rotation: [0, 0, 0],
            translation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      }),
      "assets/minecraft/textures/item/shield.png": pngHeader(6),
      "assets/minecraft/lang/en_us.json": JSON.stringify({
        "item.minecraft.shield": "Shield",
      }),
    });

    const data = await new RenderDataExtractor(createConsoleLogger(false)).extract("test", [archive], {
      translations: [{ key: "item.minecraft.shield", value: "Shield" }],
    });
    const shield = data.itemDisplays.find((entry) => entry.id === "minecraft:shield");

    expect(shield).toMatchObject({
      displayName: "Shield",
      modelRef: "minecraft:item/shield",
      renderKind: "special_renderer",
      specialRendererKinds: ["shield"],
      textureLayers: ["minecraft:item/shield"],
    });
    expect(shield?.displayTransforms.gui).toEqual({
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(data.specialRenderers.some((entry) => entry.id === "minecraft:shield" && entry.rendererKind === "shield")).toBe(true);
  });
});

function pngHeader(colorType: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(16, 16);
  buffer.writeUInt32BE(16, 20);
  buffer[24] = 8;
  buffer[25] = colorType;
  return buffer;
}
