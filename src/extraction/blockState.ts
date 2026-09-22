const BLOCK_ID_PATTERN = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/;

/**
 * Normalize one serialized block state to the `id[prop=value,...]` string used
 * throughout the structure dataset (properties sorted, none -> bare id).
 *
 * Accepts the legacy compound (`{Name, Properties}`), the modern compound
 * (`{id, properties}`) and a bare block-id string. Anything else throws: a
 * state we cannot read must never quietly become air. A compound carrying both
 * schemas is accepted only when the two agree.
 */
export function normalizeBlockState(entry: unknown): string {
  if (typeof entry === "string") {
    return readBlockId(entry);
  }
  if (!isRecord(entry)) {
    throw new Error(`expected a block id string or compound but found ${describe(entry)}`);
  }

  const id = readBothSchemas(entry, "id", "Name", readBlockId);
  if (id === undefined) {
    throw new Error("block state has no `id` (or legacy `Name`)");
  }

  const properties = readBothSchemas(entry, "properties", "Properties", readProperties);
  return properties && properties.length > 0 ? `${id}[${properties}]` : id;
}

function readBothSchemas(
  entry: Record<string, unknown>,
  modernKey: string,
  legacyKey: string,
  parse: (value: unknown, key: string) => string | undefined,
): string | undefined {
  const modern = entry[modernKey] === undefined ? undefined : parse(entry[modernKey], modernKey);
  const legacy = entry[legacyKey] === undefined ? undefined : parse(entry[legacyKey], legacyKey);
  if (modern !== undefined && legacy !== undefined && modern !== legacy) {
    throw new Error(`\`${modernKey}\` (${modern}) conflicts with \`${legacyKey}\` (${legacy})`);
  }

  return modern ?? legacy;
}

function readBlockId(value: unknown, key = "block id"): string {
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` must be a string but found ${describe(value)}`);
  }
  if (!BLOCK_ID_PATTERN.test(value)) {
    throw new Error(`\`${key}\` is not a valid block id: ${JSON.stringify(value)}`);
  }

  return value.includes(":") ? value : `minecraft:${value}`;
}

function readProperties(value: unknown, key: string): string {
  if (!isRecord(value)) {
    throw new Error(`\`${key}\` must be a compound but found ${describe(value)}`);
  }

  return Object.entries(value)
    .map(([property, propertyValue]): [string, string] => {
      if (typeof propertyValue !== "string" || propertyValue === "" || property === "") {
        throw new Error(`\`${key}.${property}\` must be a non-empty string but found ${describe(propertyValue)}`);
      }
      return [property, propertyValue];
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, propertyValue]) => `${property}=${propertyValue}`)
    .join(",");
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }

  return typeof value === "object" ? "a compound" : typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
