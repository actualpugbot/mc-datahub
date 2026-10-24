import { describe, expect, test } from "vitest";
import { classifyVersion } from "../src/versions/classifyVersion.js";

describe("classify version", () => {
  test.each([
    ["26.3", "release", "release", "release"],
    ["1.21.5", "release", "release", "release"],
    ["26.4-snapshot-4", "snapshot", "snapshot", "snapshot"],
    ["26w14a", "snapshot", "snapshot", "snapshot"],
    ["25w15a", "snapshot", "snapshot", "snapshot"],
    ["26.3-pre-3", "snapshot", "snapshot", "pre-release"],
    ["1.21.5-pre1", "snapshot", "snapshot", "pre-release"],
    ["26.3-rc-1", "snapshot", "snapshot", "release-candidate"],
    ["1.21.5-rc1", "snapshot", "snapshot", "release-candidate"],
    ["26.4-experimental-1", undefined, "snapshot", "snapshot"],
  ] as const)("classifies %s", (id, type, channel, stage) => {
    expect(classifyVersion(id, type)).toEqual({ channel, stage });
  });
});
