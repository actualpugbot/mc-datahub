import type { VersionManifestEntry } from "../domain/types.js";

export type VersionChannel = "release" | "snapshot";
export type VersionStage = "release" | "snapshot" | "pre-release" | "release-candidate";

/** Mojang labels all previews as snapshots, so derive their display stage from the ID. */
export function classifyVersion(
  id: string,
  type?: VersionManifestEntry["type"],
): {
  channel: VersionChannel;
  stage: VersionStage;
} {
  const normalized = id.toLowerCase();
  if (/(?:^|-)rc-?\d+$/.test(normalized)) {
    return { channel: "snapshot", stage: "release-candidate" };
  }
  if (/(?:^|-)pre-?\d+$/.test(normalized)) {
    return { channel: "snapshot", stage: "pre-release" };
  }
  if (/(?:^|-)snapshot-?\d+$/.test(normalized) || /^\d{2}w\d{2}[a-z]$/.test(normalized)) {
    return { channel: "snapshot", stage: "snapshot" };
  }
  if (type === "snapshot" || (type !== "release" && !/^\d+(?:\.\d+)+$/.test(normalized))) {
    return { channel: "snapshot", stage: "snapshot" };
  }
  return { channel: "release", stage: "release" };
}
