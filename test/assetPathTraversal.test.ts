import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApiServer, type ApiServer } from "../src/api/server.js";
import { createWorkspacePaths } from "../src/core/paths.js";
import { createConsoleLogger } from "../src/core/logger.js";
import { DatasetStore } from "../src/datasets/datasetStore.js";
import { DiffEngine } from "../src/diff/diffEngine.js";
import type { AppConfig } from "../src/config.js";

/**
 * The `version` path segment is joined onto the workspace root, so an unvalidated `..` in it used to
 * relocate the dataset directory and take the containment check along with it.
 */
describe("asset route path containment", () => {
  let root: string;
  let server: ApiServer;
  let origin: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcdh-assets-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "datasets", "26.2", "images"), { recursive: true });
    await writeFile(join(workspaceRoot, "datasets", "26.2", "images", "stone.txt"), "a real asset", "utf8");
    await mkdir(join(workspaceRoot, "datasets", "26.3"), { recursive: true });
    await writeFile(join(workspaceRoot, "datasets", "26.3", "sibling.txt"), "SIBLING-VERSION-FILE", "utf8");
    // Outside workspace/datasets entirely: nothing the asset route may ever return.
    await writeFile(join(root, "secret.txt"), "TOP-SECRET-CONTENTS", "utf8");
    await writeFile(join(workspaceRoot, "state.json"), "{}", "utf8");

    const config = {
      projectRoot: root,
      workspace: createWorkspacePaths(workspaceRoot),
      urls: {},
      api: { host: "127.0.0.1", port: 0 },
      toolchain: {},
    } as unknown as AppConfig;

    const logger = createConsoleLogger(false);
    server = buildApiServer(config, new DatasetStore(config.workspace, logger), new DiffEngine());
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.raw.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  test("serves an asset inside the dataset directory", async () => {
    const response = await fetch(`${origin}/versions/26.2/assets/images/stone.txt`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("a real asset");
  });

  /**
   * Only percent-encoded separators survive to the handler — WHATWG `URL` resolves a literal `..`
   * segment away before routing, so `/versions/../assets/x` never reaches `serveAsset` at all. These
   * are the shapes that actually carried the exploit.
   */
  test.each([
    ["..%2F..", "escapes two levels via the version segment"],
    ["%2E%2E%2F%2E%2E", "escapes with the dots encoded too"],
    ["..%2F..%2F..%2F..%2F..%2F..%2F..", "escapes past the filesystem root"],
    ["..%5C..", "escapes with backslash separators"],
    ["..%2F", "escapes one level"],
  ])("rejects a version segment that %s", async (version) => {
    const response = await fetch(`${origin}/versions/${version}/assets/secret.txt`);
    const body = await response.text();
    expect(body).not.toContain("TOP-SECRET-CONTENTS");
    expect(response.status).toBe(400);
  });

  test("rejects a traversal in the asset path segments", async () => {
    const response = await fetch(`${origin}/versions/26.2/assets/${encodeURIComponent("../../../secret.txt")}`);
    const body = await response.text();
    expect(body).not.toContain("TOP-SECRET-CONTENTS");
    expect(response.status).toBe(403);
  });

  test("does not serve assets across sibling versions", async () => {
    // Reachable at its own route, but not from another version's asset path: the containment check is
    // anchored per-version, so this must not resolve.
    const response = await fetch(`${origin}/versions/26.2/assets/${encodeURIComponent("../26.3/sibling.txt")}`);
    const body = await response.text();
    expect(body).not.toContain("SIBLING-VERSION-FILE");
    expect(response.status).toBe(403);
  });

  test("rejects an unsafe version on the dataset and diff routes too", async () => {
    for (const path of [`/versions/${encodeURIComponent("../..")}`, `/versions/26.2/diff/${encodeURIComponent("../..")}`]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Invalid version id") });
    }
  });
});
