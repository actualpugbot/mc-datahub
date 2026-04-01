import type { JsonValue } from "../domain/types.js";

export function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }

  return value;
}

export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value as JsonValue), null, 2)}\n`;
}
