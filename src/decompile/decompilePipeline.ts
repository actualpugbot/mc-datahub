import { join } from "node:path";
import { ensureDir, writeJsonFile } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import {
  versionDecompiledDir,
  versionRemappedDir,
  versionRoot,
} from "../core/paths.js";
import type { AppConfig } from "../config.js";
import type { DecompileReport, MappingArtifact, MappingProvider, ToolStepResult, VersionArtifacts } from "../domain/types.js";
import { executeTemplateCommand, type TemplateContext } from "./toolchain.js";

export class DecompilePipeline {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async run(version: string, artifacts: VersionArtifacts, mappings: MappingArtifact[], provider: MappingProvider): Promise<DecompileReport> {
    const report: DecompileReport = {
      version,
      mappingProvider: provider,
      generatedAt: new Date().toISOString(),
      client: await this.runForKind("client", version, artifacts, mappings),
      server: await this.runForKind("server", version, artifacts, mappings),
    };

    await writeJsonFile(join(versionRoot(this.config.workspace, version), "decompile-report.json"), report);
    return report;
  }

  private async runForKind(
    kind: "client" | "server",
    version: string,
    artifacts: VersionArtifacts,
    mappings: MappingArtifact[],
  ): Promise<ToolStepResult> {
    const download = artifacts.downloads[kind];
    if (!download) {
      return {
        status: "skipped",
        reason: `${kind} artifact was not available for ${version}.`,
      };
    }

    const remappedDir = versionRemappedDir(this.config.workspace, version);
    const decompiledDir = join(versionDecompiledDir(this.config.workspace, version), kind);
    await ensureDir(remappedDir);
    await ensureDir(decompiledDir);

    const mappingArtifact = this.selectMapping(kind, mappings);
    let decompileInputPath = download.path;

    if (mappingArtifact) {
      const remappedPath = join(remappedDir, `${kind}.jar`);
      const remapResult = await this.remap(version, kind, download.path, remappedPath, mappingArtifact.path);
      if (remapResult.status === "failed") {
        return remapResult;
      }

      if (remapResult.status === "done" && remapResult.outputPath) {
        decompileInputPath = remapResult.outputPath;
      }
    }

    return this.decompile(version, kind, decompileInputPath, decompiledDir, mappingArtifact?.path ?? "");
  }

  private selectMapping(kind: "client" | "server", mappings: MappingArtifact[]): MappingArtifact | undefined {
    return (
      mappings.find((artifact) => artifact.kind === kind) ??
      mappings.find((artifact) => artifact.kind === "merged")
    );
  }

  private async remap(
    version: string,
    kind: "client" | "server",
    input: string,
    output: string,
    mappings: string,
  ): Promise<ToolStepResult> {
    const template = this.config.toolchain.tinyRemapperCommand;
    if (!template) {
      return {
        status: "skipped",
        inputPath: input,
        reason: "MCDATAHUB_TINY_REMAPPER_CMD is not configured.",
      };
    }

    const context: TemplateContext = {
      input,
      output,
      mappings,
      version,
      kind,
    };
    const result = await executeTemplateCommand(template, context, this.logger);
    if (!result.ok) {
      return {
        status: "failed",
        inputPath: input,
        outputPath: output,
        command: result.command,
        reason: result.stderr || "Tiny Remapper command failed.",
      };
    }

    return {
      status: "done",
      inputPath: input,
      outputPath: output,
      command: result.command,
    };
  }

  private async decompile(
    version: string,
    kind: "client" | "server",
    input: string,
    output: string,
    mappings: string,
  ): Promise<ToolStepResult> {
    const template = this.config.toolchain.vineflowerCommand;
    if (!template) {
      return {
        status: "skipped",
        inputPath: input,
        outputPath: output,
        reason: this.config.toolchain.vineflower.message,
      };
    }

    const context: TemplateContext = {
      input,
      output,
      mappings,
      version,
      kind,
    };
    const result = await executeTemplateCommand(template, context, this.logger);
    if (!result.ok) {
      return {
        status: "failed",
        inputPath: input,
        outputPath: output,
        command: result.command,
        reason: result.stderr || "Vineflower command failed.",
      };
    }

    return {
      status: "done",
      inputPath: input,
      outputPath: output,
      command: result.command,
    };
  }
}
