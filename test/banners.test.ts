import { describe, expect, test } from "vitest";
import { buildBanners } from "../src/extraction/banners.js";
import type { TranslationEntry } from "../src/domain/types.js";

const TEXTURE_PREFIX = "assets/minecraft/textures/entity/banner/";

function texture(id: string): string {
  return `${TEXTURE_PREFIX}${id}.png`;
}

describe("buildBanners", () => {
  const translations: TranslationEntry[] = [
    { key: "color.minecraft.white", value: "White" },
    { key: "color.minecraft.light_blue", value: "Light Blue" },
    { key: "color.minecraft.red", value: "Red" },
    { key: "color.minecraft.black", value: "Black" },
    { key: "block.minecraft.banner.base.white", value: "Fully White Field" },
    { key: "block.minecraft.banner.stripe_bottom.white", value: "White Base" },
    { key: "block.minecraft.banner.cross.white", value: "White Saltire" },
    { key: "block.minecraft.banner.diagonal_right.white", value: "White Per Bend Sinister" },
    { key: "block.minecraft.banner.creeper.white", value: "White Creeper Charge" },
    { key: "block.minecraft.banner.curly_border.white", value: "White Bordure Indented" },
  ];

  const texturePaths = [
    texture("base"),
    texture("banner_base"),
    texture("stripe_bottom"),
    texture("cross"),
    texture("diagonal_right"),
    texture("creeper"),
    texture("curly_border"),
    texture("orphan_without_name"), // present texture but no translation → excluded
    "assets/minecraft/textures/block/stone.png", // unrelated texture
  ];

  const result = buildBanners(translations, texturePaths);

  test("excludes the base fill, banner_base, and texture-only ids from the overlay catalog", () => {
    const ids = result.patterns.map((pattern) => pattern.id);
    expect(ids).not.toContain("base");
    expect(ids).not.toContain("banner_base");
    expect(ids).not.toContain("orphan_without_name");
  });

  test("orders overlays by the canonical loom order", () => {
    // curly_border precedes creeper in BannerPatterns.bootstrap() order.
    expect(result.patterns.map((pattern) => pattern.id)).toEqual([
      "stripe_bottom",
      "cross",
      "diagonal_right",
      "curly_border",
      "creeper",
    ]);
  });

  test("strips the color word from the heraldic label and sets the texture path", () => {
    const cross = result.patterns.find((pattern) => pattern.id === "cross");
    expect(cross?.label).toBe("Saltire");
    expect(cross?.texturePath).toBe("images/entity/banner/cross.png");
  });

  test("carries the correct legacy code, including the cross-mapped diagonals", () => {
    const code = (id: string) => result.patterns.find((pattern) => pattern.id === id)?.legacyCode;
    expect(code("stripe_bottom")).toBe("bs");
    expect(code("cross")).toBe("cr");
    // rud → diagonal_right is the easy-to-invert-wrong case.
    expect(code("diagonal_right")).toBe("rud");
  });

  test("flags patterns that need a banner-pattern item", () => {
    const creeper = result.patterns.find((pattern) => pattern.id === "creeper");
    expect(creeper?.requiresItem).toBe(true);
    expect(creeper?.patternItem).toBe("creeper_banner_pattern");

    const curly = result.patterns.find((pattern) => pattern.id === "curly_border");
    expect(curly?.requiresItem).toBe(true);
    expect(curly?.patternItem).toBe("bordure_indented_banner_pattern");

    const stripe = result.patterns.find((pattern) => pattern.id === "stripe_bottom");
    expect(stripe?.requiresItem).toBe(false);
    expect(stripe?.patternItem).toBeUndefined();
  });

  test("emits 16 dye colors in DyeColor id order with correct RGB and items", () => {
    expect(result.colors).toHaveLength(16);
    const white = result.colors[0];
    expect(white).toMatchObject({
      id: "white",
      label: "White",
      rgb: [249, 255, 254],
      hex: "#f9fffe",
      legacyId: 0,
      dyeItem: "white_dye",
      bannerItem: "white_banner",
    });
    const black = result.colors[15];
    expect(black).toMatchObject({ id: "black", legacyId: 15, rgb: [29, 29, 33] });
  });
});
