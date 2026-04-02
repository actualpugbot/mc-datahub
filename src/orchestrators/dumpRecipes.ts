import type { RecipeDefinition, VersionDataset } from "../domain/types.js";

export interface RecipeDumpPayload {
  version: string;
  recipes: RecipeDefinition[];
  source: "dataset" | "archives";
}

export interface RecipeDumpLoader {
  loadDataset(version: string): Promise<VersionDataset>;
  extractDataset(version: string): Promise<VersionDataset>;
}

export async function buildRecipeDumpPayload(
  version: string,
  loader: RecipeDumpLoader,
): Promise<RecipeDumpPayload> {
  try {
    const dataset = await loader.loadDataset(version);
    return {
      version: dataset.version,
      recipes: dataset.recipes,
      source: "dataset",
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const dataset = await loader.extractDataset(version);
  return {
    version: dataset.version,
    recipes: dataset.recipes,
    source: "archives",
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
