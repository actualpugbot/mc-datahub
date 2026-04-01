import { describe, expect, test } from "vitest";
import { classifyNewsPost, extractVersionIdentifiers, parseArticlesHtml } from "../src/watcher/newsWatcher.js";

describe("news watcher parsing", () => {
  test("extracts version ids from release and snapshot titles", () => {
    expect(extractVersionIdentifiers("Minecraft 1.21.5 Release Candidate 1")).toEqual(["1.21.5"]);
    expect(extractVersionIdentifiers("Minecraft Snapshot 25w15a")).toEqual(["25w15a"]);
  });

  test("classifies release and snapshot articles", () => {
    expect(classifyNewsPost("Minecraft Snapshot 25w15a")).toBe("snapshot");
    expect(classifyNewsPost("Minecraft 1.21.5 Release Candidate 1")).toBe("release");
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
