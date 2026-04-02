import { describe, expect, test, vi } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { FetchLatestWorkflow } from "../src/orchestrators/fetchLatest.js";

describe("fetch latest workflow", () => {
  test("resolves and processes the latest release and snapshot from the manifest", async () => {
    const stateStore = {
      hasProcessedNewsPost: vi.fn(async () => false),
      markNewsPostProcessed: vi.fn(async () => undefined),
    };

    const workflow = new FetchLatestWorkflow(
      {
        scan: vi.fn(async () => [
          {
            id: "snapshot-post",
            url: "https://example.test/snapshot",
            title: "Minecraft Snapshot 25w14a",
            kind: "snapshot",
            versionIds: ["25w14a"],
          },
        ]),
      } as never,
      {
        resolve: vi.fn(async (versionOrAlias: string) => ({
          manifestEntry:
            versionOrAlias === "latest-release"
              ? {
                  id: "1.21.6",
                  type: "release",
                  url: "https://example.test/release.json",
                  time: "2026-04-02T00:00:00.000Z",
                  releaseTime: "2026-04-02T00:00:00.000Z",
                }
              : {
                  id: "25w14a",
                  type: "snapshot",
                  url: "https://example.test/snapshot.json",
                  time: "2026-04-02T00:00:00.000Z",
                  releaseTime: "2026-04-02T00:00:00.000Z",
                },
          metadata: {
            id: versionOrAlias,
            type: versionOrAlias === "latest-release" ? "release" : "snapshot",
            releaseTime: "2026-04-02T00:00:00.000Z",
            time: "2026-04-02T00:00:00.000Z",
            downloads: {},
          },
        })),
      } as never,
      {
        run: vi.fn(async (version: string) => ({
          version,
          skipped: false,
        })),
      } as never,
      stateStore as never,
      createConsoleLogger(false),
    );

    const result = await workflow.run({
      kind: "any",
      limit: 2,
      process: true,
      mappingProvider: "mojang",
      skipDecompile: true,
      force: false,
    });

    expect(result.latest).toEqual([
      {
        alias: "latest-release",
        kind: "release",
        versionId: "1.21.6",
        articleIds: [],
      },
      {
        alias: "latest-snapshot",
        kind: "snapshot",
        versionId: "25w14a",
        articleIds: ["snapshot-post"],
      },
    ]);
    expect(result.processed).toEqual([
      {
        version: "1.21.6",
        skipped: false,
      },
      {
        version: "25w14a",
        skipped: false,
      },
    ]);
    expect(result.posts.map((post) => post.id)).toEqual(["snapshot-post"]);
    expect(stateStore.markNewsPostProcessed).toHaveBeenCalledTimes(1);
  });

  test("dedupes identical latest aliases before processing", async () => {
    const processVersion = {
      run: vi.fn(async (version: string) => ({
        version,
        skipped: false,
      })),
    };

    const workflow = new FetchLatestWorkflow(
      {
        scan: vi.fn(async () => []),
      } as never,
      {
        resolve: vi.fn(async () => ({
          manifestEntry: {
            id: "1.21.6",
            type: "release",
            url: "https://example.test/release.json",
            time: "2026-04-02T00:00:00.000Z",
            releaseTime: "2026-04-02T00:00:00.000Z",
          },
          metadata: {
            id: "1.21.6",
            type: "release",
            releaseTime: "2026-04-02T00:00:00.000Z",
            time: "2026-04-02T00:00:00.000Z",
            downloads: {},
          },
        })),
      } as never,
      processVersion as never,
      {
        hasProcessedNewsPost: vi.fn(async () => false),
        markNewsPostProcessed: vi.fn(async () => undefined),
      } as never,
      createConsoleLogger(false),
    );

    const result = await workflow.run({
      kind: "any",
      limit: 2,
      process: true,
      mappingProvider: "mojang",
      skipDecompile: true,
      force: false,
    });

    expect(result.latest).toHaveLength(1);
    expect(processVersion.run).toHaveBeenCalledTimes(1);
    expect(processVersion.run).toHaveBeenCalledWith("1.21.6", {
      mappingProvider: "mojang",
      skipDecompile: true,
      force: false,
    });
  });
});
