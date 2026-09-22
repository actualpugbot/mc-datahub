import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { buildStructureData } from "../src/extraction/structures.js";
import { normalizeBlockState } from "../src/extraction/blockState.js";
import { decodeNbt } from "../src/extraction/nbt.js";

const TAG_INT = 3;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;

function nbtString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
}

function tagHeader(type: number, name: string): Buffer {
  return Buffer.concat([Buffer.from([type]), nbtString(name)]);
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function compoundPayload(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.from([0])]);
}

function namedString(name: string, value: string): Buffer {
  return Buffer.concat([tagHeader(TAG_STRING, name), nbtString(value)]);
}

function namedInt(name: string, value: number): Buffer {
  return Buffer.concat([tagHeader(TAG_INT, name), int32(value)]);
}

function namedCompound(name: string, entries: Buffer[]): Buffer {
  return Buffer.concat([tagHeader(TAG_COMPOUND, name), compoundPayload(entries)]);
}

function namedList(name: string, elementType: number, payloads: Buffer[]): Buffer {
  return Buffer.concat([tagHeader(TAG_LIST, name), Buffer.from([elementType]), int32(payloads.length), ...payloads]);
}

function intListPayloads(values: number[]): Buffer[] {
  return values.map((value) => int32(value));
}

function paletteEntry(blockId: string, properties?: Record<string, string>): Buffer {
  const entries = [namedString("Name", blockId)];
  if (properties) {
    entries.push(
      namedCompound(
        "Properties",
        Object.entries(properties).map(([property, value]) => namedString(property, value)),
      ),
    );
  }
  return compoundPayload(entries);
}

function templateNbt(): Buffer {
  const blocks = [
    compoundPayload([namedList("pos", TAG_INT, intListPayloads([0, 0, 0])), namedInt("state", 1)]),
    compoundPayload([namedList("pos", TAG_INT, intListPayloads([1, 0, 0])), namedInt("state", 3)]),
    // Air is dropped from the block runs.
    compoundPayload([namedList("pos", TAG_INT, intListPayloads([0, 1, 0])), namedInt("state", 2)]),
    // The jigsaw connector is lifted into `jigsaws`.
    compoundPayload([
      namedList("pos", TAG_INT, intListPayloads([1, 1, 0])),
      namedInt("state", 0),
      namedCompound("nbt", [
        namedString("name", "minecraft:bottom"),
        namedString("pool", "village/plains/houses"),
        namedString("target", "minecraft:building_entrance"),
        namedString("final_state", "minecraft:oak_planks"),
        namedString("joint", "aligned"),
        namedInt("selection_priority", 7),
      ]),
    ]),
  ];

  const root = Buffer.concat([
    Buffer.from([TAG_COMPOUND]),
    nbtString(""),
    compoundPayload([
      namedList("size", TAG_INT, intListPayloads([2, 2, 1])),
      namedList("palette", TAG_COMPOUND, [
        paletteEntry("minecraft:jigsaw", { orientation: "south_up" }),
        paletteEntry("minecraft:oak_planks"),
        paletteEntry("minecraft:air"),
        paletteEntry("minecraft:oak_stairs", { half: "bottom", facing: "east" }),
      ]),
      namedList("blocks", TAG_COMPOUND, blocks),
      namedList("entities", 0, []),
      namedInt("DataVersion", 4325),
    ]),
  ]);

  return gzipSync(root);
}

describe("structure extraction", () => {
  test("decodes gzipped template NBT to plain values", () => {
    const root = decodeNbt(templateNbt());
    expect(root.size).toEqual([2, 2, 1]);
    expect(root.DataVersion).toBe(4325);
    expect(Array.isArray(root.palette)).toBe(true);
  });

  test("builds structures, pools, processors, and templates", async () => {
    const source = new InMemoryArchiveSource({
      "data/minecraft/worldgen/structure/village_plains.json": JSON.stringify({
        type: "minecraft:jigsaw",
        biomes: "#minecraft:has_structure/village_plains",
        step: "surface_structures",
        start_pool: "village/plains/town_centers",
        size: 6,
        start_height: { absolute: 0 },
        project_start_to_heightmap: "WORLD_SURFACE_WG",
        use_expansion_hack: true,
      }),
      "data/minecraft/worldgen/structure/desert_pyramid.json": JSON.stringify({
        type: "minecraft:desert_pyramid",
        biomes: ["minecraft:desert"],
        step: "surface_structures",
      }),
      "data/minecraft/worldgen/template_pool/village/plains/houses.json": JSON.stringify({
        fallback: "minecraft:village/plains/terminators",
        elements: [
          {
            weight: 3,
            element: {
              element_type: "minecraft:legacy_single_pool_element",
              location: "minecraft:village/plains/houses/plains_small_house_1",
              processors: "minecraft:mossify_10_percent",
              projection: "rigid",
            },
          },
          {
            weight: 1,
            element: {
              element_type: "minecraft:single_pool_element",
              location: "minecraft:village/plains/houses/plains_small_house_2",
              processors: { processors: [{ processor_type: "minecraft:nop" }] },
              projection: "rigid",
            },
          },
          { weight: 2, element: { element_type: "minecraft:empty_pool_element" } },
        ],
      }),
      "data/minecraft/worldgen/processor_list/mossify_10_percent.json": JSON.stringify({
        processors: [{ processor_type: "minecraft:rule", rules: [] }],
      }),
      "data/minecraft/structure/village/plains/houses/plains_small_house_1.nbt": templateNbt(),
    });

    const bundle = await buildStructureData(await source.listPaths(), source);

    expect(bundle.structures.map((structure) => structure.key)).toEqual(["desert_pyramid", "village_plains"]);
    const village = bundle.structures.find((structure) => structure.key === "village_plains");
    expect(village).toMatchObject({
      id: "minecraft:village_plains",
      type: "minecraft:jigsaw",
      jigsaw: {
        startPool: "minecraft:village/plains/town_centers",
        size: 6,
        maxDistanceFromCenter: 80,
        useExpansionHack: true,
        projectStartToHeightmap: "WORLD_SURFACE_WG",
      },
    });
    expect(bundle.structures.find((structure) => structure.key === "desert_pyramid")?.jigsaw).toBeUndefined();

    expect(bundle.templatePools).toHaveLength(1);
    const pool = bundle.templatePools[0];
    expect(pool).toMatchObject({
      id: "minecraft:village/plains/houses",
      fallback: "minecraft:village/plains/terminators",
    });
    expect(pool?.elements).toHaveLength(3);
    expect(pool?.elements[0]).toMatchObject({
      weight: 3,
      elementType: "minecraft:legacy_single_pool_element",
      location: "minecraft:village/plains/houses/plains_small_house_1",
      processors: "minecraft:mossify_10_percent",
      projection: "rigid",
    });
    expect(pool?.elements[1]?.processorsInline).toEqual({ processors: [{ processor_type: "minecraft:nop" }] });
    expect(pool?.elements[2]).toMatchObject({ weight: 2, elementType: "minecraft:empty_pool_element" });

    expect(bundle.processorLists).toEqual([
      {
        id: "minecraft:mossify_10_percent",
        key: "mossify_10_percent",
        processors: [{ processor_type: "minecraft:rule", rules: [] }],
        sourcePath: "data/minecraft/worldgen/processor_list/mossify_10_percent.json",
      },
    ]);

    expect(bundle.structureTemplates).toHaveLength(1);
    const template = bundle.structureTemplates[0];
    expect(template).toMatchObject({
      id: "minecraft:village/plains/houses/plains_small_house_1",
      key: "village/plains/houses/plains_small_house_1",
      size: [2, 2, 1],
      entityCount: 0,
    });
    // Properties are sorted inside the blockstate string.
    expect(template?.palettes).toEqual([
      [
        "minecraft:jigsaw[orientation=south_up]",
        "minecraft:oak_planks",
        "minecraft:air",
        "minecraft:oak_stairs[facing=east,half=bottom]",
      ],
    ]);
    // Air and the jigsaw block are omitted from the block runs.
    expect(template?.blocks).toEqual([0, 0, 0, 1, 1, 0, 0, 3]);
    expect(template?.jigsaws).toEqual([
      {
        pos: [1, 1, 0],
        orientation: "south_up",
        name: "minecraft:bottom",
        pool: "minecraft:village/plains/houses",
        target: "minecraft:building_entrance",
        finalState: "minecraft:oak_planks",
        jointType: "aligned",
        placementPriority: 0,
        selectionPriority: 7,
      },
    ]);
  });
});

// Minecraft 26.3 writes template palettes as `{id, properties}`; older packs use
// `{Name, Properties}` and datapacks may use bare block-id strings.
function modernEntry(blockId: string, properties?: Record<string, string>): Buffer {
  const entries = [namedString("id", blockId)];
  if (properties) {
    entries.push(
      namedCompound(
        "properties",
        Object.entries(properties).map(([property, value]) => namedString(property, value)),
      ),
    );
  }
  return compoundPayload(entries);
}

function listPayload(elementType: number, payloads: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([elementType]), int32(payloads.length), ...payloads]);
}

function blockAt(pos: [number, number, number], state: number, extra: Buffer[] = []): Buffer {
  return compoundPayload([namedList("pos", TAG_INT, intListPayloads(pos)), namedInt("state", state), ...extra]);
}

function templateWith(paletteTags: Buffer[], blocks: Buffer[]): Buffer {
  return gzipSync(
    Buffer.concat([
      Buffer.from([TAG_COMPOUND]),
      nbtString(""),
      compoundPayload([
        namedList("size", TAG_INT, intListPayloads([3, 2, 1])),
        ...paletteTags,
        namedList("blocks", TAG_COMPOUND, blocks),
        namedList("entities", 0, []),
        namedInt("DataVersion", 5023),
      ]),
    ]),
  );
}

async function extractTemplates(files: Record<string, Buffer>) {
  const source = new InMemoryArchiveSource(files);
  return buildStructureData(await source.listPaths(), source);
}

const TEMPLATE_PATH = "data/minecraft/structure/test/room.nbt";

describe("block state palette formats", () => {
  test("normalizes legacy, modern and string states to the same internal form", () => {
    expect(normalizeBlockState({ Name: "minecraft:stone" })).toBe("minecraft:stone");
    expect(normalizeBlockState({ Name: "minecraft:oak_stairs", Properties: { half: "bottom", facing: "east" } })).toBe(
      "minecraft:oak_stairs[facing=east,half=bottom]",
    );
    expect(normalizeBlockState({ id: "minecraft:stone" })).toBe("minecraft:stone");
    expect(normalizeBlockState({ id: "minecraft:oak_stairs", properties: { half: "bottom", facing: "east" } })).toBe(
      "minecraft:oak_stairs[facing=east,half=bottom]",
    );
    expect(normalizeBlockState("minecraft:stone")).toBe("minecraft:stone");
    expect(normalizeBlockState("stone")).toBe("minecraft:stone");
    expect(normalizeBlockState({ id: "stone" })).toBe("minecraft:stone");
  });

  test("keeps explicit air and drops empty property containers", () => {
    expect(normalizeBlockState({ id: "minecraft:air" })).toBe("minecraft:air");
    expect(normalizeBlockState("minecraft:air")).toBe("minecraft:air");
    expect(normalizeBlockState({ id: "minecraft:stone", properties: {} })).toBe("minecraft:stone");
  });

  test("accepts a compound carrying both schemas only when they agree", () => {
    expect(
      normalizeBlockState({
        id: "minecraft:lever",
        Name: "lever",
        properties: { powered: "true" },
        Properties: { powered: "true" },
      }),
    ).toBe("minecraft:lever[powered=true]");
    expect(() => normalizeBlockState({ id: "minecraft:stone", Name: "minecraft:dirt" })).toThrow(/conflicts/);
    expect(() =>
      normalizeBlockState({ id: "minecraft:lever", properties: { powered: "true" }, Properties: { powered: "false" } }),
    ).toThrow(/conflicts/);
  });

  test("rejects states it cannot read instead of turning them into air", () => {
    for (const bad of [
      undefined,
      null,
      42,
      ["minecraft:stone"],
      {},
      { properties: { facing: "east" } },
      { id: 7 },
      { id: "" },
      { id: "Minecraft:Stone" },
      { id: "minecraft:stone[facing=east]" },
      { id: "minecraft:stone", properties: "facing=east" },
      { id: "minecraft:stone", properties: ["facing"] },
      { id: "minecraft:stone", properties: { facing: 3 } },
      { id: "minecraft:stone", properties: { facing: "" } },
      "",
      "stone[facing=east]",
    ]) {
      expect(() => normalizeBlockState(bad), JSON.stringify(bad)).toThrow();
    }
  });

  test("extracts a modern {id, properties} template with blocks and a jigsaw connector", async () => {
    const template = templateWith(
      [
        namedList("palette", TAG_COMPOUND, [
          modernEntry("minecraft:jigsaw", { orientation: "up_north" }),
          modernEntry("minecraft:stone"),
          modernEntry("minecraft:oak_stairs", { half: "bottom", facing: "east" }),
          modernEntry("minecraft:air"),
        ]),
      ],
      [
        blockAt([0, 0, 0], 1),
        blockAt([1, 0, 0], 2),
        blockAt([2, 0, 0], 3),
        blockAt([0, 1, 0], 0, [
          namedCompound("nbt", [
            namedString("id", "minecraft:jigsaw"),
            namedString("name", "village/plains/street"),
            namedString("pool", "village/plains/houses"),
            namedString("target", "minecraft:building_entrance"),
            namedString("final_state", "minecraft:dirt_path"),
            namedString("joint", "aligned"),
            namedInt("placement_priority", 3),
            namedInt("selection_priority", 5),
          ]),
        ]),
      ],
    );

    const bundle = await extractTemplates({ [TEMPLATE_PATH]: template });
    const [result] = bundle.structureTemplates;

    expect(result?.palettes).toEqual([
      [
        "minecraft:jigsaw[orientation=up_north]",
        "minecraft:stone",
        "minecraft:oak_stairs[facing=east,half=bottom]",
        "minecraft:air",
      ],
    ]);
    // Air and the jigsaw are not ordinary blocks; the solid ones survive.
    expect(result?.blocks).toEqual([0, 0, 0, 1, 1, 0, 0, 2]);
    expect(result?.jigsaws).toEqual([
      {
        pos: [0, 1, 0],
        orientation: "up_north",
        name: "minecraft:village/plains/street",
        pool: "minecraft:village/plains/houses",
        target: "minecraft:building_entrance",
        finalState: "minecraft:dirt_path",
        jointType: "aligned",
        placementPriority: 3,
        selectionPriority: 5,
      },
    ]);
  });

  test("extracts compact block-id string palettes", async () => {
    const template = templateWith(
      [namedList("palette", TAG_STRING, [nbtString("minecraft:jigsaw"), nbtString("stone"), nbtString("minecraft:air")])],
      [
        blockAt([0, 0, 0], 1),
        blockAt([1, 0, 0], 2),
        blockAt([2, 0, 0], 0, [
          namedCompound("nbt", [namedString("name", "minecraft:top"), namedString("pool", "minecraft:empty")]),
        ]),
      ],
    );

    const [result] = (await extractTemplates({ [TEMPLATE_PATH]: template })).structureTemplates;

    expect(result?.palettes).toEqual([["minecraft:jigsaw", "minecraft:stone", "minecraft:air"]]);
    expect(result?.blocks).toEqual([0, 0, 0, 1]);
    expect(result?.jigsaws).toHaveLength(1);
    expect(result?.jigsaws[0]?.orientation).toBe("north_up");
  });

  test("keeps every alternative palette in order, whatever schema it uses", async () => {
    const template = templateWith(
      [
        namedList("palettes", TAG_LIST, [
          listPayload(TAG_COMPOUND, [
            modernEntry("minecraft:spruce_planks"),
            modernEntry("minecraft:oak_stairs", { half: "top", facing: "north" }),
          ]),
          listPayload(TAG_COMPOUND, [
            paletteEntry("minecraft:birch_planks"),
            paletteEntry("minecraft:oak_stairs", { half: "top", facing: "north" }),
          ]),
          listPayload(TAG_STRING, [nbtString("minecraft:acacia_planks"), nbtString("minecraft:air")]),
        ]),
      ],
      [blockAt([0, 0, 0], 0), blockAt([1, 0, 0], 1)],
    );

    const [result] = (await extractTemplates({ [TEMPLATE_PATH]: template })).structureTemplates;

    // Property sorting must not reorder or deduplicate the palettes themselves.
    expect(result?.palettes).toEqual([
      ["minecraft:spruce_planks", "minecraft:oak_stairs[facing=north,half=top]"],
      ["minecraft:birch_planks", "minecraft:oak_stairs[facing=north,half=top]"],
      ["minecraft:acacia_planks", "minecraft:air"],
    ]);
    expect(result?.blocks).toEqual([0, 0, 0, 0, 1, 0, 0, 1]);
  });

  test("rejects a block index that an alternative palette cannot resolve", async () => {
    const template = templateWith(
      [
        namedList("palettes", TAG_LIST, [
          listPayload(TAG_COMPOUND, [modernEntry("minecraft:stone"), modernEntry("minecraft:dirt")]),
          listPayload(TAG_COMPOUND, [modernEntry("minecraft:stone")]),
        ]),
      ],
      [blockAt([0, 0, 0], 1)],
    );

    await expect(extractTemplates({ [TEMPLATE_PATH]: template })).rejects.toThrow(/test\/room.*state index 1.*palette 1/);
  });

  test.each([
    ["a missing id", compoundPayload([namedCompound("properties", [namedString("facing", "east")])])],
    ["a non-string id", compoundPayload([namedInt("id", 7)])],
    ["an empty id", modernEntry("")],
    [
      "a properties value that is not a compound",
      compoundPayload([namedString("id", "minecraft:stone"), namedString("properties", "facing=east")]),
    ],
    [
      "a property value that is not a string",
      compoundPayload([namedString("id", "minecraft:stone"), namedCompound("properties", [namedInt("facing", 3)])]),
    ],
    ["conflicting id fields", compoundPayload([namedString("id", "minecraft:stone"), namedString("Name", "minecraft:dirt")])],
  ])("names the template and palette entry when a palette has %s", async (_label, badEntry) => {
    const template = templateWith(
      [namedList("palette", TAG_COMPOUND, [modernEntry("minecraft:stone"), badEntry])],
      [blockAt([0, 0, 0], 0)],
    );

    await expect(extractTemplates({ [TEMPLATE_PATH]: template })).rejects.toThrow(/test\/room\.nbt.*palette 0.*entry 1/);
  });

  test("accepts explicit air in a palette", async () => {
    const template = templateWith(
      [namedList("palette", TAG_COMPOUND, [modernEntry("minecraft:air"), modernEntry("minecraft:stone")])],
      [blockAt([0, 0, 0], 0), blockAt([1, 0, 0], 1)],
    );

    const [result] = (await extractTemplates({ [TEMPLATE_PATH]: template })).structureTemplates;
    expect(result?.blocks).toEqual([1, 0, 0, 1]);
  });
});
