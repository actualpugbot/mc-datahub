import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { ensureDir, fileExists } from "./fs.js";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";

export interface DownloadFileResult {
  path: string;
  downloaded: boolean;
  bytes: number;
  sha1: string;
}

export interface HttpClient {
  getText(url: string): Promise<string>;
  getJson<T>(url: string): Promise<T>;
  downloadFile(url: string, outputPath: string, options?: { expectedSha1?: string }): Promise<DownloadFileResult>;
}

export class FetchHttpClient implements HttpClient {
  constructor(private readonly logger: Logger) {}

  async getText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "user-agent": "mc-datahub/0.1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}`);
    }

    return response.text();
  }

  async getJson<T>(url: string): Promise<T> {
    const text = await this.getText(url);
    return JSON.parse(text) as T;
  }

  async downloadFile(url: string, outputPath: string, options?: { expectedSha1?: string }): Promise<DownloadFileResult> {
    if (options?.expectedSha1 && (await fileExists(outputPath))) {
      const existing = await fs.readFile(outputPath);
      const existingSha1 = createHash("sha1").update(existing).digest("hex");
      if (existingSha1 === options.expectedSha1) {
        this.logger.debug(`Skipping download for ${outputPath}; sha1 already matches.`);
        return {
          path: outputPath,
          downloaded: false,
          bytes: existing.length,
          sha1: existingSha1,
        };
      }
    }

    const response = await fetch(url, {
      headers: {
        "user-agent": "mc-datahub/0.1.0",
      },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download ${url} failed with ${response.status}`);
    }

    await ensureDir(dirname(outputPath));

    const hash = createHash("sha1");
    let byteLength = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      hash.update(buffer);
      chunks.push(buffer);
    }

    await fs.writeFile(outputPath, Buffer.concat(chunks));
    return {
      path: outputPath,
      downloaded: true,
      bytes: byteLength,
      sha1: hash.digest("hex"),
    };
  }
}
