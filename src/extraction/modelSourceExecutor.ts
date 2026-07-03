import { promises as fs } from "node:fs";
import type { MobModelCubeDefinition, MobModelFaceName, MobModelPartDefinition } from "../domain/types.js";

const FACE_NAMES = ["down", "up", "west", "north", "east", "south"] as const;

/**
 * Bakes the per-face texture rectangles of a box exactly like the vanilla
 * ModelPart.Cube constructor (u/v layout derived from texOffs + dimensions).
 */
export function bakeCubeFaces(
  texU: number,
  texV: number,
  width: number,
  height: number,
  depth: number,
  textureWidth: number,
  textureHeight: number,
): MobModelCubeDefinition["faces"] {
  const u0 = texU;
  const u1 = texU + depth;
  const u2 = texU + depth + width;
  const u22 = texU + depth + width + width;
  const u3 = texU + depth + width + depth;
  const u4 = texU + depth + width + depth + width;
  const v0 = texV;
  const v1 = texV + depth;
  const v2 = texV + depth + height;
  const pixels: Record<MobModelFaceName, [number, number, number, number]> = {
    down: [u1, v0, u2, v1],
    up: [u2, v1, u22, v0],
    west: [u0, v1, u1, v2],
    north: [u1, v1, u2, v2],
    east: [u2, v1, u3, v2],
    south: [u3, v1, u4, v2],
  };

  return Object.fromEntries(
    FACE_NAMES.map((face) => {
      const uv = pixels[face];
      return [
        face,
        {
          uv,
          normalizedUv: [uv[0] / textureWidth, uv[1] / textureHeight, uv[2] / textureWidth, uv[3] / textureHeight],
        },
      ];
    }),
  ) as MobModelCubeDefinition["faces"];
}

export interface ExecutedLayer {
  textureSize?: [number, number];
  root: MobModelPartDefinition;
  warnings: string[];
}

/*
 * Runtime stubs mirroring the vanilla geometry builders. Semantics are copied
 * from the decompiled 26.x sources (PartDefinition/CubeListBuilder/PartPose/
 * MeshDefinition/LayerDefinition/MeshTransformer) so that executing a
 * transpiled `create*Layer` method records exactly what the game would bake.
 */

class CubeDeformationStub {
  readonly growX: number;
  readonly growY: number;
  readonly growZ: number;

  constructor(growX: number, growY = growX, growZ = growX) {
    this.growX = growX;
    this.growY = growY;
    this.growZ = growZ;
  }

  extend(deltaX: number, deltaY = deltaX, deltaZ = deltaX): CubeDeformationStub {
    return new CubeDeformationStub(this.growX + deltaX, this.growY + deltaY, this.growZ + deltaZ);
  }

  static readonly NONE = new CubeDeformationStub(0, 0, 0);
}

class PartPoseStub {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly xRot: number,
    readonly yRot: number,
    readonly zRot: number,
    readonly xScale: number,
    readonly yScale: number,
    readonly zScale: number,
  ) {}

  static offsetAndRotation(x: number, y: number, z: number, xRot: number, yRot: number, zRot: number): PartPoseStub {
    return new PartPoseStub(x, y, z, xRot, yRot, zRot, 1, 1, 1);
  }

  static offset(x: number, y: number, z: number): PartPoseStub {
    return PartPoseStub.offsetAndRotation(x, y, z, 0, 0, 0);
  }

  static rotation(xRot: number, yRot: number, zRot: number): PartPoseStub {
    return PartPoseStub.offsetAndRotation(0, 0, 0, xRot, yRot, zRot);
  }

  static readonly ZERO = PartPoseStub.offsetAndRotation(0, 0, 0, 0, 0, 0);

  translated(x: number, y: number, z: number): PartPoseStub {
    return new PartPoseStub(this.x + x, this.y + y, this.z + z, this.xRot, this.yRot, this.zRot, this.xScale, this.yScale, this.zScale);
  }

  withScale(scale: number): PartPoseStub {
    return new PartPoseStub(this.x, this.y, this.z, this.xRot, this.yRot, this.zRot, scale, scale, scale);
  }

  scaled(factor: number): PartPoseStub;
  scaled(scaleX: number, scaleY: number, scaleZ: number): PartPoseStub;
  scaled(scaleX: number, scaleY = scaleX, scaleZ = scaleX): PartPoseStub {
    if (scaleX === 1 && scaleY === 1 && scaleZ === 1) {
      return this;
    }
    return new PartPoseStub(
      this.x * scaleX,
      this.y * scaleY,
      this.z * scaleZ,
      this.xRot,
      this.yRot,
      this.zRot,
      this.xScale * scaleX,
      this.yScale * scaleY,
      this.zScale * scaleZ,
    );
  }
}

interface RecordedCube {
  name?: string;
  texU: number;
  texV: number;
  origin: [number, number, number];
  size: [number, number, number];
  deformation: [number, number, number];
  mirror: boolean;
  /** Face names from an addBox visibleSides set; undefined means all six. */
  visibleFaces?: Set<string>;
}

class CubeListBuilderStub {
  private readonly recorded: RecordedCube[] = [];
  private xTexOffs = 0;
  private yTexOffs = 0;
  private mirrorState = false;

  constructor(private readonly warnings: string[]) {}

  texOffs(xTexOffs: number, yTexOffs: number): CubeListBuilderStub {
    this.xTexOffs = xTexOffs;
    this.yTexOffs = yTexOffs;
    return this;
  }

  mirror(mirror = true): CubeListBuilderStub {
    this.mirrorState = mirror;
    return this;
  }

  addBox(...args: unknown[]): CubeListBuilderStub {
    let cursor = 0;
    let name: string | undefined;
    if (typeof args[0] === "string") {
      name = args[0];
      cursor = 1;
    }

    const dims = args.slice(cursor, cursor + 6);
    if (dims.length !== 6 || dims.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Unsupported addBox arguments: ${JSON.stringify(args)}`);
    }
    const [x, y, z, width, height, depth] = dims as [number, number, number, number, number, number];

    let deformation: [number, number, number] = [0, 0, 0];
    let mirror = this.mirrorState;
    let visibleFaces: Set<string> | undefined;
    const trailingNumbers: number[] = [];
    for (const extra of args.slice(cursor + 6)) {
      if (extra instanceof CubeDeformationStub) {
        deformation = [extra.growX, extra.growY, extra.growZ];
      } else if (typeof extra === "boolean") {
        mirror = extra;
      } else if (typeof extra === "number") {
        trailingNumbers.push(extra);
      } else if (extra instanceof globalThis.Set) {
        visibleFaces = new Set(Array.from(extra as Set<string>));
      } else if (extra === null) {
        // EnumSet.allOf(Direction.class) -> all faces visible.
        visibleFaces = undefined;
      } else {
        throw new Error(`Unsupported addBox argument: ${String(extra)}`);
      }
    }

    if (trailingNumbers.length === 2) {
      if (name !== undefined) {
        // addBox(id, ..., xTexOffs, yTexOffs) routes through texOffs() in vanilla.
        this.texOffs(trailingNumbers[0] as number, trailingNumbers[1] as number);
      } else {
        this.warnings.push("addBox texture-scale variant is not supported; texture scale ignored.");
      }
    } else if (trailingNumbers.length !== 0) {
      throw new Error(`Unsupported addBox numeric arguments: ${JSON.stringify(args)}`);
    }

    this.recorded.push({
      ...(name !== undefined ? { name } : {}),
      texU: this.xTexOffs,
      texV: this.yTexOffs,
      origin: [x, y, z],
      size: [width, height, depth],
      deformation,
      mirror,
      ...(visibleFaces ? { visibleFaces } : {}),
    });
    return this;
  }

  getCubes(): RecordedCube[] {
    return [...this.recorded];
  }
}

class PartDefinitionStub {
  readonly children = new Map<string, PartDefinitionStub>();

  constructor(
    readonly cubes: RecordedCube[],
    readonly pose: PartPoseStub,
  ) {}

  addOrReplaceChild(name: string, cubesOrPart: CubeListBuilderStub | PartDefinitionStub, pose?: PartPoseStub): PartDefinitionStub {
    const child =
      cubesOrPart instanceof PartDefinitionStub ? cubesOrPart : new PartDefinitionStub(cubesOrPart.getCubes(), pose ?? PartPoseStub.ZERO);
    const previous = this.children.get(name);
    this.children.set(name, child);
    if (previous) {
      for (const [childName, grandChild] of previous.children) {
        child.children.set(childName, grandChild);
      }
    }
    return child;
  }

  getChild(name: string): PartDefinitionStub {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`No child with name: ${name}`);
    }
    return child;
  }

  clearChild(name: string): PartDefinitionStub {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`No child with name: ${name}`);
    }
    return this.addOrReplaceChild(name, new CubeListBuilderStub([]), child.pose);
  }

  clearRecursively(): PartDefinitionStub {
    for (const name of Array.from(this.children.keys())) {
      this.clearChild(name).clearRecursively();
    }
    return this;
  }

  retainPartsAndChildren(parts: Set<string>): void {
    for (const [name, child] of Array.from(this.children)) {
      if (!parts.has(name)) {
        this.addOrReplaceChild(name, new CubeListBuilderStub([]), child.pose).retainPartsAndChildren(parts);
      }
    }
  }

  retainExactParts(parts: Set<string>): void {
    for (const [name, child] of Array.from(this.children)) {
      if (parts.has(name)) {
        child.clearRecursively();
      } else {
        this.addOrReplaceChild(name, new CubeListBuilderStub([]), child.pose).retainExactParts(parts);
      }
    }
  }

  transformed(transform: (pose: PartPoseStub) => PartPoseStub): PartDefinitionStub {
    const next = new PartDefinitionStub(this.cubes, transform(this.pose));
    for (const [name, child] of this.children) {
      next.children.set(name, child);
    }
    return next;
  }
}

class MeshDefinitionStub {
  constructor(private readonly root = new PartDefinitionStub([], PartPoseStub.ZERO)) {}

  getRoot(): PartDefinitionStub {
    return this.root;
  }

  transformed(transform: (pose: PartPoseStub) => PartPoseStub): MeshDefinitionStub {
    return new MeshDefinitionStub(this.root.transformed(transform));
  }

  apply(transformer: unknown): MeshDefinitionStub {
    return applyMeshTransformer(transformer, this);
  }
}

class LayerDefinitionStub {
  constructor(
    readonly mesh: MeshDefinitionStub,
    readonly textureSize: [number, number],
  ) {}

  apply(transformer: unknown): LayerDefinitionStub {
    return new LayerDefinitionStub(applyMeshTransformer(transformer, this.mesh), this.textureSize);
  }
}

function applyMeshTransformer(transformer: unknown, mesh: MeshDefinitionStub): MeshDefinitionStub {
  if (typeof transformer === "function") {
    return transformer(mesh) as MeshDefinitionStub;
  }
  if (
    transformer &&
    typeof (transformer as { applyTransform?: unknown }).applyTransform === "function"
  ) {
    return (transformer as { applyTransform: (mesh: MeshDefinitionStub) => MeshDefinitionStub }).applyTransform(mesh);
  }
  throw new Error("Unsupported MeshTransformer value");
}

/** java.util.Random-compatible LCG (LegacyRandomSource). */
class JavaRandom {
  private seed: bigint;

  constructor(seed: number | bigint) {
    this.seed = (BigInt(Math.trunc(Number(seed))) ^ 0x5deece66dn) & 0xffffffffffffn;
  }

  private next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & 0xffffffffffffn;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new Error(`Invalid nextInt bound: ${bound}`);
    }
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    }
    let bits: number;
    let value: number;
    do {
      bits = this.next(31);
      value = bits % bound;
    } while (bits - value + (bound - 1) < 0);
    return value;
  }

  nextFloat(): number {
    return this.next(24) / (1 << 24);
  }

  nextBoolean(): boolean {
    return this.next(1) !== 0;
  }
}

interface JavaClassInfo {
  name: string;
  source: string;
  superName?: string;
  memberNames: Set<string>;
  methods: Map<string, (...args: unknown[]) => unknown>;
  fields: Map<string, unknown>;
  envProxy: object;
  scopeProxy: object;
}

const CLASS_REFERENCE_PATTERN = /\b[A-Z][A-Za-z0-9_$]*\b/g;
// Generous runaway backstop: the executor is shared across every layer of a
// run and the model + block-entity renderer trees together hold ~300
// classes; a tight cap starved the block-entity bakes (banner) back to the
// parser after earlier layers had filled the cache.
const MAX_LOADED_CLASSES = 600;

export class ModelSourceExecutor {
  private readonly classes = new Map<string, JavaClassInfo>();
  private readonly unresolvableClasses = new Set<string>();
  private currentWarnings: string[] = [];
  private localExpressions = new Map<string, string>();
  private readonly localValues = new Map<string, unknown>();
  private readonly globalScopeProxy: object;

  constructor(private readonly modelSourcePaths: Map<string, string>) {
    this.globalScopeProxy = this.createScopeProxy(undefined);
  }

  /**
   * Evaluates a resolved LayerDefinitions expression (e.g.
   * `GhastModel.createBodyLayer()` or `LayerDefinition.create(HumanoidModel.createMesh(...), 64, 64)`)
   * by executing the transpiled Java against the recording stubs. `locals`
   * are the variable declarations of LayerDefinitions#createRoots (e.g.
   * `villagerLikeScale`), resolved lazily when the expression uses them.
   */
  async executeLayerExpression(expression: string, locals?: Map<string, string>): Promise<ExecutedLayer> {
    this.localExpressions = locals ?? new Map();
    await this.preloadReferencedClasses(expression, new Set());
    for (const localName of this.collectReferencedLocals(expression, new Set())) {
      const localExpression = this.localExpressions.get(localName);
      if (localExpression) {
        await this.preloadReferencedClasses(localExpression, new Set());
      }
    }
    const warnings: string[] = [];
    this.currentWarnings = warnings;
    let layer: unknown;
    try {
      const transpiled = transpileJavaSnippet(expression);
      const evaluate = new Function("SCOPE", `with (SCOPE) { return (${transpiled}); }`) as (scope: object) => unknown;
      layer = evaluate(this.globalScopeProxy);
    } finally {
      this.currentWarnings = [];
    }

    if (!(layer instanceof LayerDefinitionStub)) {
      throw new Error("Expression did not evaluate to a LayerDefinition.");
    }

    const textureSize = layer.textureSize;
    const root = convertPart("root", "root", layer.mesh.getRoot(), textureSize, warnings);
    return { textureSize, root, warnings };
  }

  /** Names of createRoots locals referenced (transitively) by the expression. */
  private collectReferencedLocals(expression: string, seen: Set<string>): Set<string> {
    for (const match of expression.matchAll(/\b[a-z_$][\w$]*\b/g)) {
      const name = match[0];
      if (seen.has(name) || !this.localExpressions.has(name)) {
        continue;
      }
      seen.add(name);
      const nested = this.localExpressions.get(name);
      if (nested) {
        this.collectReferencedLocals(nested, seen);
      }
    }
    return seen;
  }

  private async preloadReferencedClasses(source: string, visited: Set<string>): Promise<void> {
    CLASS_REFERENCE_PATTERN.lastIndex = 0;
    const references = new Set<string>();
    for (const match of source.matchAll(CLASS_REFERENCE_PATTERN)) {
      references.add(match[0]);
    }

    for (const reference of references) {
      if (visited.has(reference) || this.classes.has(reference) || this.unresolvableClasses.has(reference)) {
        continue;
      }
      visited.add(reference);
      if (reference in GLOBAL_STUB_NAMES || !this.modelSourcePaths.has(reference)) {
        this.unresolvableClasses.add(reference);
        continue;
      }
      if (this.classes.size >= MAX_LOADED_CLASSES) {
        throw new Error("Too many transitive class references while preparing execution.");
      }
      const info = await this.loadClass(reference);
      if (info) {
        await this.preloadReferencedClasses(info.source, visited);
      }
    }
  }

  private async loadClass(name: string): Promise<JavaClassInfo | undefined> {
    const path = this.modelSourcePaths.get(name);
    if (!path) {
      this.unresolvableClasses.add(name);
      return undefined;
    }

    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      this.unresolvableClasses.add(name);
      return undefined;
    }

    const source = stripComments(raw);
    const superName = parseSuperclassSimpleName(source, name);
    const info: JavaClassInfo = {
      name,
      source,
      superName,
      memberNames: collectStaticMemberNames(source),
      methods: new Map(),
      fields: new Map(),
      envProxy: {},
      scopeProxy: {},
    };
    this.classes.set(name, info);
    info.scopeProxy = this.createScopeProxy(info);
    info.envProxy = this.createClassEnvProxy(info);

    if (superName && !this.classes.has(superName) && !this.unresolvableClasses.has(superName)) {
      await this.loadClass(superName);
    }
    return info;
  }

  private canResolveMember(info: JavaClassInfo | undefined, name: string): boolean {
    const seen = new Set<JavaClassInfo>();
    let current = info;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current.memberNames.has(name)) {
        return true;
      }
      current = current.superName ? this.classes.get(current.superName) : undefined;
    }
    return false;
  }

  private resolveMember(info: JavaClassInfo | undefined, name: string): unknown {
    const seen = new Set<JavaClassInfo>();
    let current = info;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current.memberNames.has(name)) {
        return this.resolveOwnMember(current, name);
      }
      current = current.superName ? this.classes.get(current.superName) : undefined;
    }
    throw new Error(`Could not resolve static member ${name}.`);
  }

  private resolveOwnMember(info: JavaClassInfo, name: string): unknown {
    const existingMethod = info.methods.get(name);
    if (existingMethod) {
      return existingMethod;
    }
    if (info.fields.has(name)) {
      return info.fields.get(name);
    }

    const method = findStaticMethod(info.source, name);
    if (method) {
      const compiled = this.compileMethod(info, method.params, method.body);
      info.methods.set(name, compiled);
      return compiled;
    }

    const initializer = findStaticFieldInitializer(info.source, name);
    if (initializer !== undefined) {
      const value = this.evaluateInClassScope(info, initializer);
      info.fields.set(name, value);
      return value;
    }

    throw new Error(`Could not resolve static member ${info.name}.${name}.`);
  }

  private compileMethod(info: JavaClassInfo, params: string[], body: string): (...args: unknown[]) => unknown {
    const transpiled = transpileJavaSnippet(body);
    const fn = new Function("SCOPE", ...params, `with (SCOPE) { ${transpiled} }`) as (scope: object, ...args: unknown[]) => unknown;
    return (...args: unknown[]) => fn(info.scopeProxy, ...args);
  }

  private evaluateInClassScope(info: JavaClassInfo, expression: string): unknown {
    const transpiled = transpileJavaSnippet(expression);
    const fn = new Function("SCOPE", `with (SCOPE) { return (${transpiled}); }`) as (scope: object) => unknown;
    return fn(info.scopeProxy);
  }

  private buildGlobalStubs(): Record<string, unknown> {
    const currentWarnings = (): string[] => this.currentWarnings;
    // Constructible (`new CubeListBuilder()` appears in some models) AND
    // provides the static create() factory, both wired to the run warnings.
    class BoundCubeListBuilder extends CubeListBuilderStub {
      constructor() {
        super(currentWarnings());
      }

      static create(): BoundCubeListBuilder {
        return new BoundCubeListBuilder();
      }
    }

    return {
      CubeDeformation: CubeDeformationStub,
      PartPose: PartPoseStub,
      MeshDefinition: MeshDefinitionStub,
      CubeListBuilder: BoundCubeListBuilder,
      Direction: {
        DOWN: "down",
        UP: "up",
        NORTH: "north",
        SOUTH: "south",
        WEST: "west",
        EAST: "east",
      },
      Set: {
        of: (...items: unknown[]) => new globalThis.Set(items),
      },
      EnumSet: {
        allOf: () => null,
        of: (...items: unknown[]) => new globalThis.Set(items),
        noneOf: () => new globalThis.Set(),
      },
      LayerDefinition: {
        create: (mesh: MeshDefinitionStub, width: number, height: number) => new LayerDefinitionStub(mesh, [width, height]),
      },
      MeshTransformer: {
        IDENTITY: { applyTransform: (mesh: MeshDefinitionStub) => mesh },
        scaling: (factor: number) => {
          const yOffset = 24.016 * (1 - factor);
          return {
            applyTransform: (mesh: MeshDefinitionStub) =>
              mesh.transformed((pose) => pose.scaled(factor).translated(0, yOffset, 0)),
          };
        },
      },
      RandomSource: {
        create: (seed: number | bigint = 0) => new JavaRandom(seed),
        createNewThreadLocalInstance: (seed: number | bigint = 0) => new JavaRandom(seed),
        createThreadLocalInstance: (seed: number | bigint = 0) => new JavaRandom(seed),
      },
      Mth: {
        PI: Math.PI,
        HALF_PI: Math.PI / 2,
        TWO_PI: Math.PI * 2,
        DEG_TO_RAD: Math.PI / 180,
        RAD_TO_DEG: 180 / Math.PI,
        SQRT_OF_TWO: Math.SQRT2,
        abs: Math.abs,
        ceil: Math.ceil,
        clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
        cos: Math.cos,
        floor: Math.floor,
        lerp: (delta: number, start: number, end: number) => start + delta * (end - start),
        sin: Math.sin,
        sqrt: Math.sqrt,
        square: (value: number) => value * value,
      },
    };
  }

  private get globalStubs(): Record<string, unknown> {
    return (this.cachedGlobalStubs ??= this.buildGlobalStubs());
  }

  private cachedGlobalStubs: Record<string, unknown> | undefined;

  private createScopeProxy(info: JavaClassInfo | undefined): object {
    const target = Object.create(null) as Record<string, unknown>;
    return new Proxy(target, {
      has: (_target, key) => {
        if (typeof key !== "string") {
          return false;
        }
        if (key === "Math" || key === "undefined") {
          return false;
        }
        return (
          Object.hasOwn(this.globalStubs, key) ||
          this.classes.has(key) ||
          (info === undefined && this.localExpressions.has(key)) ||
          this.canResolveMember(info, key)
        );
      },
      get: (_target, key) => {
        if (typeof key !== "string") {
          return undefined;
        }
        if (Object.hasOwn(this.globalStubs, key)) {
          return this.globalStubs[key];
        }
        const classInfo = this.classes.get(key);
        if (classInfo) {
          return classInfo.envProxy;
        }
        if (info === undefined && this.localExpressions.has(key)) {
          return this.resolveLocal(key);
        }
        return this.resolveMember(info, key);
      },
      set: () => {
        throw new Error("Assignments to Java statics are not supported.");
      },
    });
  }

  /** Lazily evaluates a createRoots local (cached across layers). */
  private resolveLocal(name: string): unknown {
    if (this.localValues.has(name)) {
      return this.localValues.get(name);
    }
    const expression = this.localExpressions.get(name);
    if (expression === undefined) {
      throw new Error(`Unknown local ${name}.`);
    }
    const transpiled = transpileJavaSnippet(expression);
    const evaluate = new Function("SCOPE", `with (SCOPE) { return (${transpiled}); }`) as (scope: object) => unknown;
    const value = evaluate(this.globalScopeProxy);
    this.localValues.set(name, value);
    return value;
  }

  private createClassEnvProxy(info: JavaClassInfo): object {
    const target = function javaClassPlaceholder(): void {
      /* proxy target only */
    };
    return new Proxy(target, {
      get: (_target, key) => {
        if (typeof key !== "string") {
          return undefined;
        }
        return this.resolveMember(info, key);
      },
      has: (_target, key) => typeof key === "string" && this.canResolveMember(info, key),
      construct: () => {
        throw new Error(`Cannot instantiate Java class ${info.name} during model execution.`);
      },
      apply: () => {
        throw new Error(`Java class ${info.name} is not callable.`);
      },
    });
  }
}

const GLOBAL_STUB_NAMES: Record<string, true> = {
  CubeDeformation: true,
  PartPose: true,
  MeshDefinition: true,
  CubeListBuilder: true,
  LayerDefinition: true,
  MeshTransformer: true,
  RandomSource: true,
  Mth: true,
  Math: true,
  String: true,
  Integer: true,
  Float: true,
  Double: true,
  Boolean: true,
  Arrays: true,
  List: true,
  ImmutableList: true,
  Set: true,
  EnumSet: true,
  Direction: true,
};

function convertPart(
  name: string,
  path: string,
  part: PartDefinitionStub,
  textureSize: [number, number] | undefined,
  warnings: string[],
): MobModelPartDefinition {
  const [textureWidth, textureHeight] = textureSize ?? [64, 64];
  const pose = part.pose;
  const converted: MobModelPartDefinition = {
    name,
    path,
    pivot: [pose.x, pose.y, pose.z],
    rotation: [pose.xRot, pose.yRot, pose.zRot],
    cubes: part.cubes.map((cube) => {
      const faces = bakeCubeFaces(cube.texU, cube.texV, cube.size[0], cube.size[1], cube.size[2], textureWidth, textureHeight);
      if (cube.visibleFaces) {
        for (const face of FACE_NAMES) {
          if (!cube.visibleFaces.has(face)) {
            delete faces[face];
          }
        }
      }
      return {
        ...(cube.name !== undefined ? { name: cube.name } : {}),
        origin: cube.origin,
        size: cube.size,
        deformation: cube.deformation,
        mirror: cube.mirror,
        texOffs: [cube.texU, cube.texV] as [number, number],
        faces,
      };
    }),
    children: [],
  };
  if (pose.xScale !== 1 || pose.yScale !== 1 || pose.zScale !== 1) {
    converted.scale = [pose.xScale, pose.yScale, pose.zScale];
  }

  const childNames = Array.from(part.children.keys()).sort((left, right) => left.localeCompare(right));
  for (const childName of childNames) {
    const child = part.children.get(childName);
    if (child) {
      converted.children.push(convertPart(childName, `${path}/${childName}`, child, textureSize, warnings));
    }
  }
  return converted;
}

/*
 * Java-to-JS transpilation for the narrow subset used by `create*Layer`
 * methods: local variable declarations, for loops (plain + enhanced), array
 * literals and allocations, lambdas, casts, numeric literal suffixes and
 * integer division on int-typed locals.
 */
export function transpileJavaSnippet(java: string): string {
  let code = stripComments(java);

  // Annotations
  code = code.replace(/@[A-Za-z_$][\w$]*(\([^)]*\))?/g, "");

  // Enhanced for loops: `for (Type name : iterable)` -> `for (const name of iterable)`
  code = code.replace(/for\s*\(\s*(?:final\s+)?[\w$.]+(?:<[^<>]*>)?(?:\[\])*\s+([\w$]+)\s*:\s*/g, "for (const $1 of ");

  // Method references: `Class::method` -> arrow wrapper
  code = code.replace(/\b([A-Za-z_$][\w$]*)\s*::\s*([\w$]+)/g, "((...__args) => $1.$2(...__args))");

  // Lambdas
  code = code.replace(/->/g, "=>");

  // Array literals: `new Type[]...{...}` -> nested JS arrays
  code = convertArrayLiterals(code);

  // Array allocation: `new float[7]` -> zero-filled JS array
  code = code.replace(/new\s+(?:int|long|short|byte|float|double|boolean)\s*\[\s*([^\]]+)\s*\]\s*(?!\[)/g, "new Array($1).fill(0)");

  // Integer division must truncate before casts/suffixes are erased.
  code = applyIntegerDivision(code);

  // Casts
  code = code.replace(/\(\s*(?:float|double)\s*\)/g, "");
  code = code.replace(/\(\s*(?:int|long)\s*\)\s*\(/g, "Math.trunc((");
  code = code.replace(/\(\s*(?:int|long)\s*\)\s*(-?[\w$.]+(?:\([^()]*\))?)/g, "Math.trunc($1)");

  // Numeric literal suffixes: 0.5F, 1660L, ...
  code = code.replace(/(?<![\w$])(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[fFdDlL]\b/g, "$1");

  // Local declarations -> let
  code = code.replace(
    /(?<![.\w$])(?:final\s+)?(?:byte|short|int|long|float|double|boolean|char|String|(?:[A-Z][\w$]*\.)*[A-Z][\w$]*)(?:<[^<>;(){}]*>)?(?:\[\])*\s+([A-Za-z_$][\w$]*)(?=\s*[=;])/g,
    "let $1",
  );

  return code;
}

/** Wraps `/` between int-typed locals (and int literals) in Math.trunc, matching Java semantics. */
function applyIntegerDivision(code: string): string {
  const intVars = new Set<string>();
  for (const match of code.matchAll(/\b(?:int|long|short|byte)\s+([a-z_$][\w$]*)\s*=/g)) {
    if (match[1]) {
      intVars.add(match[1]);
    }
  }
  if (intVars.size === 0) {
    return code;
  }

  const names = Array.from(intVars).map(escapeRegExp).join("|");
  // Single pass on purpose: String.replace does not rescan replacements, so
  // `i / 3 / 2.0F` becomes `Math.trunc(i / 3) / 2.0` without double-wrapping.
  const pattern = new RegExp(String.raw`\b(${names})\s*/\s*((?:${names})\b|\d+(?![.\d]))`, "g");
  return code.replace(pattern, "Math.trunc($1 / $2)");
}

/** Converts `new Type[]...{ ... }` (arbitrarily nested braces) into JS array literals. */
function convertArrayLiterals(code: string): string {
  const pattern = /new\s+[\w$.]+\s*(?:\[\s*\])+\s*\{/;
  let match = pattern.exec(code);
  while (match) {
    const braceStart = match.index + match[0].length - 1;
    const braceEnd = findMatchingBrace(code, braceStart);
    if (braceEnd < 0) {
      break;
    }
    const literal = code
      .slice(braceStart, braceEnd + 1)
      .replace(/\{/g, "[")
      .replace(/\}/g, "]");
    code = code.slice(0, match.index) + literal + code.slice(braceEnd + 1);
    match = pattern.exec(code);
  }
  return code;
}

function findMatchingBrace(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/**
 * Superclass of the named top-level class. Anchoring on the class name
 * matters: files like Model.java contain inner classes that extend the
 * outer class, and matching the first `extends` in the file would make the
 * class its own superclass (an infinite chain walk).
 */
function parseSuperclassSimpleName(source: string, className: string): string | undefined {
  const pattern = new RegExp(
    String.raw`\b(?:class|record|interface)\s+${escapeRegExp(className)}(?:<[^>{]+>)?\s+extends\s+([A-Za-z0-9_$.]+)`,
  );
  const superName = source.match(pattern)?.[1]?.split(".").pop();
  return superName === className ? undefined : superName;
}

function collectStaticMemberNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bstatic\s+[^={;()]*?([A-Za-z_$][\w$]*)\s*[=(]/g)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

function findStaticMethod(source: string, name: string): { params: string[]; body: string } | undefined {
  const pattern = new RegExp(String.raw`\bstatic\s+[^={;]*?\b${escapeRegExp(name)}\s*\(`, "g");
  const match = pattern.exec(source);
  if (!match) {
    return undefined;
  }

  const openParen = source.indexOf("(", match.index + match[0].length - 1);
  const closeParen = findMatching(source, openParen, "(", ")");
  if (openParen < 0 || closeParen < 0) {
    return undefined;
  }

  const openBrace = source.indexOf("{", closeParen);
  if (openBrace < 0 || /[^\s]/.test(source.slice(closeParen + 1, openBrace).replace(/throws\s+[\w$.,\s]+/, ""))) {
    return undefined;
  }
  const closeBrace = findMatching(source, openBrace, "{", "}");
  if (closeBrace < 0) {
    return undefined;
  }

  const params = splitTopLevelArgs(source.slice(openParen + 1, closeParen))
    .map((param) => param.trim())
    .filter(Boolean)
    .map((param) => {
      const nameMatch = param.match(/([A-Za-z_$][\w$]*)\s*$/);
      return nameMatch?.[1] ?? param;
    });
  return { params, body: source.slice(openBrace + 1, closeBrace) };
}

function findStaticFieldInitializer(source: string, name: string): string | undefined {
  const pattern = new RegExp(String.raw`\bstatic\s+(?:final\s+)?[^=;{}()]*?\b${escapeRegExp(name)}\s*=`, "g");
  const match = pattern.exec(source);
  if (!match) {
    return undefined;
  }

  const start = match.index + match[0].length;
  let inString = false;
  let escaped = false;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (!character) {
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses -= 1;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
    } else if (character === ";" && parentheses === 0 && braces === 0 && brackets === 0) {
      return source.slice(start, index).trim();
    }
  }
  return undefined;
}

function splitTopLevelArgs(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let angles = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;
    if (character === "<") angles += 1;
    if (character === ">" && angles > 0) angles -= 1;

    if (character === "," && parentheses === 0 && braces === 0 && brackets === 0 && angles === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const last = value.slice(start).trim();
  if (last) {
    parts.push(last);
  }
  return parts;
}

function findMatching(value: string, openIndex: number, open: string, close: string): number {
  if (openIndex < 0) {
    return -1;
  }

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = openIndex; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countPartCubes(part: MobModelPartDefinition | undefined): number {
  if (!part) {
    return 0;
  }
  return part.cubes.length + part.children.reduce((total, child) => total + countPartCubes(child), 0);
}
