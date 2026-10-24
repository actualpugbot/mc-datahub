import { describe, expect, test } from "vitest";
import { classifyNewsPost, extractVersionIdentifiers, parseArticlesHtml } from "../src/watcher/newsWatcher.js";

describe("news watcher parsing", () => {
  test("extracts version ids from release and snapshot titles", () => {
    expect(extractVersionIdentifiers("Minecraft 1.21.5 Release Candidate 1")).toEqual(["1.21.5-rc1"]);
    expect(extractVersionIdentifiers("Minecraft Snapshot 25w15a")).toEqual(["25w15a"]);
    expect(extractVersionIdentifiers("Minecraft 26.4 Snapshot 4")).toEqual(["26.4-snapshot-4"]);
    expect(extractVersionIdentifiers("Minecraft 26.3 Pre-Release 3")).toEqual(["26.3-pre-3"]);
    expect(extractVersionIdentifiers("Minecraft 26.3-rc-1")).toEqual(["26.3-rc-1"]);
  });

  test("classifies release and snapshot articles", () => {
    expect(classifyNewsPost("Minecraft Snapshot 25w15a")).toBe("snapshot");
    expect(classifyNewsPost("Minecraft 1.21.5 Release Candidate 1")).toBe("snapshot");
    expect(classifyNewsPost("Minecraft 26.3-pre-3")).toBe("snapshot");
  });

  test("parses article links and filters unrelated posts", () => {
    const html = `
      <html>
        <body>
          <a href="/en-us/article/minecraft-snapshot-25w15a">Minecraft Snapshot 25w15a</a>
          <a href="/en-us/article/minecraft-java-edition-1-21-5">Minecraft Java Edition 1.21.5</a>
          <a href="/en-us/article/merch-drop">Merch Drop</a>
        </body>
      </html>
    `;

    const posts = parseArticlesHtml(html, "https://www.minecraft.net/en-us/articles");
    expect(posts).toHaveLength(2);
    expect(posts.map((post) => post.versionIds[0])).toEqual(["25w15a", "1.21.5"]);
  });
});
