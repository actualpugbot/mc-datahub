import type { ArchiveSource } from "../archive/archiveSource.js";
import type { PaletteDefinition } from "../domain/types.js";
import { idFromAssetPath } from "./normalizers.js";
import { decodePng } from "./png.js";

const TEXTURE_PREFIX = "assets/minecraft/textures/";
const TRIM_TEXTURE_PREFIX = "assets/minecraft/textures/trims/color_palettes/";
const COLORMAP_TEXTURE_PREFIX = "assets/minecraft/textures/colormap/";

const COLORMAP_SAMPLE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0.08, 0.18],
  [0.16, 0.28],
  [0.24, 0.38],
  [0.32, 0.48],
  [0.4, 0.58],
  [0.48, 0.68],
  [0.56, 0.78],
  [0.64, 0.88],
];

interface MaterialSeed {
  slug: string;
  label: string;
  tone: string;
  warm: boolean;
}

const MATERIAL_SEEDS: MaterialSeed[] = [
  { slug: "amethyst", label: "Amethyst", tone: "arcane glow", warm: false },
  { slug: "copper", label: "Copper", tone: "weathered furnace heat", warm: true },
  { slug: "diamond", label: "Diamond", tone: "glacial shine", warm: false },
  { slug: "emerald", label: "Emerald", tone: "lush mineral bloom", warm: false },
  { slug: "gold", label: "Gold", tone: "sunlit ore", warm: true },
  { slug: "iron", label: "Iron", tone: "tempered metal", warm: false },
  { slug: "lapis", label: "Lapis", tone: "enchanted tide", warm: false },
  { slug: "netherite", label: "Netherite", tone: "ashen alloy", warm: true },
  { slug: "quartz", label: "Quartz", tone: "clean stone light", warm: false },
  { slug: "redstone", label: "Redstone", tone: "charged ember", warm: true },
  { slug: "resin", label: "Resin", tone: "amber glow", warm: true },
];

const DARK_VARIANTS = new Map<string, string>([
  ["copper", "copper_darker"],
  ["diamond", "diamond_darker"],
  ["gold", "gold_darker"],
  ["iron", "iron_darker"],
  ["netherite", "netherite_darker"],
]);

type PaletteMap = Map<string, PaletteDefinition>;

interface NamedPresetSpec {
  category: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  sources: string[];
  colors: (paletteMap: PaletteMap) => string[];
}

const NAMED_CURATED_PRESETS: NamedPresetSpec[] = [
  {
    category: "biome",
    slug: "sunlit-meadow",
    name: "Sunlit Meadow",
    description: "A bright overworld noon mix with meadow greens and warm gold accents.",
    tags: ["biome", "grass", "gold", "quartz", "day"],
    sources: [extractedColormapId("grass"), extractedTrimId("gold"), extractedTrimId("quartz")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("grass"), 0),
        getColor(paletteMap, extractedColormapId("grass"), 2),
        mixPaletteColor(paletteMap, extractedColormapId("grass"), 4, extractedTrimId("gold"), 0, 0.35),
        getColor(paletteMap, extractedTrimId("gold"), 1),
        getColor(paletteMap, extractedTrimId("quartz"), 1),
      ),
  },
  {
    category: "biome",
    slug: "riverbank",
    name: "Riverbank",
    description: "Cool water-edge greens balanced with diamond glass and pale stone.",
    tags: ["biome", "grass", "diamond", "quartz", "water"],
    sources: [extractedColormapId("grass"), extractedTrimId("diamond"), extractedTrimId("quartz")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("grass"), 1),
        getColor(paletteMap, extractedColormapId("grass"), 3),
        mixPaletteColor(paletteMap, extractedColormapId("grass"), 4, extractedTrimId("diamond"), 1, 0.4),
        getColor(paletteMap, extractedTrimId("diamond"), 2),
        getColor(paletteMap, extractedTrimId("quartz"), 2),
      ),
  },
  {
    category: "biome",
    slug: "deep-forest",
    name: "Deep Forest",
    description: "Dense canopy greens rooted in emerald bloom and netherite shadow.",
    tags: ["biome", "foliage", "emerald", "netherite", "forest"],
    sources: [extractedColormapId("foliage"), extractedTrimId("emerald"), extractedTrimId("netherite")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("foliage"), 1),
        getColor(paletteMap, extractedColormapId("foliage"), 3),
        getColor(paletteMap, extractedTrimId("emerald"), 2),
        mixPaletteColor(paletteMap, extractedTrimId("emerald"), 4, extractedTrimId("netherite"), 2, 0.45),
        getColor(paletteMap, extractedTrimId("netherite"), 5),
      ),
  },
  {
    category: "biome",
    slug: "birch-hollow",
    name: "Birch Hollow",
    description: "Soft foliage and pale bark notes cooled by iron and quartz.",
    tags: ["biome", "foliage", "quartz", "iron", "birch"],
    sources: [extractedColormapId("foliage"), extractedTrimId("quartz"), extractedTrimId("iron")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("quartz"), 0),
        getColor(paletteMap, extractedColormapId("foliage"), 2),
        mixPaletteColor(paletteMap, extractedColormapId("foliage"), 4, extractedTrimId("iron"), 2, 0.35),
        getColor(paletteMap, extractedTrimId("iron"), 4),
        getColor(paletteMap, extractedTrimId("quartz"), 6),
      ),
  },
  {
    category: "biome",
    slug: "badlands-wind",
    name: "Badlands Wind",
    description: "Dry terracotta heat with copper dust and resin orange.",
    tags: ["biome", "dry_foliage", "copper", "resin", "badlands"],
    sources: [extractedColormapId("dry_foliage"), extractedTrimId("copper"), extractedTrimId("resin")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("dry_foliage"), 0),
        getColor(paletteMap, extractedColormapId("dry_foliage"), 2),
        mixPaletteColor(paletteMap, extractedColormapId("dry_foliage"), 4, extractedTrimId("copper"), 1, 0.35),
        getColor(paletteMap, extractedTrimId("resin"), 2),
        getColor(paletteMap, extractedTrimId("copper"), 5),
      ),
  },
  {
    category: "biome",
    slug: "desert-oasis",
    name: "Desert Oasis",
    description: "Dry sand warmth softened by oasis greens and bright ore light.",
    tags: ["biome", "dry_foliage", "grass", "gold", "desert"],
    sources: [extractedColormapId("dry_foliage"), extractedColormapId("grass"), extractedTrimId("gold")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("dry_foliage"), 1),
        mixPaletteColor(paletteMap, extractedColormapId("dry_foliage"), 2, extractedColormapId("grass"), 0, 0.3),
        getColor(paletteMap, extractedColormapId("grass"), 2),
        getColor(paletteMap, extractedTrimId("gold"), 1),
        getColor(paletteMap, extractedTrimId("gold"), 4),
      ),
  },
  {
    category: "biome",
    slug: "lush-cavern",
    name: "Lush Cavern",
    description: "Foliage greens lit by mineral blue and anchored with iron stone.",
    tags: ["biome", "foliage", "diamond", "iron", "cave"],
    sources: [extractedColormapId("foliage"), extractedTrimId("diamond"), extractedTrimId("iron")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("foliage"), 0),
        getColor(paletteMap, extractedColormapId("foliage"), 2),
        getColor(paletteMap, extractedTrimId("diamond"), 2),
        mixPaletteColor(paletteMap, extractedTrimId("diamond"), 3, extractedTrimId("iron"), 2, 0.35),
        getColor(paletteMap, extractedTrimId("iron"), 5),
      ),
  },
  {
    category: "biome",
    slug: "cherry-grove",
    name: "Cherry Grove",
    description: "Meadow greens softened with amethyst blossom and pale stone.",
    tags: ["biome", "grass", "amethyst", "quartz", "spring"],
    sources: [extractedColormapId("grass"), extractedTrimId("amethyst"), extractedTrimId("quartz")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("quartz"), 0),
        getColor(paletteMap, extractedColormapId("grass"), 1),
        mixPaletteColor(paletteMap, extractedColormapId("grass"), 3, extractedTrimId("amethyst"), 1, 0.4),
        getColor(paletteMap, extractedTrimId("amethyst"), 2),
        getColor(paletteMap, extractedTrimId("quartz"), 4),
      ),
  },
  {
    category: "biome",
    slug: "mangrove-mire",
    name: "Mangrove Mire",
    description: "Swamp greens and damp clay browns with emerald highlights.",
    tags: ["biome", "foliage", "dry_foliage", "emerald", "swamp"],
    sources: [extractedColormapId("foliage"), extractedColormapId("dry_foliage"), extractedTrimId("emerald"), extractedTrimId("iron")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedColormapId("dry_foliage"), 1),
        getColor(paletteMap, extractedColormapId("foliage"), 2),
        mixPaletteColor(paletteMap, extractedColormapId("foliage"), 4, extractedTrimId("emerald"), 2, 0.35),
        getColor(paletteMap, extractedTrimId("emerald"), 4),
        getColor(paletteMap, extractedTrimId("iron"), 6),
      ),
  },
  {
    category: "biome",
    slug: "frozen-pine",
    name: "Frozen Pine",
    description: "Cold needles and icy minerals with subdued iron shadow.",
    tags: ["biome", "grass", "diamond_darker", "iron", "snow"],
    sources: [extractedColormapId("grass"), extractedTrimId("diamond_darker"), extractedTrimId("iron")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("iron"), 0),
        getColor(paletteMap, extractedColormapId("grass"), 2),
        getColor(paletteMap, extractedTrimId("diamond_darker"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("diamond_darker"), 4, extractedTrimId("iron"), 3, 0.4),
        getColor(paletteMap, extractedTrimId("iron"), 6),
      ),
  },
  {
    category: "dimension",
    slug: "nether-ember",
    name: "Nether Ember",
    description: "Hot resin and redstone flare sinking into netherite ash.",
    tags: ["dimension", "nether", "resin", "redstone", "netherite"],
    sources: [extractedTrimId("resin"), extractedTrimId("redstone"), extractedTrimId("netherite")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("resin"), 0),
        getColor(paletteMap, extractedTrimId("redstone"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("resin"), 3, extractedTrimId("redstone"), 3, 0.45),
        getColor(paletteMap, extractedTrimId("netherite"), 3),
        getColor(paletteMap, extractedTrimId("netherite"), 6),
      ),
  },
  {
    category: "dimension",
    slug: "basalt-fortress",
    name: "Basalt Fortress",
    description: "Harsh netherite shadow cut by quartz dust and redstone heat.",
    tags: ["dimension", "nether", "netherite_darker", "quartz", "redstone"],
    sources: [extractedTrimId("netherite_darker"), extractedTrimId("quartz"), extractedTrimId("redstone")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("quartz"), 1),
        getColor(paletteMap, extractedTrimId("netherite_darker"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("netherite_darker"), 3, extractedTrimId("redstone"), 2, 0.25),
        getColor(paletteMap, extractedTrimId("redstone"), 4),
        getColor(paletteMap, extractedTrimId("netherite_darker"), 7),
      ),
  },
  {
    category: "dimension",
    slug: "warped-echo",
    name: "Warped Echo",
    description: "A warped-forest blend of teal diamond, lapis depth, and smoky shadow.",
    tags: ["dimension", "nether", "diamond", "lapis", "netherite"],
    sources: [extractedTrimId("diamond"), extractedTrimId("lapis"), extractedTrimId("netherite")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("diamond"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("diamond"), 2, extractedTrimId("lapis"), 1, 0.35),
        getColor(paletteMap, extractedTrimId("lapis"), 3),
        getColor(paletteMap, extractedTrimId("netherite"), 3),
        getColor(paletteMap, extractedTrimId("netherite"), 6),
      ),
  },
  {
    category: "dimension",
    slug: "crimson-bloom",
    name: "Crimson Bloom",
    description: "Nether reds and gold-darkened ore for hostile flora palettes.",
    tags: ["dimension", "nether", "redstone", "gold_darker", "netherite"],
    sources: [extractedTrimId("redstone"), extractedTrimId("gold_darker"), extractedTrimId("netherite")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("gold_darker"), 0),
        getColor(paletteMap, extractedTrimId("redstone"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("redstone"), 3, extractedTrimId("gold_darker"), 3, 0.35),
        getColor(paletteMap, extractedTrimId("netherite"), 4),
        getColor(paletteMap, extractedTrimId("netherite"), 7),
      ),
  },
  {
    category: "dimension",
    slug: "end-chorus",
    name: "End Chorus",
    description: "Soft violet and bone-white tones tuned for floating islands and chorus fields.",
    tags: ["dimension", "end", "amethyst", "quartz", "iron"],
    sources: [extractedTrimId("amethyst"), extractedTrimId("quartz"), extractedTrimId("iron")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("quartz"), 0),
        getColor(paletteMap, extractedTrimId("amethyst"), 1),
        getColor(paletteMap, extractedTrimId("amethyst"), 3),
        mixPaletteColor(paletteMap, extractedTrimId("amethyst"), 4, extractedTrimId("iron"), 3, 0.35),
        getColor(paletteMap, extractedTrimId("iron"), 6),
      ),
  },
  {
    category: "dimension",
    slug: "void-garden",
    name: "Void Garden",
    description: "A darker End-adjacent palette with violet bloom over mineral shadow.",
    tags: ["dimension", "end", "amethyst", "diamond_darker", "netherite_darker"],
    sources: [extractedTrimId("amethyst"), extractedTrimId("diamond_darker"), extractedTrimId("netherite_darker")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("diamond_darker"), 0),
        getColor(paletteMap, extractedTrimId("amethyst"), 2),
        mixPaletteColor(paletteMap, extractedTrimId("amethyst"), 4, extractedTrimId("diamond_darker"), 4, 0.5),
        getColor(paletteMap, extractedTrimId("netherite_darker"), 4),
        getColor(paletteMap, extractedTrimId("netherite_darker"), 7),
      ),
  },
  {
    category: "dimension",
    slug: "ancient-city",
    name: "Ancient City",
    description: "Muted sculk blues and deep stone for stealth-heavy underground palettes.",
    tags: ["dimension", "deep_dark", "lapis", "netherite_darker", "iron_darker"],
    sources: [extractedTrimId("lapis"), extractedTrimId("netherite_darker"), extractedTrimId("iron_darker")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("iron_darker"), 0),
        getColor(paletteMap, extractedTrimId("lapis"), 2),
        mixPaletteColor(paletteMap, extractedTrimId("lapis"), 4, extractedTrimId("netherite_darker"), 2, 0.45),
        getColor(paletteMap, extractedTrimId("netherite_darker"), 4),
        getColor(paletteMap, extractedTrimId("iron_darker"), 7),
      ),
  },
  {
    category: "dimension",
    slug: "trial-vault",
    name: "Trial Vault",
    description: "Oxidized copper, heavy iron, and antique gold tuned for chamber builds.",
    tags: ["dimension", "trial_chambers", "copper", "iron", "gold_darker"],
    sources: [extractedTrimId("copper"), extractedTrimId("iron"), extractedTrimId("gold_darker")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("iron"), 0),
        getColor(paletteMap, extractedTrimId("copper"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("copper"), 3, extractedTrimId("gold_darker"), 2, 0.4),
        getColor(paletteMap, extractedTrimId("gold_darker"), 4),
        getColor(paletteMap, extractedTrimId("iron"), 6),
      ),
  },
  {
    category: "dimension",
    slug: "redstone-lab",
    name: "Redstone Lab",
    description: "High-contrast circuitry colors for machines, UI chrome, and indicators.",
    tags: ["dimension", "redstone", "iron", "quartz", "technology"],
    sources: [extractedTrimId("redstone"), extractedTrimId("iron"), extractedTrimId("quartz")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("quartz"), 0),
        getColor(paletteMap, extractedTrimId("iron"), 1),
        getColor(paletteMap, extractedTrimId("redstone"), 1),
        mixPaletteColor(paletteMap, extractedTrimId("redstone"), 4, extractedTrimId("iron"), 4, 0.35),
        getColor(paletteMap, extractedTrimId("quartz"), 6),
      ),
  },
  {
    category: "dimension",
    slug: "beacon-chamber",
    name: "Beacon Chamber",
    description: "Clean quartz and diamond light with a trace of gold for prestige builds.",
    tags: ["dimension", "beacon", "diamond", "quartz", "gold"],
    sources: [extractedTrimId("diamond"), extractedTrimId("quartz"), extractedTrimId("gold")],
    colors: (paletteMap) =>
      composeColors(
        getColor(paletteMap, extractedTrimId("quartz"), 0),
        getColor(paletteMap, extractedTrimId("diamond"), 1),
        getColor(paletteMap, extractedTrimId("diamond"), 3),
        getColor(paletteMap, extractedTrimId("gold"), 1),
        getColor(paletteMap, extractedTrimId("quartz"), 5),
      ),
  },
];

export async function buildPalettes(paths: string[], source: ArchiveSource): Promise<PaletteDefinition[]> {
  const extractedPalettes = await buildExtractedPalettes(paths, source);
  const curatedPalettes = buildCuratedPalettes(extractedPalettes);
  return [...extractedPalettes, ...curatedPalettes].sort((left, right) => left.id.localeCompare(right.id));
}

async function buildExtractedPalettes(paths: string[], source: ArchiveSource): Promise<PaletteDefinition[]> {
  const extractedPalettes: PaletteDefinition[] = [];
  const relevantPaths = paths.filter(
    (path) =>
      (path.startsWith(TRIM_TEXTURE_PREFIX) || path.startsWith(COLORMAP_TEXTURE_PREFIX)) && path.endsWith(".png"),
  );

  for (const path of relevantPaths.sort()) {
    const buffer = await source.readBuffer(path);
    const decoded = decodePng(buffer);
    const textureId = idFromAssetPath(TEXTURE_PREFIX, path);
    const slug = basenameWithoutExtension(path);

    if (path.startsWith(TRIM_TEXTURE_PREFIX)) {
      extractedPalettes.push({
        id: extractedTrimId(slug),
        kind: "extracted",
        category: "trim",
        name: slug === "trim_palette" ? "Default Trim Ramp" : `${humanizeSlug(slug)} Trim`,
        description:
          slug === "trim_palette"
            ? "The default grayscale trim ramp extracted from vanilla armor trim palette textures."
            : `Extracted directly from the vanilla ${humanizeSlug(slug).toLowerCase()} trim palette texture.`,
        colors: uniqueColors(decoded.pixels.map(rgbToHex)),
        sources: [textureId],
        tags: buildTags("extracted", "trim", slug),
      });
      continue;
    }

    extractedPalettes.push({
      id: extractedColormapId(slug),
      kind: "extracted",
      category: "colormap",
      name: `${humanizeSlug(slug)} Colormap`,
      description: `Representative swatches sampled across the vanilla ${humanizeSlug(slug).toLowerCase()} colormap texture.`,
      colors: uniqueColors(
        COLORMAP_SAMPLE_POINTS.map(([x, y]) => samplePixel(decoded.width, decoded.height, decoded.pixels, x, y)).map(rgbToHex),
      ),
      sources: [textureId],
      tags: buildTags("extracted", "colormap", slug),
    });
  }

  return extractedPalettes.sort((left, right) => left.id.localeCompare(right.id));
}

function buildCuratedPalettes(extractedPalettes: PaletteDefinition[]): PaletteDefinition[] {
  const paletteMap: PaletteMap = new Map(extractedPalettes.map((palette) => [palette.id, palette]));

  return [
    ...buildMaterialPresets(paletteMap),
    ...buildFusionPresets(paletteMap),
    ...buildNamedCuratedPresets(paletteMap),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function buildMaterialPresets(paletteMap: PaletteMap): PaletteDefinition[] {
  const presets: PaletteDefinition[] = [];

  for (const material of MATERIAL_SEEDS) {
    const baseId = extractedTrimId(material.slug);
    const basePalette = paletteMap.get(baseId);
    if (!basePalette) {
      continue;
    }

    const depthSourceId = DARK_VARIANTS.get(material.slug) ? extractedTrimId(DARK_VARIANTS.get(material.slug) ?? "") : baseId;
    const neutralPaletteId = findNeutralPaletteId(material, paletteMap);

    pushIfDefined(
      presets,
      createCuratedPalette({
        category: "material",
        slug: `${material.slug}-radiance`,
        name: `${material.label} Radiance`,
        description: `A bright ${material.tone} gradient pulled straight from the vanilla ${material.label.toLowerCase()} trim colors.`,
        tags: ["material", material.slug, "bright"],
        sources: [baseId],
        colors: composeColors(
          getColor(paletteMap, baseId, 0),
          getColor(paletteMap, baseId, 1),
          getColor(paletteMap, baseId, 2),
          getColor(paletteMap, baseId, 4),
          getColor(paletteMap, baseId, 7),
        ),
      }),
    );

    pushIfDefined(
      presets,
      createCuratedPalette({
        category: "material",
        slug: `${material.slug}-depth`,
        name: `${material.label} Depth`,
        description: `A shadow-heavy cut of ${material.tone} tuned for darker builds and muted accents.`,
        tags: ["material", material.slug, "dark"],
        sources: depthSourceId === baseId ? [baseId] : [baseId, depthSourceId],
        colors: composeColors(
          getColor(paletteMap, depthSourceId, 0),
          getColor(paletteMap, depthSourceId, 2),
          getColor(paletteMap, depthSourceId, 4),
          getColor(paletteMap, depthSourceId, 6),
          getColor(paletteMap, depthSourceId, 7),
        ),
      }),
    );

    if (neutralPaletteId) {
      pushIfDefined(
        presets,
        createCuratedPalette({
          category: "material",
          slug: `${material.slug}-vein`,
          name: `${material.label} Vein`,
          description: `A curated vein that tempers ${material.tone} with a steadier neutral trim ramp.`,
          tags: ["material", material.slug, "neutral"],
          sources: [baseId, neutralPaletteId],
          colors: composeColors(
            getColor(paletteMap, neutralPaletteId, 0),
            getColor(paletteMap, baseId, 1),
            mixPaletteColor(paletteMap, baseId, 2, neutralPaletteId, 2, 0.35),
            getColor(paletteMap, baseId, 4),
            getColor(paletteMap, neutralPaletteId, 6),
          ),
        }),
      );
    }
  }

  return presets;
}

function buildFusionPresets(paletteMap: PaletteMap): PaletteDefinition[] {
  const availableMaterials = MATERIAL_SEEDS.filter((material) => paletteMap.has(extractedTrimId(material.slug)));
  const presets: PaletteDefinition[] = [];

  for (let leftIndex = 0; leftIndex < availableMaterials.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < availableMaterials.length; rightIndex += 1) {
      const left = availableMaterials[leftIndex];
      const right = availableMaterials[rightIndex];
      if (!left || !right) {
        continue;
      }

      const leftId = extractedTrimId(left.slug);
      const rightId = extractedTrimId(right.slug);

      pushIfDefined(
        presets,
        createCuratedPalette({
          category: "fusion",
          slug: `${left.slug}-${right.slug}`,
          name: `${left.label} + ${right.label} Fusion`,
          description: `A curated bridge between ${left.tone} and ${right.tone}.`,
          tags: ["fusion", left.slug, right.slug],
          sources: [leftId, rightId],
          colors: composeColors(
            getColor(paletteMap, leftId, 0),
            getColor(paletteMap, leftId, 2),
            mixPaletteColor(paletteMap, leftId, 3, rightId, 1, 0.5),
            getColor(paletteMap, rightId, 2),
            getColor(paletteMap, rightId, 5),
          ),
        }),
      );
    }
  }

  return presets;
}

function buildNamedCuratedPresets(paletteMap: PaletteMap): PaletteDefinition[] {
  const presets: PaletteDefinition[] = [];

  for (const preset of NAMED_CURATED_PRESETS) {
    if (!preset.sources.every((sourceId) => paletteMap.has(sourceId))) {
      continue;
    }

    pushIfDefined(
      presets,
      createCuratedPalette({
        category: preset.category,
        slug: preset.slug,
        name: preset.name,
        description: preset.description,
        tags: preset.tags,
        sources: preset.sources,
        colors: preset.colors(paletteMap),
      }),
    );
  }

  return presets;
}

function createCuratedPalette(input: {
  category: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  sources: string[];
  colors: string[];
}): PaletteDefinition | undefined {
  const colors = uniqueColors(input.colors);
  if (colors.length < 4) {
    return undefined;
  }

  return {
    id: `minecraft:palette/curated/${input.category}/${input.slug}`,
    kind: "curated",
    category: input.category,
    name: input.name,
    description: input.description,
    colors,
    sources: uniqueStrings(input.sources),
    tags: uniqueStrings(["curated", input.category, ...input.tags]),
  };
}

function extractedTrimId(slug: string): string {
  return `minecraft:palette/extracted/trim/${slug}`;
}

function extractedColormapId(slug: string): string {
  return `minecraft:palette/extracted/colormap/${slug}`;
}

function findNeutralPaletteId(material: MaterialSeed, paletteMap: PaletteMap): string | undefined {
  const preferredNeutralIds = material.slug === "iron"
    ? [extractedTrimId("quartz"), extractedTrimId("trim_palette")]
    : material.slug === "quartz"
      ? [extractedTrimId("iron"), extractedTrimId("trim_palette")]
      : material.warm
        ? [extractedTrimId("quartz"), extractedTrimId("trim_palette"), extractedTrimId("iron")]
        : [extractedTrimId("iron"), extractedTrimId("trim_palette"), extractedTrimId("quartz")];

  return preferredNeutralIds.find((candidateId) => paletteMap.has(candidateId) && candidateId !== extractedTrimId(material.slug));
}

function buildTags(kind: string, category: string, slug: string): string[] {
  return uniqueStrings([kind, category, ...slug.split(/[_/]+/g)]);
}

function basenameWithoutExtension(path: string): string {
  const parts = path.split("/");
  const fileName = parts[parts.length - 1] ?? path;
  return fileName.replace(/\.png$/i, "");
}

function humanizeSlug(value: string): string {
  return value
    .split(/[_/]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function samplePixel(
  width: number,
  height: number,
  pixels: ReadonlyArray<readonly [number, number, number]>,
  x: number,
  y: number,
): readonly [number, number, number] {
  const pixelX = Math.min(width - 1, Math.max(0, Math.floor(width * x)));
  const pixelY = Math.min(height - 1, Math.max(0, Math.floor(height * y)));
  return pixels[pixelY * width + pixelX] ?? [0, 0, 0];
}

function rgbToHex([red, green, blue]: readonly [number, number, number]): string {
  return `#${[red, green, blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function getColor(paletteMap: PaletteMap, paletteId: string, index: number): string | undefined {
  const palette = paletteMap.get(paletteId);
  if (!palette || palette.colors.length === 0) {
    return undefined;
  }

  const normalizedIndex = Math.min(Math.max(index, 0), palette.colors.length - 1);
  return palette.colors[normalizedIndex];
}

function mixPaletteColor(
  paletteMap: PaletteMap,
  leftId: string,
  leftIndex: number,
  rightId: string,
  rightIndex: number,
  ratio: number,
): string | undefined {
  const left = getColor(paletteMap, leftId, leftIndex);
  const right = getColor(paletteMap, rightId, rightIndex);
  if (!left || !right) {
    return undefined;
  }

  return mixHex(left, right, ratio);
}

function mixHex(left: string, right: string, ratio: number): string {
  const leftChannels = hexToRgb(left);
  const rightChannels = hexToRgb(right);
  const clampedRatio = Math.min(1, Math.max(0, ratio));

  return rgbToHex([
    Math.round(leftChannels[0] + (rightChannels[0] - leftChannels[0]) * clampedRatio),
    Math.round(leftChannels[1] + (rightChannels[1] - leftChannels[1]) * clampedRatio),
    Math.round(leftChannels[2] + (rightChannels[2] - leftChannels[2]) * clampedRatio),
  ]);
}

function hexToRgb(value: string): [number, number, number] {
  const normalized = value.replace(/^#/, "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function composeColors(...colors: Array<string | undefined>): string[] {
  return uniqueColors(colors.filter((color): color is string => typeof color === "string"));
}

function uniqueColors(colors: string[]): string[] {
  return uniqueStrings(colors.map((color) => color.toLowerCase()));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function pushIfDefined<T>(values: T[], value: T | undefined): void {
  if (value !== undefined) {
    values.push(value);
  }
}
