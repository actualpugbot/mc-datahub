import * as cheerio from "cheerio";
import { FileCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import type { AppConfig } from "../config.js";
import type { MinecraftNewsPost, NewsPostKind } from "../domain/types.js";

const SNAPSHOT_PATTERN = /\b\d{2}w\d{2}[a-z]\b/gi;
const VERSION_PATTERN = /\b\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?\b/gi;
const ARTICLE_PATH_PATTERN = /\/article\//i;

export function extractVersionIdentifiers(input: string): string[] {
  const matches = new Set<string>();
  for (const pattern of [SNAPSHOT_PATTERN, VERSION_PATTERN]) {
    for (const match of input.matchAll(pattern)) {
      matches.add(match[0]);
    }
  }

  return Array.from(matches).sort();
}

export function classifyNewsPost(title: string): NewsPostKind {
  const normalized = title.toLowerCase();
  if (normalized.includes("snapshot")) {
    return "snapshot";
  }

  VERSION_PATTERN.lastIndex = 0;
  if (
    normalized.includes("pre-release") ||
    normalized.includes("release candidate") ||
    normalized.includes("java edition") ||
    VERSION_PATTERN.test(title)
  ) {
    VERSION_PATTERN.lastIndex = 0;
    return "release";
  }

  VERSION_PATTERN.lastIndex = 0;
  return "other";
}

export function parseArticlesHtml(html: string, baseUrl: string): MinecraftNewsPost[] {
  const $ = cheerio.load(html);
  const posts = new Map<string, MinecraftNewsPost>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const title = $(element).text().trim().replace(/\s+/g, " ");
    if (!href || !title || !ARTICLE_PATH_PATTERN.test(href)) {
      return;
    }

    const url = new URL(href, baseUrl).toString();
    const kind = classifyNewsPost(title);
    const versionIds = extractVersionIdentifiers(`${title} ${url}`);
    if (kind === "other" || versionIds.length === 0) {
      return;
    }

    posts.set(url, {
      id: url,
      url,
      title,
      kind,
      versionIds,
    });
  });

  return Array.from(posts.values()).sort((left, right) => right.url.localeCompare(left.url));
}

export class MinecraftNewsWatcher {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: FileCache,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async scan(): Promise<MinecraftNewsPost[]> {
    this.logger.debug(`Scanning ${this.config.urls.minecraftArticles} for new articles.`);

    const html = await this.cache.remember("minecraft-articles-page", 10 * 60 * 1000, async () =>
      this.http.getText(this.config.urls.minecraftArticles),
    );

    return parseArticlesHtml(html, this.config.urls.minecraftArticles);
  }
}
