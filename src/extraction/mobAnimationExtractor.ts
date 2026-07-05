import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  MobAnimationBoneTrack,
  MobAnimationChannelTarget,
  MobAnimationClip,
  MobAnimationDefinition,
  MobAnimationInterpolation,
  MobAnimationKeyframe,
  MobModelDefinition,
  MobModelLayerDefinition,
  MobModelPartDefinition,
} from "../domain/types.js";
import { transpileJavaSnippet } from "./modelSourceExecutor.js";

const MODEL_SOURCE_DIR = "net/minecraft/client/model";
const ANIMATION_DEFINITIONS_DIR = "net/minecraft/client/animation/definitions";
const RENDER_STATE_DIR = "net/minecraft/client/renderer/entity/state";
const ENTITY_RENDERER_DIR = "net/minecraft/client/renderer/entity";

/** Ticks -> seconds. The client runs animation math in ticks (20/s). */
const SECONDS_PER_TICK = 0.05;

/**
 * Extracts mob animation clips from decompiled client source. Two systems are
 * covered (see docs/PUGTOOLS_DATASET_IDEAS.md idea 16):
 *
 *  - Part A — declarative keyframe definitions (`animation/definitions/*.java`)
 *    are parsed losslessly and attached to the mobs whose model classes reference
 *    them, converted to absolute local transforms against the mob's base pose.
 *  - Part B — procedural `setupAnim` bodies are transpiled and executed against a
 *    live ModelPart graph (built from mob-models.json) under canonical input
 *    presets (idle / walk / aggressive), sampled over one loop period, and reduced
 *    to keyframes.
 *
 * Bone names in every clip match the part `name`s already published in
 * mob-models.json. Anything that cannot be evaluated faithfully is reported as a
 * warning rather than guessed (house rule).
 */
export class MobAnimationExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(mobs: MobModelDefinition[], decompiledClientRoot: string): Promise<MobAnimationDefinition[]> {
    if (mobs.length === 0 || !(await fileExists(decompiledClientRoot))) {
      return [];
    }

    const [modelSources, animationDefinitions, renderStates, rendererSources] = await Promise.all([
      indexJavaFiles(join(decompiledClientRoot, MODEL_SOURCE_DIR)),
      this.parseAnimationDefinitions(join(decompiledClientRoot, ANIMATION_DEFINITIONS_DIR)),
      indexJavaFiles(join(decompiledClientRoot, RENDER_STATE_DIR)),
      indexJavaFiles(join(decompiledClientRoot, ENTITY_RENDERER_DIR)),
    ]);

    const sourceCache = new Map<string, Promise<string | undefined>>();
    const readClass = (name: string): Promise<string | undefined> => {
      const path = modelSources.get(name) ?? renderStates.get(name) ?? rendererSources.get(name);
      if (!path) {
        return Promise.resolve(undefined);
      }
      let pending = sourceCache.get(name);
      if (!pending) {
        pending = fs.readFile(path, "utf8").then(
          (raw) => stripComments(raw),
          () => undefined,
        );
        sourceCache.set(name, pending);
      }
      return pending;
    };

    const results: MobAnimationDefinition[] = [];
    for (const mob of mobs) {
      results.push(await this.extractMob(mob, animationDefinitions, readClass, renderStates, rendererSources));
    }

    const withClips = results.filter((mob) => mob.clips.length > 0).length;
    this.logger.debug(`Resolved mob animations for ${withClips}/${results.length} mobs.`);
    return results.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private async extractMob(
    mob: MobModelDefinition,
    animationDefinitions: Map<string, ParsedClipDefinition>,
    readClass: (name: string) => Promise<string | undefined>,
    renderStates: Map<string, string>,
    rendererSources: Map<string, string>,
  ): Promise<MobAnimationDefinition> {
    const warnings: string[] = [];
    const layer = pickPrimaryLayer(mob);
    if (!layer?.root || !layer.modelClass) {
      return {
        id: mob.id,
        localId: mob.localId,
        displayName: mob.displayName,
        clips: [],
        status: "unresolved",
        warnings: [layer ? `No model class/geometry resolved for layer ${layer.id}.` : "No baked model layer to animate."],
      };
    }

    // The layer's modelClass is the *mesh-factory* class (often a shared base such
    // as HumanoidModel). The concrete model that carries setupAnim is the one the
    // renderer instantiates (e.g. ZombieModel), so resolve that from the renderer.
    const modelClass = await resolveConcreteModelClass(mob.rendererClass, layer.modelClass, rendererSources, readClass);

    const basePoses = collectBasePoses(layer.root, warnings);
    const chain = await loadModelChain(modelClass, readClass);
    if (chain.length === 0) {
      return {
        id: mob.id,
        localId: mob.localId,
        displayName: mob.displayName,
        modelClass,
        modelLayer: layer.id,
        clips: [],
        status: "unresolved",
        warnings: [...warnings, `Could not read model source for ${modelClass}.`],
      };
    }

    const clips: MobAnimationClip[] = [];

    // Part A — keyframe-definition clips referenced by this model.
    clips.push(...buildKeyframeClips(chain, animationDefinitions, basePoses));

    // Part B — procedural setupAnim baking.
    try {
      clips.push(...(await bakeProceduralClips(chain, layer.root, basePoses, readClass, renderStates, warnings)));
    } catch (error) {
      warnings.push(`Procedural setupAnim bake failed: ${(error as Error).message}`);
    }

    const anyPartial = clips.some((clip) => clip.warnings.length > 0);
    const status: MobAnimationDefinition["status"] =
      clips.length === 0 ? "unresolved" : anyPartial || warnings.length > 0 ? "partial" : "baked";

    return {
      id: mob.id,
      localId: mob.localId,
      displayName: mob.displayName,
      modelClass,
      modelLayer: layer.id,
      clips,
      status,
      warnings,
    };
  }

  /** Part A parse: `animation/definitions/*.java` -> map of `Class.CONSTANT` -> clip. */
  private async parseAnimationDefinitions(dir: string): Promise<Map<string, ParsedClipDefinition>> {
    const map = new Map<string, ParsedClipDefinition>();
    if (!(await fileExists(dir))) {
      return map;
    }

    for (const path of await listJavaFiles(dir)) {
      const normalized = path.replace(/\\/g, "/");
      const className = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.java$/, "");
      let source: string;
      try {
        source = stripComments(await fs.readFile(path, "utf8"));
      } catch {
        continue;
      }
      for (const definition of parseAnimationClassFile(className, source)) {
        map.set(definition.ref, definition);
      }
    }
    return map;
  }
}

/* ------------------------------------------------------------------ *
 * Part A — keyframe definition parsing
 * ------------------------------------------------------------------ */

interface ParsedKeyframe {
  t: number;
  /** Offset value in vanilla channel units (already through posVec/degreeVec/scaleVec). */
  value: [number, number, number];
  interp: MobAnimationInterpolation;
}

interface ParsedChannel {
  bone: string;
  target: MobAnimationChannelTarget;
  keyframes: ParsedKeyframe[];
}

interface ParsedClipDefinition {
  className: string;
  constant: string;
  /** e.g. `FrogAnimation.FROG_CROAK`. */
  ref: string;
  lengthSeconds: number;
  loop: boolean;
  channels: ParsedChannel[];
  warnings: string[];
}

function parseAnimationClassFile(className: string, source: string): ParsedClipDefinition[] {
  const definitions: ParsedClipDefinition[] = [];
  const pattern = /\bstatic\s+final\s+AnimationDefinition\s+([A-Z0-9_]+)\s*=/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const constant = match[1];
    if (!constant) {
      continue;
    }
    const initializer = readInitializer(source, match.index + match[0].length);
    if (initializer === undefined) {
      continue;
    }
    const parsed = parseAnimationBuilderChain(className, constant, initializer);
    if (parsed) {
      definitions.push(parsed);
    }
  }
  return definitions;
}

function parseAnimationBuilderChain(className: string, constant: string, chain: string): ParsedClipDefinition | undefined {
  const warnings: string[] = [];
  const lengthMatch = chain.match(/withLength\(\s*(-?\d+(?:\.\d+)?)[fFdD]?\s*\)/);
  if (!lengthMatch?.[1]) {
    return undefined;
  }
  const lengthSeconds = Number.parseFloat(lengthMatch[1]);
  const loop = /\.\s*looping\s*\(\s*\)/.test(chain);

  const channels: ParsedChannel[] = [];
  for (const call of findMethodCalls(chain, "addAnimation")) {
    const args = splitTopLevelArgs(call);
    const bone = parseStringLiteral(args[0]);
    if (!bone || !args[1]) {
      warnings.push("Skipped an addAnimation call with an unreadable bone/channel.");
      continue;
    }
    const channel = parseAnimationChannel(bone, args[1], warnings);
    if (channel) {
      channels.push(channel);
    }
  }

  return { className, constant, ref: `${className}.${constant}`, lengthSeconds, loop, channels, warnings };
}

function parseAnimationChannel(bone: string, channelExpr: string, warnings: string[]): ParsedChannel | undefined {
  const targetMatch = channelExpr.match(/Targets\s*\.\s*(POSITION|ROTATION|SCALE)/);
  if (!targetMatch?.[1]) {
    warnings.push(`Skipped a channel for ${bone} with an unrecognized target.`);
    return undefined;
  }
  const target = targetMatch[1].toLowerCase() as MobAnimationChannelTarget;
  const keyframes: ParsedKeyframe[] = [];
  for (const call of findConstructorCalls(channelExpr, "Keyframe")) {
    const keyframe = parseKeyframe(call, target, warnings, bone);
    if (keyframe) {
      keyframes.push(keyframe);
    }
  }
  keyframes.sort((a, b) => a.t - b.t);
  if (keyframes.length === 0) {
    return undefined;
  }
  return { bone, target, keyframes };
}

function parseKeyframe(
  argString: string,
  target: MobAnimationChannelTarget,
  warnings: string[],
  bone: string,
): ParsedKeyframe | undefined {
  const args = splitTopLevelArgs(argString);
  if (args.length < 3) {
    return undefined;
  }
  const t = parseNumberLiteral(args[0]);
  if (t === undefined) {
    return undefined;
  }
  // Keyframe(t, postTarget, interp) or Keyframe(t, preTarget, postTarget, interp).
  const vecArg = args.length >= 4 ? args[args.length - 2] : args[1];
  if (args.length >= 4) {
    warnings.push(`Keyframe for ${bone} used distinct pre/post targets; kept postTarget only.`);
  }
  const value = parseVectorCall(vecArg ?? "");
  if (!value) {
    warnings.push(`Skipped a ${target} keyframe for ${bone} with an unreadable vector.`);
    return undefined;
  }
  const interp: MobAnimationInterpolation = /CATMULLROM/.test(args[args.length - 1] ?? "") ? "catmullrom" : "linear";
  return { t, value, interp };
}

/** Applies vanilla KeyframeAnimations.posVec/degreeVec/scaleVec conversions, yielding channel-space offsets. */
function parseVectorCall(expr: string): [number, number, number] | undefined {
  const call = expr.match(/(posVec|degreeVec|scaleVec)\s*\(([\s\S]*)\)\s*$/);
  if (!call?.[1]) {
    return undefined;
  }
  const nums = splitTopLevelArgs(call[2] ?? "").map(parseNumberLiteral);
  if (nums.length < 3 || nums.some((value) => value === undefined)) {
    return undefined;
  }
  const [x, y, z] = nums as [number, number, number];
  switch (call[1]) {
    case "posVec":
      return [x, -y, z];
    case "degreeVec":
      return [(x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180];
    case "scaleVec":
      return [x - 1, y - 1, z - 1];
    default:
      return undefined;
  }
}

/**
 * Builds keyframe clips referenced by the model's setupAnim, converting each
 * channel offset to an absolute local transform against the bone's base pose.
 */
function buildKeyframeClips(
  chain: ModelClass[],
  animationDefinitions: Map<string, ParsedClipDefinition>,
  basePoses: Map<string, BonePose>,
): MobAnimationClip[] {
  const combinedSource = chain.map((entry) => entry.source).join("\n");
  const setupAnimSource = chain.map((entry) => entry.methods.get("setupAnim")?.body ?? "").join("\n");
  const constructorSource = chain.map((entry) => `${entry.fieldSource}\n${entry.constructorSource}`).join("\n");

  // field name -> animation constant ref, from `this.x = Foo.BAR.bake(...)`.
  const fieldToRef = new Map<string, string>();
  for (const assign of constructorSource.matchAll(
    /([A-Za-z_$][\w$]*)\s*=\s*([A-Z][\w$]*)\s*\.\s*([A-Z0-9_]+)\s*\.\s*bake\s*\(/g,
  )) {
    const [, field, cls, constant] = assign;
    if (field && cls && constant) {
      fieldToRef.set(field, `${cls}.${constant}`);
    }
  }

  const clips: MobAnimationClip[] = [];
  const seen = new Set<string>();
  for (const refMatch of combinedSource.matchAll(/\b([A-Z][A-Za-z0-9_]*Animation)\s*\.\s*([A-Z0-9_]+)\b/g)) {
    const ref = `${refMatch[1]}.${refMatch[2]}`;
    if (seen.has(ref)) {
      continue;
    }
    const definition = animationDefinitions.get(ref);
    if (!definition) {
      continue;
    }
    seen.add(ref);
    const field = findFieldForRef(fieldToRef, ref);
    clips.push(buildKeyframeClip(definition, basePoses, detectTrigger(setupAnimSource, field)));
  }
  return clips;
}

function findFieldForRef(fieldToRef: Map<string, string>, ref: string): string | undefined {
  for (const [field, value] of fieldToRef) {
    if (value === ref) {
      return field;
    }
  }
  return undefined;
}

function detectTrigger(setupAnimSource: string, field: string | undefined): string {
  if (!field) {
    return "state";
  }
  const escaped = escapeRegExp(field);
  if (new RegExp(`\\bthis\\s*\\.\\s*${escaped}\\s*\\.\\s*applyWalk\\s*\\(`).test(setupAnimSource)) {
    return "walk";
  }
  if (new RegExp(`\\bthis\\s*\\.\\s*${escaped}\\s*\\.\\s*applyStatic\\s*\\(`).test(setupAnimSource)) {
    return "static";
  }
  return "state";
}

function buildKeyframeClip(
  definition: ParsedClipDefinition,
  basePoses: Map<string, BonePose>,
  trigger: string,
): MobAnimationClip {
  const warnings = [...definition.warnings];
  const boneMap = new Map<string, MobAnimationBoneTrack>();

  for (const channel of definition.channels) {
    const base = basePoses.get(channel.bone);
    if (!base) {
      warnings.push(`Bone "${channel.bone}" from ${definition.constant} was not found in the mob's base pose; channel skipped.`);
      continue;
    }
    const baseValue = baseChannelValue(base, channel.target);
    const keyframes: MobAnimationKeyframe[] = channel.keyframes.map((keyframe) => ({
      t: keyframe.t,
      value: [baseValue[0] + keyframe.value[0], baseValue[1] + keyframe.value[1], baseValue[2] + keyframe.value[2]] as [
        number,
        number,
        number,
      ],
      interp: keyframe.interp,
    }));
    const track = boneMap.get(channel.bone) ?? { bone: channel.bone };
    track[channel.target] = keyframes;
    boneMap.set(channel.bone, track);
  }

  return {
    name: cleanClipName(definition.className, definition.constant),
    source: "keyframe",
    definition: definition.ref,
    lengthSeconds: definition.lengthSeconds,
    loop: definition.loop,
    trigger,
    bones: Array.from(boneMap.values()).sort((a, b) => a.bone.localeCompare(b.bone)),
    warnings,
  };
}

function cleanClipName(className: string, constant: string): string {
  const prefix = `${className.replace(/Animation$/, "").toUpperCase()}_`;
  const trimmed = constant.startsWith(prefix) ? constant.slice(prefix.length) : constant;
  return trimmed.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Base pose bookkeeping
 * ------------------------------------------------------------------ */

interface BonePose {
  pivot: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** name -> base pose, mirroring ModelPart.createPartLookup (first occurrence wins). */
function collectBasePoses(root: MobModelPartDefinition, warnings: string[]): Map<string, BonePose> {
  const map = new Map<string, BonePose>();
  const collisions = new Set<string>();
  const visit = (part: MobModelPartDefinition): void => {
    if (map.has(part.name)) {
      collisions.add(part.name);
    } else {
      map.set(part.name, {
        pivot: part.pivot,
        rotation: part.rotation,
        scale: part.scale ?? [1, 1, 1],
      });
    }
    for (const child of part.children) {
      visit(child);
    }
  };
  visit(root);
  // "root" collides structurally on nested-root models (e.g. frog) but is never an
  // animation target, so it is not worth flagging.
  const meaningful = Array.from(collisions).filter((name) => name !== "root");
  if (meaningful.length > 0) {
    warnings.push(`Duplicate bone name(s) ${meaningful.join(", ")}; used the first occurrence for base-pose lookup.`);
  }
  return map;
}

function baseChannelValue(base: BonePose, target: MobAnimationChannelTarget): [number, number, number] {
  switch (target) {
    case "rotation":
      return base.rotation;
    case "position":
      return base.pivot;
    case "scale":
      return base.scale;
    default:
      return [0, 0, 0];
  }
}

function pickPrimaryLayer(mob: MobModelDefinition): MobModelLayerDefinition | undefined {
  const candidates = mob.layers.filter((layer) => layer.root && layer.status !== "unresolved");
  if (candidates.length === 0) {
    return mob.layers.find((layer) => layer.root) ?? mob.layers[0];
  }
  return (
    candidates.find((layer) => layer.id === mob.localId) ??
    candidates.find((layer) => layer.modelClass && !/baby/i.test(layer.id)) ??
    candidates[0]
  );
}

/* ------------------------------------------------------------------ *
 * Model class chain loading (source parsing)
 * ------------------------------------------------------------------ */

interface JavaMethod {
  params: string[];
  body: string;
}

interface ModelClass {
  name: string;
  source: string;
  /** Field-declaration region (before the first method) — holds field initializers. */
  fieldSource: string;
  /** Concatenated constructor bodies of this class. */
  constructorSource: string;
  /** super(...) argument expression, if the constructor calls super. */
  superArg?: string;
  methods: Map<string, JavaMethod>;
}

/**
 * Finds the concrete model class the renderer instantiates (`new ZombieModel(...)`),
 * walking the renderer's own `extends` chain. Falls back to the mesh-factory class
 * from the layer when nothing better is found.
 */
async function resolveConcreteModelClass(
  rendererClass: string | undefined,
  layerModelClass: string,
  rendererSources: Map<string, string>,
  readClass: (name: string) => Promise<string | undefined>,
): Promise<string> {
  if (!rendererClass) {
    return layerModelClass;
  }
  const seen = new Set<string>();
  let current: string | undefined = rendererClass.split(".")[0];
  while (current && !seen.has(current) && rendererSources.has(current)) {
    seen.add(current);
    const source = await readClass(current);
    if (!source) {
      break;
    }
    const matches = [...source.matchAll(/new\s+([A-Z]\w*Model)\s*(?:<[^>]*>)?\s*\(([^;]*?)\)/g)];
    // Prefer a model constructed from a baked layer (the body model, not an inner armor model).
    const primary = matches.find((match) => /bakeLayer|ModelLayers|\broot\b/.test(match[2] ?? "")) ?? matches[0];
    if (primary?.[1]) {
      const candidate = primary[1];
      // Only accept a class we can actually read as a model source.
      if (await readClass(candidate)) {
        return candidate;
      }
    }
    current = parseSuperclassSimpleName(source, current);
  }
  return layerModelClass;
}

/** Loads modelClass and every ancestor up the `extends` chain, base-last (derived first). */
async function loadModelChain(
  modelClass: string,
  readClass: (name: string) => Promise<string | undefined>,
): Promise<ModelClass[]> {
  const chain: ModelClass[] = [];
  const seen = new Set<string>();
  let current: string | undefined = modelClass;
  while (current && !seen.has(current)) {
    seen.add(current);
    const source = await readClass(current);
    if (!source) {
      break;
    }
    chain.push(parseModelClass(current, source));
    current = parseSuperclassSimpleName(source, current);
    if (current === "Object" || current === "Model") {
      break;
    }
  }
  return chain;
}

function parseModelClass(name: string, source: string): ModelClass {
  const methods = new Map<string, JavaMethod>();
  const constructors: string[] = [];
  let superArg: string | undefined;
  let earliestMember = source.length;

  // Constructors: `(public|protected|private) ClassName(` with a `{` body.
  const ctorPattern = new RegExp(String.raw`(?:public|protected|private)\s+${escapeRegExp(name)}\s*\(`, "g");
  for (const match of source.matchAll(ctorPattern)) {
    if (match.index === undefined) {
      continue;
    }
    const openParen = source.indexOf("(", match.index);
    const closeParen = findMatching(source, openParen, "(", ")");
    if (openParen < 0 || closeParen < 0) {
      continue;
    }
    const openBrace = source.indexOf("{", closeParen);
    if (openBrace < 0 || /[^\s]/.test(source.slice(closeParen + 1, openBrace).replace(/throws[\s\S]*/, ""))) {
      continue;
    }
    const closeBrace = findMatching(source, openBrace, "{", "}");
    if (closeBrace < 0) {
      continue;
    }
    const body = source.slice(openBrace + 1, closeBrace);
    constructors.push(body);
    earliestMember = Math.min(earliestMember, match.index);

    const superMatch = body.match(/\bsuper\s*\(/);
    if (superMatch?.index !== undefined && superArg === undefined) {
      const superOpen = body.indexOf("(", superMatch.index);
      const superClose = findMatching(body, superOpen, "(", ")");
      if (superOpen >= 0 && superClose >= 0) {
        superArg = splitTopLevelArgs(body.slice(superOpen + 1, superClose))[0]?.trim();
      }
    }
  }

  // Instance methods: `<modifier> returnType methodName(params) { ... }`, excluding static + field initializers.
  const methodPattern = /(?:public|protected|private)\s+([A-Za-z_$][\w$<>.,[\]\s]*?)\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(methodPattern)) {
    const head = match[0];
    const methodName = match[2];
    if (match.index === undefined || !methodName || methodName === name) {
      continue;
    }
    if (/\bstatic\b/.test(head) || head.includes("=")) {
      continue; // static method or field initializer with a call.
    }
    const openParen = source.indexOf("(", match.index + head.length - 1);
    const closeParen = findMatching(source, openParen, "(", ")");
    if (openParen < 0 || closeParen < 0) {
      continue;
    }
    const openBrace = source.indexOf("{", closeParen);
    const between = source.slice(closeParen + 1, openBrace < 0 ? source.length : openBrace).replace(/throws[\s\S]*/, "");
    if (openBrace < 0 || /[^\s]/.test(between)) {
      continue; // abstract / signature-only.
    }
    const closeBrace = findMatching(source, openBrace, "{", "}");
    if (closeBrace < 0) {
      continue;
    }
    const params = splitTopLevelArgs(source.slice(openParen + 1, closeParen))
      .map((param) => param.trim())
      .filter(Boolean)
      .map((param) => param.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? param);
    if (!methods.has(methodName)) {
      methods.set(methodName, { params, body: source.slice(openBrace + 1, closeBrace) });
    }
    earliestMember = Math.min(earliestMember, match.index);
  }

  // Field declarations live inside the class body, so start fieldSource just after
  // the class-body brace; splitStatements (which respects brace depth) then splits
  // the field declarations correctly instead of gluing them into one chunk.
  const classMatch = source.match(new RegExp(String.raw`\b(?:class|record|interface|enum)\s+${escapeRegExp(name)}\b`));
  let classBodyStart = 0;
  if (classMatch?.index !== undefined) {
    const brace = source.indexOf("{", classMatch.index);
    if (brace >= 0 && brace < earliestMember) {
      classBodyStart = brace + 1;
    }
  }

  return {
    name,
    source,
    fieldSource: source.slice(classBodyStart, earliestMember),
    constructorSource: constructors.join("\n"),
    superArg,
    methods,
  };
}

/* ------------------------------------------------------------------ *
 * Part B — live ModelPart graph + setupAnim execution
 * ------------------------------------------------------------------ */

class LiveModelPart {
  x: number;
  y: number;
  z: number;
  xRot: number;
  yRot: number;
  zRot: number;
  xScale: number;
  yScale: number;
  zScale: number;
  visible = true;
  skipDraw = false;
  private readonly initial: BonePose;
  readonly children = new Map<string, LiveModelPart>();

  constructor(base: BonePose) {
    this.initial = base;
    this.x = base.pivot[0];
    this.y = base.pivot[1];
    this.z = base.pivot[2];
    this.xRot = base.rotation[0];
    this.yRot = base.rotation[1];
    this.zRot = base.rotation[2];
    this.xScale = base.scale[0];
    this.yScale = base.scale[1];
    this.zScale = base.scale[2];
  }

  getChild(name: string): LiveModelPart {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`No child with name: ${name}`);
    }
    return child;
  }

  hasChild(name: string): boolean {
    return this.children.has(name);
  }

  resetPose(): void {
    this.x = this.initial.pivot[0];
    this.y = this.initial.pivot[1];
    this.z = this.initial.pivot[2];
    this.xRot = this.initial.rotation[0];
    this.yRot = this.initial.rotation[1];
    this.zRot = this.initial.rotation[2];
    this.xScale = this.initial.scale[0];
    this.yScale = this.initial.scale[1];
    this.zScale = this.initial.scale[2];
    this.visible = true;
  }

  offsetPos(v: { x(): number; y(): number; z(): number }): void {
    this.x += v.x();
    this.y += v.y();
    this.z += v.z();
  }

  offsetRotation(v: { x(): number; y(): number; z(): number }): void {
    this.xRot += v.x();
    this.yRot += v.y();
    this.zRot += v.z();
  }

  offsetScale(v: { x(): number; y(): number; z(): number }): void {
    this.xScale += v.x();
    this.yScale += v.y();
    this.zScale += v.z();
  }
}

function buildLiveGraph(part: MobModelPartDefinition): LiveModelPart {
  const live = new LiveModelPart({ pivot: part.pivot, rotation: part.rotation, scale: part.scale ?? [1, 1, 1] });
  for (const child of part.children) {
    live.children.set(child.name, buildLiveGraph(child));
  }
  return live;
}

function allLiveParts(root: LiveModelPart): LiveModelPart[] {
  const parts: LiveModelPart[] = [];
  const visit = (part: LiveModelPart): void => {
    parts.push(part);
    for (const child of part.children.values()) {
      visit(child);
    }
  };
  visit(root);
  return parts;
}

interface PresetSpec {
  name: string;
  /** Which state field advances with the driver `t` (in ticks). */
  driver: "walkAnimationPos" | "ageInTicks";
  /** Fixed state field overrides. */
  fixed: Record<string, number | boolean>;
  inputsUsed: string[];
  maxTicks: number;
  requiredFields?: string[];
}

async function bakeProceduralClips(
  chain: ModelClass[],
  layerRoot: MobModelPartDefinition,
  basePoses: Map<string, BonePose>,
  readClass: (name: string) => Promise<string | undefined>,
  renderStates: Map<string, string>,
  mobWarnings: string[],
): Promise<MobAnimationClip[]> {
  const setupAnimBody = buildCombinedSetupAnim(chain);
  if (setupAnimBody === undefined) {
    return [];
  }

  const stateFieldNames = new Set<string>();
  for (const m of setupAnimBody.matchAll(/\bstate\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (m[1]) {
      stateFieldNames.add(m[1]);
    }
  }
  const stateDefaults = await resolveStateDefaults(chain, readClass, renderStates);

  const referencesAggressive = /\bstate\s*\.\s*isAggressive\b/.test(chain.map((c) => c.source).join("\n"));

  const presets: PresetSpec[] = [
    {
      name: "walk",
      driver: "walkAnimationPos",
      fixed: { walkAnimationSpeed: 1, ageInTicks: 0 },
      inputsUsed: ["walkAnimationPos", "walkAnimationSpeed"],
      maxTicks: 48,
    },
    {
      name: "idle",
      driver: "ageInTicks",
      fixed: { walkAnimationSpeed: 0, walkAnimationPos: 0 },
      inputsUsed: ["ageInTicks"],
      maxTicks: 128,
    },
  ];
  if (referencesAggressive) {
    presets.push({
      name: "aggressive",
      driver: "ageInTicks",
      fixed: { walkAnimationSpeed: 0, walkAnimationPos: 0, isAggressive: true },
      inputsUsed: ["isAggressive", "ageInTicks"],
      maxTicks: 128,
      requiredFields: ["isAggressive"],
    });
  }

  const model = new CompiledModel(chain, layerRoot, basePoses, setupAnimBody);
  const clips: MobAnimationClip[] = [];
  for (const preset of presets) {
    if (preset.requiredFields && !preset.requiredFields.every((field) => stateFieldNames.has(field))) {
      continue;
    }
    try {
      const clip = bakePreset(model, preset, stateDefaults);
      if (clip) {
        clips.push(clip);
      }
    } catch (error) {
      mobWarnings.push(`Preset "${preset.name}" bake failed: ${(error as Error).message}`);
    }
  }
  return clips;
}

/**
 * Redirects `super.<helper>(...)` to a per-instance ancestor binding (`this.__super_<helper>(...)`)
 * so overridden helpers that chain up (e.g. AdultFoxModel.setWalkingPose -> super.setWalkingPose)
 * execute instead of throwing a `super` SyntaxError inside `new Function`. `super.setupAnim` is
 * excluded — it is inlined by buildCombinedSetupAnim before this runs.
 */
function rewriteSuperCalls(body: string): string {
  return body.replace(/\bsuper\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g, (match, name) =>
    name === "setupAnim" ? match : `this.__super_${name}(`,
  );
}

/** Inlines the super.setupAnim chain into one JS-ready body (each super wrapped in its own block). */
function buildCombinedSetupAnim(chain: ModelClass[]): string | undefined {
  const definingIndex = chain.findIndex((entry) => entry.methods.has("setupAnim"));
  if (definingIndex < 0) {
    return undefined;
  }
  const build = (index: number): string => {
    const entry = chain[index];
    const method = entry?.methods.get("setupAnim");
    if (!entry || !method) {
      // Base Model.setupAnim just resets the pose.
      return "this.resetPose();";
    }
    // Find the next ancestor that defines setupAnim.
    let parentIndex = -1;
    for (let i = index + 1; i < chain.length; i += 1) {
      if (chain[i]?.methods.has("setupAnim")) {
        parentIndex = i;
        break;
      }
    }
    const parentBody = parentIndex >= 0 ? build(parentIndex) : "this.resetPose();";
    return method.body.replace(/\bsuper\s*\.\s*setupAnim\s*\([^;]*\)\s*;/g, `{ ${parentBody} }`);
  };
  return build(definingIndex);
}

class CompiledModel {
  private readonly methodCache = new Map<string, ((...args: unknown[]) => unknown) | null>();
  private readonly setupAnimFn: (scope: object, state: object) => void;
  readonly scope: object;

  constructor(
    private readonly chain: ModelClass[],
    private readonly layerRoot: MobModelPartDefinition,
    private readonly basePoses: Map<string, BonePose>,
    setupAnimBody: string,
  ) {
    // super.setupAnim is already inlined by buildCombinedSetupAnim; redirect any
    // remaining super.<helper>() to its per-instance ancestor binding.
    const transpiled = transpileJavaSnippet(rewriteSuperCalls(setupAnimBody));
    this.setupAnimFn = new Function("SCOPE", "state", `with (SCOPE) { ${transpiled} }`) as (scope: object, state: object) => void;
    this.scope = buildAnimationScope(this.chainReferences());
  }

  baseBonePoses(): Map<string, BonePose> {
    return this.basePoses;
  }

  /** Builds a fresh model instance (parts reset to base pose) and its field wiring. */
  instantiate(): { root: LiveModelPart; parts: LiveModelPart[]; instance: Record<string, unknown> } {
    const root = buildLiveGraph(this.layerRoot);
    const parts = allLiveParts(root);
    const instance: Record<string, unknown> = {};
    const modelRoot = resolveModelRoot(this.chain, root);
    instance.root = modelRoot;
    instance.resetPose = (): void => {
      for (const part of parts) {
        part.resetPose();
      }
    };
    wireModelFields(this.chain, instance, root, modelRoot);
    wireAnimationFields(this.chain, instance);
    this.attachMethods(instance);
    return { root, parts, instance };
  }

  private attachMethods(instance: Record<string, unknown>): void {
    // Every class (derived-first) that defines each instance method, so `super.X()`
    // can resolve to the next ancestor's implementation.
    const definers = new Map<string, ModelClass[]>();
    for (const entry of this.chain) {
      for (const methodName of entry.methods.keys()) {
        if (methodName === "setupAnim") {
          continue;
        }
        (definers.get(methodName) ?? definers.set(methodName, []).get(methodName)!).push(entry);
      }
    }
    for (const [methodName, owners] of definers) {
      instance[methodName] = (...args: unknown[]): unknown => this.invokeMethod(instance, methodName, owners[0], args);
      if (owners.length > 1) {
        instance[`__super_${methodName}`] = (...args: unknown[]): unknown =>
          this.invokeMethod(instance, methodName, owners[1], args);
      }
    }
  }

  private invokeMethod(
    instance: Record<string, unknown>,
    methodName: string,
    owner: ModelClass | undefined,
    args: unknown[],
  ): unknown {
    const fn = owner ? this.compileMethod(methodName, owner) : null;
    if (!fn) {
      throw new Error(`Unsupported model method ${methodName}.`);
    }
    return fn.call(instance, this.scope, ...args);
  }

  private compileMethod(methodName: string, owner: ModelClass): ((...args: unknown[]) => unknown) | null {
    const key = `${owner.name}.${methodName}`;
    if (this.methodCache.has(key)) {
      return this.methodCache.get(key) ?? null;
    }
    const method = owner.methods.get(methodName);
    let compiled: ((...args: unknown[]) => unknown) | null = null;
    if (method) {
      const transpiled = transpileJavaSnippet(rewriteSuperCalls(method.body));
      compiled = new Function("SCOPE", ...method.params, `with (SCOPE) { ${transpiled} }`) as (...args: unknown[]) => unknown;
    }
    this.methodCache.set(key, compiled);
    return compiled;
  }

  private chainReferences(): Set<string> {
    const refs = new Set<string>();
    for (const entry of this.chain) {
      for (const m of entry.source.matchAll(/\b([A-Z][A-Za-z0-9_]*Animation)\b/g)) {
        if (m[1]) {
          refs.add(m[1]);
        }
      }
    }
    return refs;
  }

  runSetupAnim(instance: Record<string, unknown>, state: object): void {
    this.setupAnimFn.call(instance, this.scope, state);
  }
}

/** Traces super(...) getChild transforms to find the part the base Model constructor stores as `this.root`. */
function resolveModelRoot(chain: ModelClass[], layerRoot: LiveModelPart): LiveModelPart {
  let current = layerRoot;
  for (const entry of chain) {
    if (!entry.superArg) {
      continue;
    }
    const resolved = followGetChildChain(entry.superArg, current);
    if (resolved) {
      current = resolved;
    }
  }
  return current;
}

/** Resolves `root(.getChild("x"))*` against a starting part. Returns null on anything else. */
function followGetChildChain(expr: string, root: LiveModelPart): LiveModelPart | null {
  const trimmed = expr.trim();
  if (!/^root\b/.test(trimmed)) {
    return null;
  }
  let part: LiveModelPart | null = root;
  const childPattern = /\.\s*getChild\s*\(\s*"([^"]+)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = childPattern.exec(trimmed)) !== null) {
    if (!part || !match[1]) {
      return null;
    }
    part = part.children.get(match[1]) ?? null;
  }
  return part;
}

/**
 * Populates instance.<field> = LiveModelPart by evaluating field initializers and
 * constructor assignments of the form `this.<f> = <base>(.getChild("name"))*`, where
 * base is `root` (ctor param = layer root), `this.root`, `this.<field>`, or a local.
 */
function wireModelFields(
  chain: ModelClass[],
  instance: Record<string, unknown>,
  layerRoot: LiveModelPart,
  modelRoot: LiveModelPart,
): void {
  // Process base-class first so parents' fields exist before subclasses reference them.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const entry = chain[i];
    if (!entry) {
      continue;
    }
    const locals = new Map<string, LiveModelPart>();
    const statements = [...splitStatements(entry.fieldSource), ...splitStatements(entry.constructorSource)];
    for (const statement of statements) {
      // this.<field> = <chain>
      const fieldAssign = statement.match(/^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
      const fieldDecl = statement.match(/^(?:private|protected|public|final|\s)*ModelPart\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
      const localDecl = statement.match(/^ModelPart\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);

      if (localDecl && !/^this\b/.test(statement)) {
        const resolved = resolvePartChain(localDecl[2] ?? "", { layerRoot, modelRoot, instance, locals });
        if (resolved) {
          locals.set(localDecl[1] ?? "", resolved);
          continue;
        }
      }
      if (/^this\s*\.\s*[A-Za-z_$][\w$]*\s*=/.test(statement) || fieldDecl) {
        const name = fieldDecl?.[1] ?? fieldAssign?.[1];
        const expr = fieldDecl?.[2] ?? fieldAssign?.[2];
        if (name && expr && name !== "root") {
          const resolved = resolvePartChain(expr, { layerRoot, modelRoot, instance, locals });
          if (resolved) {
            instance[name] = resolved;
          }
        }
      }
    }
  }
}

/**
 * Stubs `KeyframeAnimation` fields (declared + `this.x = Foo.BAR.bake(...)`) with an
 * inert clip. In procedural baking, keyframe clips are handled losslessly by Part A,
 * so their in-setupAnim applications are intentionally no-ops.
 */
function wireAnimationFields(chain: ModelClass[], instance: Record<string, unknown>): void {
  const inertClip = { apply: () => undefined, applyWalk: () => undefined, applyStatic: () => undefined };
  for (const entry of chain) {
    for (const declaration of entry.fieldSource.matchAll(/\bKeyframeAnimation\s+([A-Za-z_$][\w$]*)\s*[;=]/g)) {
      if (declaration[1]) {
        instance[declaration[1]] = inertClip;
      }
    }
    for (const assign of entry.constructorSource.matchAll(
      /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*[A-Z][\w$]*\s*\.\s*[A-Z0-9_]+\s*\.\s*bake\s*\(/g,
    )) {
      if (assign[1]) {
        instance[assign[1]] = inertClip;
      }
    }
  }
}

function resolvePartChain(
  expr: string,
  ctx: {
    layerRoot: LiveModelPart;
    modelRoot: LiveModelPart;
    instance: Record<string, unknown>;
    locals: Map<string, LiveModelPart>;
  },
): LiveModelPart | null {
  let rest = expr.trim();
  let part: LiveModelPart | null = null;

  const thisFieldMatch = rest.match(/^this\s*\.\s*([A-Za-z_$][\w$]*)/);
  if (rest.startsWith("root")) {
    part = ctx.layerRoot;
    rest = rest.slice(4);
  } else if (thisFieldMatch) {
    const field = thisFieldMatch[1] ?? "";
    part = field === "root" ? ctx.modelRoot : ((ctx.instance[field] as LiveModelPart | undefined) ?? null);
    rest = rest.slice(thisFieldMatch[0].length);
  } else {
    const localMatch = rest.match(/^([A-Za-z_$][\w$]*)/);
    if (localMatch?.[1] && ctx.locals.has(localMatch[1])) {
      part = ctx.locals.get(localMatch[1]) ?? null;
      rest = rest.slice(localMatch[0].length);
    } else {
      return null;
    }
  }

  const childPattern = /^\s*\.\s*getChild\s*\(\s*"([^"]+)"\s*\)/;
  let match: RegExpExecArray | null;
  while ((match = childPattern.exec(rest)) !== null) {
    if (!part || !match[1]) {
      return null;
    }
    part = part.children.get(match[1]) ?? null;
    rest = rest.slice(match[0].length);
  }
  // Any leftover (method calls, arithmetic) means this isn't a plain part chain.
  return /^\s*;?\s*$/.test(rest) ? part : null;
}

/* ------------------------------------------------------------------ *
 * Preset baking: execute setupAnim over the driver, sample, reduce
 * ------------------------------------------------------------------ */

function bakePreset(model: CompiledModel, preset: PresetSpec, stateDefaults: Map<string, unknown>): MobAnimationClip | null {
  const evaluate = (tick: number): Map<string, PartSnapshot> => {
    const { root, instance } = model.instantiate();
    const state = buildState(stateDefaults, preset, tick);
    model.runSetupAnim(instance, state);
    const pose = snapshot(root);
    for (const snap of pose.values()) {
      for (const value of [...snap.rotation, ...snap.position, ...snap.scale]) {
        if (!Number.isFinite(value)) {
          throw new Error("setupAnim produced non-finite transforms (unmodeled state field or division).");
        }
      }
    }
    return pose;
  };

  // Base pose snapshot for delta comparison.
  const baseSnapshot = evaluate(0);
  const period = detectLoopPeriod(evaluate, baseSnapshot, preset.maxTicks);

  if (period.constant) {
    return null; // No motion for this preset.
  }

  const sampleCount = Math.max(2, Math.min(64, Math.ceil(period.ticks) + 1));
  const samples: { t: number; pose: Map<string, PartSnapshot> }[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const tick = (period.ticks * i) / (sampleCount - 1);
    samples.push({ t: tick * SECONDS_PER_TICK, pose: evaluate(tick) });
  }

  const bones = reduceToBoneTracks(samples, model.baseBonePoses());
  if (bones.length === 0) {
    return null;
  }

  return {
    name: preset.name,
    source: "baked",
    lengthSeconds: period.ticks * SECONDS_PER_TICK,
    loop: true,
    ...(period.approximate ? { approximateLoop: true } : {}),
    trigger: preset.name === "walk" ? "walk" : preset.name === "aggressive" ? "state" : "idle",
    inputsUsed: preset.inputsUsed,
    bones,
    warnings: [],
  };
}

interface PartSnapshot {
  name: string;
  rotation: [number, number, number];
  position: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
}

function snapshot(root: LiveModelPart): Map<string, PartSnapshot> {
  const map = new Map<string, PartSnapshot>();
  // Recover names by walking the graph (parts carry no name; the parent's child map does).
  const visit = (part: LiveModelPart, name: string): void => {
    if (!map.has(name)) {
      map.set(name, {
        name,
        rotation: [part.xRot, part.yRot, part.zRot],
        position: [part.x, part.y, part.z],
        scale: [part.xScale, part.yScale, part.zScale],
        visible: part.visible,
      });
    }
    for (const [childName, child] of part.children) {
      visit(child, childName);
    }
  };
  visit(root, "root");
  return map;
}

interface LoopPeriod {
  ticks: number;
  constant: boolean;
  approximate: boolean;
}

const CLOSURE_EPSILON = 0.01;
const MIN_PERIOD_TICKS = 0.5;

const MOTION_SCAN_TICKS = 26;

function detectLoopPeriod(
  evaluate: (tick: number) => Map<string, PartSnapshot>,
  baseSnapshot: Map<string, PartSnapshot>,
  maxTicks: number,
): LoopPeriod {
  const step = 0.25;
  let sawMotion = false;
  let maxSeen = 0;
  let bestTick = 0;
  let bestError = Number.POSITIVE_INFINITY;

  for (let tick = step; tick <= maxTicks + 1e-9; tick += step) {
    const distance = poseDistance(evaluate(tick), baseSnapshot);
    if (distance > CLOSURE_EPSILON) {
      sawMotion = true;
    }
    // Any procedural motion shows up within a couple dozen ticks; bail early if not.
    if (!sawMotion && tick >= MOTION_SCAN_TICKS) {
      return { ticks: 0, constant: true, approximate: false };
    }
    // Only treat a tick as a loop candidate once the pose has departed and returned
    // (distance dropped well below its peak). Without this, a monotonically drifting,
    // non-closing oscillation (incommensurate idle bobs) picks a spurious near-zero tick.
    const genuineReturn = tick >= MIN_PERIOD_TICKS && maxSeen > CLOSURE_EPSILON && distance < maxSeen * 0.5;
    if (genuineReturn) {
      if (distance < bestError) {
        bestError = distance;
        bestTick = tick;
      }
      if (distance < CLOSURE_EPSILON) {
        return { ticks: tick, constant: false, approximate: false };
      }
    }
    maxSeen = Math.max(maxSeen, distance);
  }

  if (!sawMotion) {
    return { ticks: 0, constant: true, approximate: false };
  }
  // No clean closure: prefer a genuine best-return period; otherwise loop over the whole
  // sampled window rather than collapsing to a meaningless near-zero period.
  return { ticks: bestTick > 0 ? bestTick : maxTicks, constant: false, approximate: true };
}

function poseDistance(a: Map<string, PartSnapshot>, b: Map<string, PartSnapshot>): number {
  let max = 0;
  for (const [name, snapA] of a) {
    const snapB = b.get(name);
    if (!snapB) {
      continue;
    }
    for (const channel of ["rotation", "position", "scale"] as const) {
      const va = snapA[channel];
      const vb = snapB[channel];
      max = Math.max(max, Math.abs(va[0] - vb[0]), Math.abs(va[1] - vb[1]), Math.abs(va[2] - vb[2]));
    }
  }
  return max;
}

const CHANNEL_EPSILON = 1e-4;

function reduceToBoneTracks(
  samples: { t: number; pose: Map<string, PartSnapshot> }[],
  basePoses: Map<string, BonePose>,
): MobAnimationBoneTrack[] {
  const boneNames = new Set<string>();
  for (const sample of samples) {
    for (const name of sample.pose.keys()) {
      boneNames.add(name);
    }
  }

  const tracks: MobAnimationBoneTrack[] = [];
  for (const bone of boneNames) {
    const base = basePoses.get(bone);
    const track: MobAnimationBoneTrack = { bone };
    let touched = false;
    for (const channel of ["rotation", "position", "scale"] as const) {
      const values = samples.map((sample) => ({ t: sample.t, value: sample.pose.get(bone)?.[channel] }));
      if (values.some((entry) => entry.value === undefined)) {
        continue;
      }
      const baseValue = base ? baseChannelValue(base, channel) : [0, 0, 0];
      const varies = values.some((entry) =>
        (entry.value as [number, number, number]).some(
          (component, i) => Math.abs(component - (baseValue[i] ?? 0)) > CHANNEL_EPSILON,
        ),
      );
      if (!varies) {
        continue;
      }
      track[channel] = compressKeyframes(
        values.map((entry) => ({ t: entry.t, value: entry.value as [number, number, number], interp: "linear" as const })),
      );
      touched = true;
    }
    if (touched) {
      tracks.push(track);
    }
  }
  return tracks.sort((a, b) => a.bone.localeCompare(b.bone));
}

/** Drops keyframes that are linearly interpolatable from their neighbors. */
function compressKeyframes(keyframes: MobAnimationKeyframe[]): MobAnimationKeyframe[] {
  if (keyframes.length <= 2) {
    return keyframes;
  }
  const kept: MobAnimationKeyframe[] = [keyframes[0] as MobAnimationKeyframe];
  for (let i = 1; i < keyframes.length - 1; i += 1) {
    const prev = kept[kept.length - 1] as MobAnimationKeyframe;
    const current = keyframes[i] as MobAnimationKeyframe;
    const next = keyframes[i + 1] as MobAnimationKeyframe;
    const alpha = (current.t - prev.t) / (next.t - prev.t || 1);
    const redundant = current.value.every((component, axis) => {
      const interpolated = prev.value[axis]! + alpha * (next.value[axis]! - prev.value[axis]!);
      return Math.abs(component - interpolated) < CHANNEL_EPSILON;
    });
    if (!redundant) {
      kept.push(current);
    }
  }
  kept.push(keyframes[keyframes.length - 1] as MobAnimationKeyframe);
  return kept;
}

function buildState(stateDefaults: Map<string, unknown>, preset: PresetSpec, tick: number): object {
  const state: Record<string, unknown> = {};
  for (const [name, value] of stateDefaults) {
    state[name] = value;
  }
  for (const [name, value] of Object.entries(preset.fixed)) {
    state[name] = value;
  }
  state[preset.driver] = tick;
  return state;
}

/* ------------------------------------------------------------------ *
 * Render-state defaults + animation runtime scope (stubs)
 * ------------------------------------------------------------------ */

async function resolveStateDefaults(
  chain: ModelClass[],
  readClass: (name: string) => Promise<string | undefined>,
  renderStates: Map<string, string>,
): Promise<Map<string, unknown>> {
  const defaults = new Map<string, unknown>();
  const stateClass = detectStateClass(chain);
  const seen = new Set<string>();
  let current: string | undefined = stateClass;
  while (current && !seen.has(current) && renderStates.has(current)) {
    seen.add(current);
    const source = await readClass(current);
    if (!source) {
      break;
    }
    collectStateFieldDefaults(source, defaults);
    current = parseSuperclassSimpleName(source, current);
  }
  return defaults;
}

function detectStateClass(chain: ModelClass[]): string | undefined {
  for (const entry of chain) {
    const match = entry.source.match(/\bextends\s+[A-Za-z0-9_.]+<\s*([A-Za-z0-9_]+)\s*>/);
    if (match?.[1]?.endsWith("RenderState")) {
      return match[1];
    }
    const generic = entry.source.match(/\b([A-Za-z0-9_]+RenderState)\b/);
    if (generic?.[1]) {
      return generic[1];
    }
  }
  return "LivingEntityRenderState";
}

function collectStateFieldDefaults(source: string, defaults: Map<string, unknown>): void {
  const pattern = /\bpublic\s+(?!static)(?:final\s+)?([A-Za-z0-9_.<>]+)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*([^;]+))?;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const type = match[1] ?? "";
    const name = match[2];
    const rawInit = match[3]?.trim();
    if (!name || defaults.has(name)) {
      continue;
    }
    if (type === "float" || type === "double" || type === "int" || type === "long" || type === "short" || type === "byte") {
      defaults.set(name, rawInit ? (parseNumberLiteral(rawInit) ?? 0) : 0);
    } else if (type === "boolean") {
      defaults.set(name, rawInit === "true");
    } else {
      defaults.set(name, enumStubFor(type, rawInit));
    }
  }
}

function enumStubFor(type: string, rawInit: string | undefined): unknown {
  if (type.includes("ArmPose")) {
    return ARM_POSE.EMPTY;
  }
  if (type.endsWith("HumanoidArm")) {
    return HUMANOID_ARM.RIGHT;
  }
  if (type.endsWith("Pose")) {
    return POSE.STANDING;
  }
  if (type.includes("SwingAnimationType")) {
    return SWING_TYPE.NONE;
  }
  if (rawInit && /\.\s*[A-Z0-9_]+\s*$/.test(rawInit)) {
    return { name: rawInit.split(".").pop() };
  }
  // Animation states default to "not started" stubs so `.apply(...)` is a no-op.
  return makeInertObject();
}

/** Object that swallows any method call / property access without throwing (used for unmodeled state objects). */
function makeInertObject(): unknown {
  const handler: ProxyHandler<() => void> = {
    get: (_target, key) => {
      if (key === "isStarted") {
        return () => false;
      }
      if (key === "getTimeInMillis" || key === "getAccumulatedTime") {
        return () => 0;
      }
      if (key === Symbol.toPrimitive) {
        return () => 0;
      }
      return makeInertObject();
    },
    apply: () => makeInertObject(),
  };
  return new Proxy(function inert() {}, handler);
}

interface EnumValue {
  name: string;
  isTwoHanded(): boolean;
  affectsOffhandPose(): boolean;
}

function makeArmPose(name: string): EnumValue {
  return { name, isTwoHanded: () => false, affectsOffhandPose: () => false };
}

const ARM_POSE: Record<string, EnumValue> = Object.fromEntries(
  [
    "EMPTY",
    "ITEM",
    "BLOCK",
    "BOW_AND_ARROW",
    "THROW_TRIDENT",
    "CROSSBOW_CHARGE",
    "CROSSBOW_HOLD",
    "SPYGLASS",
    "TOOT_HORN",
    "BRUSH",
    "SPEAR",
  ].map((name) => [name, makeArmPose(name)]),
);
const HUMANOID_ARM = { LEFT: { name: "LEFT" }, RIGHT: { name: "RIGHT" } };
const POSE = Object.fromEntries(
  [
    "STANDING",
    "FALL_FLYING",
    "SLEEPING",
    "SWIMMING",
    "SPIN_ATTACK",
    "CROUCHING",
    "LONG_JUMPING",
    "DYING",
    "CROAKING",
    "USING_TONGUE",
    "SITTING",
    "ROARING",
    "SNIFFING",
    "EMERGING",
    "DIGGING",
  ].map((name) => [name, { name }]),
);
const SWING_TYPE = { NONE: { name: "NONE" }, STAB: { name: "STAB" }, SWING: { name: "SWING" } };
const INTERACTION_HAND = { MAIN_HAND: { name: "MAIN_HAND" }, OFF_HAND: { name: "OFF_HAND" } };

const MTH_STUB = {
  PI: Math.PI,
  HALF_PI: Math.PI / 2,
  TWO_PI: Math.PI * 2,
  DEG_TO_RAD: Math.PI / 180,
  RAD_TO_DEG: 180 / Math.PI,
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  sign: Math.sign,
  square: (v: number) => v * v,
  clamp: (v: number, min: number, max: number) => Math.min(Math.max(v, min), max),
  lerp: (delta: number, start: number, end: number) => start + delta * (end - start),
  frac: (v: number) => v - Math.floor(v),
  wrapDegrees: (v: number) => {
    let r = v % 360;
    if (r >= 180) r -= 360;
    if (r < -180) r += 360;
    return r;
  },
  rotLerpRad: (delta: number, start: number, end: number) => {
    let d = (end - start) % (Math.PI * 2);
    while (d < -Math.PI) d += Math.PI * 2;
    while (d >= Math.PI) d -= Math.PI * 2;
    return start + delta * d;
  },
  rotLerp: (delta: number, start: number, end: number) => {
    let d = (end - start) % 360;
    if (d >= 180) d -= 360;
    if (d < -180) d += 360;
    return start + delta * d;
  },
  triangleWave: (v: number, period: number) => Math.abs(((v + period * 0.25) % period) - period * 0.5) / (period * 0.25) - 1,
  catmullrom: (t: number, p0: number, p1: number, p2: number, p3: number) =>
    0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - 3 * p2 + p3 - p0) * t * t * t),
  cosFromSin: (sin: number, angle: number) => {
    const cos = Math.sqrt(Math.max(0, 1 - sin * sin));
    const wrapped = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return wrapped > Math.PI / 2 && wrapped < (3 * Math.PI) / 2 ? -cos : cos;
  },
};

/** Reimplemented AnimationUtils helpers that mutate LiveModelPart arms (idle/walk relevant subset). */
const ANIMATION_UTILS = {
  bobModelPart(part: LiveModelPart, ageInTicks: number, scale: number): void {
    part.zRot += scale * (Math.cos(ageInTicks * 0.09) * 0.05 + 0.05);
    part.xRot += scale * (Math.sin(ageInTicks * 0.067) * 0.05);
  },
  bobArms(rightArm: LiveModelPart, leftArm: LiveModelPart, ageInTicks: number): void {
    ANIMATION_UTILS.bobModelPart(rightArm, ageInTicks, 1);
    ANIMATION_UTILS.bobModelPart(leftArm, ageInTicks, -1);
  },
  animateZombieArms(leftArm: LiveModelPart, rightArm: LiveModelPart, aggressive: boolean, state: Record<string, unknown>): void {
    const animateAttack = state.swingAnimationType !== SWING_TYPE.STAB;
    if (animateAttack) {
      const raiseArms = !state.isBaby;
      const armDrop = raiseArms ? -Math.PI / (aggressive ? 1.5 : 2.25) : 0;
      ANIMATION_UTILS.animateAttackArms(leftArm, rightArm, Number(state.attackTime ?? 0), raiseArms, armDrop);
    }
    ANIMATION_UTILS.bobArms(rightArm, leftArm, Number(state.ageInTicks ?? 0));
  },
  animateAttackArms(leftArm: LiveModelPart, rightArm: LiveModelPart, attackTime: number, negate: boolean, armDrop: number): void {
    const attackYRot = (negate ? 1 : -1) * Math.sin(attackTime * Math.PI);
    const attackXRot = Math.sin((1 - (1 - attackTime) * (1 - attackTime)) * Math.PI);
    const xRot = armDrop + attackYRot * 1.2 - attackXRot * 0.4;
    const yRot = 0.1 - attackYRot * 0.6;
    rightArm.xRot = xRot;
    rightArm.yRot = negate ? -yRot : yRot;
    rightArm.zRot = 0;
    leftArm.xRot = xRot;
    leftArm.yRot = negate ? yRot : -yRot;
    leftArm.zRot = 0;
  },
};

function buildAnimationScope(animationClasses: Set<string>): object {
  const scope: Record<string, unknown> = {
    Math,
    Mth: MTH_STUB,
    AnimationUtils: ANIMATION_UTILS,
    HumanoidArm: HUMANOID_ARM,
    InteractionHand: INTERACTION_HAND,
    Pose: POSE,
    SwingAnimationType: SWING_TYPE,
    ItemStack: { EMPTY: { name: "EMPTY" } },
    HumanoidModel: { ArmPose: ARM_POSE },
    HumanoidArmPose: ARM_POSE,
  };
  // Unqualified enum constants so `switch (x) { case EMPTY: ... }` resolves.
  for (const [name, value] of Object.entries(ARM_POSE)) {
    scope[name] = value;
  }
  for (const [name, value] of Object.entries(POSE)) {
    if (!(name in scope)) {
      scope[name] = value;
    }
  }
  // Animation-definition holders: any CONSTANT resolves to a bakeable no-op clip.
  for (const animClass of animationClasses) {
    scope[animClass] = makeAnimationClassStub();
  }
  return scope;
}

function makeAnimationClassStub(): unknown {
  const inertClip = {
    apply: () => undefined,
    applyWalk: () => undefined,
    applyStatic: () => undefined,
  };
  return new Proxy(
    {},
    {
      get: () => ({ bake: () => inertClip }),
    },
  );
}

/* ------------------------------------------------------------------ *
 * Shared parsing helpers (self-contained; mirror mobModelExtractor style)
 * ------------------------------------------------------------------ */

async function indexJavaFiles(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!(await fileExists(root))) {
    return map;
  }
  for (const path of await listJavaFiles(root)) {
    const normalized = path.replace(/\\/g, "/");
    const className = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.java$/, "");
    if (!map.has(className)) {
      map.set(className, path);
    }
  }
  return map;
}

async function listJavaFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      files.push(path);
    }
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

function parseSuperclassSimpleName(source: string, className: string): string | undefined {
  const pattern = new RegExp(
    String.raw`\b(?:class|record|interface)\s+${escapeRegExp(className)}(?:<[^>{]+>)?\s+extends\s+([A-Za-z0-9_$.]+)`,
  );
  const superName = source.match(pattern)?.[1]?.split(".").pop();
  return superName === className ? undefined : superName;
}

/** Reads a `= <initializer>;` starting at `start`, balancing brackets; returns the initializer text. */
function readInitializer(source: string, start: number): string | undefined {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen -= 1;
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace -= 1;
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket -= 1;
    else if (ch === ";" && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      return source.slice(start, i).trim();
    }
  }
  return undefined;
}

/** Finds each `<name>(...)` call and returns the argument string of each occurrence. */
function findMethodCalls(source: string, name: string): string[] {
  const results: string[] = [];
  const pattern = new RegExp(String.raw`\.\s*${escapeRegExp(name)}\s*\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = findMatching(source, open, "(", ")");
    if (open >= 0 && close >= 0) {
      results.push(source.slice(open + 1, close));
      pattern.lastIndex = close;
    }
  }
  return results;
}

/** Finds each `new <Name>(...)` call and returns the argument string of each occurrence. */
function findConstructorCalls(source: string, name: string): string[] {
  const results: string[] = [];
  const pattern = new RegExp(String.raw`\bnew\s+${escapeRegExp(name)}\s*\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = findMatching(source, open, "(", ")");
    if (open >= 0 && close >= 0) {
      results.push(source.slice(open + 1, close));
      pattern.lastIndex = close;
    }
  }
  return results;
}

function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
    else if (ch === ";" && paren === 0 && brace === 0 && bracket === 0) {
      const statement = source.slice(start, i).replace(/\s+/g, " ").trim();
      if (statement) {
        statements.push(statement);
      }
      start = i + 1;
    }
  }
  return statements;
}

function splitTopLevelArgs(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let angle = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "," && paren === 0 && brace === 0 && bracket === 0 && angle === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
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
  for (let i = openIndex; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function parseStringLiteral(value: string | undefined): string | undefined {
  return value?.trim().match(/^"([^"]*)"$/)?.[1];
}

function parseNumberLiteral(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value
    .replace(/\(\s*(?:float|double|int|long)\s*\)/g, "")
    .replace(/[fFdDlL](?![\w.])/g, "")
    .replace(/\s+/g, "")
    .replace(/^\((.*)\)$/, "$1");
  const piMatch = normalized.match(/^(-?)(?:\(float\))?Math\.PI(?:\s*\/\s*(-?\d+(?:\.\d+)?))?$/);
  if (piMatch) {
    const sign = piMatch[1] === "-" ? -1 : 1;
    const divisor = piMatch[2] ? Number.parseFloat(piMatch[2]) : 1;
    return (sign * Math.PI) / divisor;
  }
  const numeric = normalized.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/);
  return numeric ? Number.parseFloat(numeric[0]) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
