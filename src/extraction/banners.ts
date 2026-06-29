import type { BannerColorDefinition, BannerDataset, BannerPatternDefinition, TranslationEntry } from "../domain/types.js";

const BANNER_TEXTURE_PREFIX = "assets/minecraft/textures/entity/banner/";

/**
 * `DyeColor.getTextureDiffuseColor()` — the RGB the game multiplies a banner's
 * base fill and every pattern layer by. These live in decompiled source
 * (`net.minecraft.world.item.DyeColor`), not in any data-pack JSON, so they are
 * curated here, in `DyeColor` id order (white=0 … black=15). Decimal = 0xRRGGBB.
 */
const DYE_TEXTURE_COLORS: Array<readonly [string, number]> = [
  ["white", 16383998],
  ["orange", 16351261],
  ["magenta", 13061821],
  ["light_blue", 3847130],
  ["yellow", 16701501],
  ["lime", 8439583],
  ["pink", 15961002],
  ["gray", 4673362],
  ["light_gray", 10329495],
  ["cyan", 1481884],
  ["purple", 8991416],
  ["blue", 3949738],
  ["brown", 8606770],
  ["green", 6192150],
  ["red", 11546150],
  ["black", 1908001],
];

/**
 * Canonical loom display order, mirroring `BannerPatterns.bootstrap()`. `base`
 * is the base-color fill (kept as an asset, excluded from the overlay catalog);
 * everything after it is an overlay. Patterns present in a version but missing
 * here are appended in id order, so newer snapshots never silently drop one.
 */
const PATTERN_ORDER: string[] = [
  "base",
  "square_bottom_left",
  "square_bottom_right",
  "square_top_left",
  "square_top_right",
  "stripe_bottom",
  "stripe_top",
  "stripe_left",
  "stripe_right",
  "stripe_center",
  "stripe_middle",
  "stripe_downright",
  "stripe_downleft",
  "small_stripes",
  "cross",
  "straight_cross",
  "triangle_bottom",
  "triangle_top",
  "triangles_bottom",
  "triangles_top",
  "diagonal_left",
  "diagonal_up_right",
  "diagonal_up_left",
  "diagonal_right",
  "circle",
  "rhombus",
  "half_vertical",
  "half_horizontal",
  "half_vertical_right",
  "half_horizontal_bottom",
  "border",
  "gradient",
  "gradient_up",
  "bricks",
  "curly_border",
  "globe",
  "creeper",
  "skull",
  "flower",
  "mojang",
  "piglin",
  "flow",
  "guster",
];

/**
 * Modern pattern id → legacy 2-letter NBT code, inverted from
 * `BannerPatternFormatFix.PATTERN_ID_MAP`. Note the deliberately confusing
 * diagonal cross-mapping (`rd` → diagonal_up_right, `rud` → diagonal_right).
 * `flow`/`guster` arrived after the legacy string format was retired, so they
 * have no code.
 */
const LEGACY_CODES: Record<string, string> = {
  base: "b",
  square_bottom_left: "bl",
  square_bottom_right: "br",
  square_top_left: "tl",
  square_top_right: "tr",
  stripe_bottom: "bs",
  stripe_top: "ts",
  stripe_left: "ls",
  stripe_right: "rs",
  stripe_center: "cs",
  stripe_middle: "ms",
  stripe_downright: "drs",
  stripe_downleft: "dls",
  small_stripes: "ss",
  cross: "cr",
  straight_cross: "sc",
  triangle_bottom: "bt",
  triangle_top: "tt",
  triangles_bottom: "bts",
  triangles_top: "tts",
  diagonal_left: "ld",
  diagonal_up_right: "rd",
  diagonal_up_left: "lud",
  diagonal_right: "rud",
  circle: "mc",
  rhombus: "mr",
  half_vertical: "vh",
  half_horizontal: "hh",
  half_vertical_right: "vhr",
  half_horizontal_bottom: "hhb",
  border: "bo",
  curly_border: "cbo",
  gradient: "gra",
  gradient_up: "gru",
  bricks: "bri",
  globe: "glb",
  creeper: "cre",
  skull: "sku",
  flower: "flo",
  mojang: "moj",
  piglin: "pig",
};

/** Patterns the loom can only apply with a special banner-pattern item. */
const PATTERN_ITEMS: Record<string, string> = {
  creeper: "creeper_banner_pattern",
  skull: "skull_banner_pattern",
  flower: "flower_banner_pattern",
  mojang: "mojang_banner_pattern",
  globe: "globe_banner_pattern",
  piglin: "piglin_banner_pattern",
  flow: "flow_banner_pattern",
  guster: "guster_banner_pattern",
  bricks: "field_masoned_banner_pattern",
  curly_border: "bordure_indented_banner_pattern",
};

/**
 * Build the banner dataset from data the extractor already gathers: the overlay
 * patterns are the `entity/banner/<id>.png` textures that also have a
 * `block.minecraft.banner.<id>.*` name in `en_us`; their heraldic labels come
 * from the white variant with the color word stripped. Dye RGB / legacy codes
 * are curated constants. Pure and self-contained, mirroring buildBiomes.
 */
export function buildBanners(translations: TranslationEntry[], texturePaths: string[]): BannerDataset {
  const names = new Map(translations.map((entry) => [entry.key, entry.value] as const));
  const bannerTextures = new Set(
    texturePaths
      .filter((path) => path.startsWith(BANNER_TEXTURE_PREFIX) && path.endsWith(".png"))
      .map((path) => path.slice(BANNER_TEXTURE_PREFIX.length, path.length - ".png".length)),
  );
  const whiteLabel = names.get("color.minecraft.white") ?? "White";

  const colors: BannerColorDefinition[] = DYE_TEXTURE_COLORS.map(([id, decimal], legacyId) => {
    const rgb: [number, number, number] = [(decimal >> 16) & 0xff, (decimal >> 8) & 0xff, decimal & 0xff];
    return {
      id,
      label: names.get(`color.minecraft.${id}`) ?? humanize(id),
      rgb,
      hex: `#${decimal.toString(16).padStart(6, "0")}`,
      legacyId,
      dyeItem: `${id}_dye`,
      bannerItem: `${id}_banner`,
    };
  });

  // Overlay patterns: anything with both a texture and a name, ordered by the
  // canonical loom order, then any extras (future ids) in id order. `base` is
  // the fill, not an overlay, so it is excluded here.
  const candidates = new Set<string>();
  for (const id of bannerTextures) {
    if (id !== "base" && names.has(`block.minecraft.banner.${id}.white`)) {
      candidates.add(id);
    }
  }
  const ordered = [
    ...PATTERN_ORDER.filter((id) => id !== "base" && candidates.has(id)),
    ...[...candidates].filter((id) => !PATTERN_ORDER.includes(id)).sort(),
  ];

  const patterns: BannerPatternDefinition[] = ordered.map((id) => {
    const raw = names.get(`block.minecraft.banner.${id}.white`);
    const label = raw ? raw.replace(new RegExp(`^${whiteLabel}\\s+`), "") : humanize(id);
    const patternItem = PATTERN_ITEMS[id];
    return {
      id,
      assetId: id,
      texturePath: `images/entity/banner/${id}.png`,
      label,
      legacyCode: LEGACY_CODES[id],
      requiresItem: patternItem !== undefined,
      ...(patternItem ? { patternItem } : {}),
    };
  });

  return { patterns, colors };
}

function humanize(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
