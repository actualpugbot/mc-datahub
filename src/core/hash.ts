import { createHash } from "node:crypto";
import { toPrettyJson } from "./json.js";

export function sha1Buffer(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

export function sha1String(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function stableJsonHash(value: unknown): string {
  return sha1String(toPrettyJson(value));
}
