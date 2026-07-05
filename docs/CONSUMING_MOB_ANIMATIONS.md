# Consuming `mob-animations.json` (pugtools mob profiles)

This guide shows how to animate the 3D mobs in the mob-profile viewer using the
`mob-animations.json` collection. It assumes you already render mobs from
`mob-models.json` (the animation data drives the exact same bones).

## 1. Where the data lives

- **Static bundle** (same layout you already use): `minecraft-data/<version>/mob-animations.json`
- **API**: `GET /versions/:version/mob-animations` — supports `?id=cow`, `?q=croak`,
  `?limit=`, `?offset=` (same envelope as every other collection).

Shape:

```jsonc
{
  "version": "26.2",
  "generatedAt": "…",
  "mobs": [
    {
      "id": "minecraft:cow",
      "localId": "cow",
      "displayName": "Cow",
      "modelClass": "CowModel",
      "modelLayer": "cow",
      "status": "baked", // "baked" | "partial" | "unresolved"
      "warnings": [],
      "clips": [
        {
          "name": "walk", // idle | walk | aggressive | croak | emerge | …
          "source": "baked", // "keyframe" (lossless) | "baked" (sampled setupAnim)
          "lengthSeconds": 0.475,
          "loop": true,
          "approximateLoop": false, // true = best-fit loop point (small seam), still fine to loop
          "trigger": "walk", // walk | idle | state | static  (how the game fires it)
          "inputsUsed": ["walkAnimationPos", "walkAnimationSpeed"],
          "bones": [
            {
              "bone": "right_hind_leg", // matches a mob-models.json part `name`
              "rotation": [
                // optional channel
                { "t": 0, "value": [1.4, 0, 0], "interp": "linear" },
                { "t": 0.2375, "value": [-1.4, 0, 0], "interp": "linear" },
              ],
              // "position": [...], "scale": [...]  // also optional
            },
          ],
          "warnings": [],
        },
      ],
    },
  ],
}
```

## 2. The one thing to know about the values

**Every keyframe `value` is an absolute LOCAL transform in the exact same space as
the matching bone's base pose in `mob-models.json`.** No conversion, no adding the
base pose — it's already baked in.

| channel    | value                                                                    | same as mob-models field |
| ---------- | ------------------------------------------------------------------------ | ------------------------ |
| `rotation` | Euler `[xRot, yRot, zRot]` in **radians**, Minecraft `rotationZYX` order | `part.rotation`          |
| `position` | `[x, y, z]` in **model units** (1/16 block)                              | `part.pivot`             |
| `scale`    | `[x, y, z]` per-axis factor (1 = unscaled)                               | `part.scale ?? [1,1,1]`  |

Consequences:

- **Bone names match `mob-models.json` part names** — look them up in the same
  bone map you built for rendering.
- **A channel that's absent stays at the base pose.** A clip that only rotates a
  bone leaves that bone's position/scale at rest. So each frame: reset every bone
  to its base pose, then apply the clip's channels (this mirrors vanilla
  `resetPose()` + `setupAnim()`).
- **`keyframe` and `baked` clips use the identical format** — handle them the same way.
- Because the values are in your existing base-pose space, **apply them with the same
  setter you already use for `mob-models.json`** — that's the safest way to stay
  pixel-accurate. Do not re-apply the base pose on top.

## 3. Join with the mob profiles

`mob-profiles.json`, `mob-models.json`, and `mob-animations.json` all key on the same
`id` / `localId`:

```js
const profiles = await fetch(`/minecraft-data/${v}/mob-profiles.json`).then((r) => r.json());
const models = await fetch(`/minecraft-data/${v}/mob-models.json`).then((r) => r.json());
const anims = await fetch(`/minecraft-data/${v}/mob-animations.json`).then((r) => r.json());

const animByLocalId = new Map(anims.mobs.map((m) => [m.localId, m]));
// in the profile view:
const anim = animByLocalId.get(profile.localId); // may be undefined for a few mobs
```

If `anim` is missing or `anim.status === "unresolved"` (a handful of complex mobs —
blaze, ender dragon, illagers, wolf, …), just render the static model as today.

## 4. Playing a clip (framework-agnostic)

You already have, from rendering `mob-models.json`, a map of bone name → your scene
object, plus a `setBonePose(object, part)` that applies a part's pivot/rotation/scale.
Reuse them:

```js
// interpolate one channel track at time t (seconds).
// NOTE: the segment between keyframe i and i+1 uses keyframe[i+1].interp,
// matching vanilla KeyframeAnimation (it reads nextFrame.interpolation()).
function sampleTrack(keyframes, t) {
  if (t <= keyframes[0].t) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (t >= last.t) return last.value;
  let i = 0;
  while (keyframes[i + 1].t < t) i++;
  const a = keyframes[i],
    b = keyframes[i + 1];
  const alpha = (t - a.t) / (b.t - a.t || 1);
  if (b.interp === "catmullrom") {
    const p0 = keyframes[Math.max(0, i - 1)].value;
    const p3 = keyframes[Math.min(keyframes.length - 1, i + 2)].value;
    return [0, 1, 2].map((k) => catmullRom(alpha, p0[k], a.value[k], b.value[k], p3[k]));
  }
  return [0, 1, 2].map((k) => a.value[k] + (b.value[k] - a.value[k]) * alpha); // linear
}

function catmullRom(t, p0, p1, p2, p3) {
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - 3 * p2 + p3 - p0) * t * t * t);
}

// call once per animation frame
function applyClip(boneObjects, basePoses, clip, elapsedSeconds) {
  const t = clip.loop ? elapsedSeconds % clip.lengthSeconds : Math.min(elapsedSeconds, clip.lengthSeconds);

  // 1) reset to rest — bones/channels the clip doesn't touch stay at base pose
  for (const [name, obj] of boneObjects) setBonePose(obj, basePoses.get(name));

  // 2) overlay the clip's absolute local transforms
  for (const track of clip.bones) {
    const obj = boneObjects.get(track.bone);
    if (!obj) continue;
    if (track.rotation) setBoneRotation(obj, sampleTrack(track.rotation, t)); // your ZYX-radian setter
    if (track.position) setBonePosition(obj, sampleTrack(track.position, t)); // your 1/16-unit setter
    if (track.scale) setBoneScale(obj, sampleTrack(track.scale, t));
  }
}
```

`setBoneRotation` / `setBonePosition` / `setBoneScale` are whatever you already use to
apply a base-pose part — the animation values slot straight in.

## 5. Playing a clip with a three.js `AnimationMixer` (optional)

If you'd rather use three.js' built-in mixer, build one `AnimationClip` per clip. The
only thing to get right is the **rotation Euler order — Minecraft is `ZYX`** (or reuse
whatever order your base pose already uses):

```js
import * as THREE from "three";

function toAnimationClip(clip, boneUuidByName) {
  const tracks = [];
  for (const b of clip.bones) {
    const uuid = boneUuidByName.get(b.bone);
    if (!uuid) continue;

    if (b.rotation) {
      const times = b.rotation.map((k) => k.t);
      const quats = [];
      const e = new THREE.Euler(),
        q = new THREE.Quaternion();
      for (const k of b.rotation) {
        e.set(k.value[0], k.value[1], k.value[2], "ZYX"); // match Minecraft ModelPart.rotationZYX
        q.setFromEuler(e);
        quats.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${uuid}.quaternion`, times, quats));
    }
    if (b.position) {
      // divide by 16 IF your bones live in block units; drop it if they use model units
      const times = b.position.map((k) => k.t);
      const vals = b.position.flatMap((k) => [k.value[0] / 16, k.value[1] / 16, k.value[2] / 16]);
      tracks.push(new THREE.VectorKeyframeTrack(`${uuid}.position`, times, vals));
    }
    if (b.scale) {
      const times = b.scale.map((k) => k.t);
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${uuid}.scale`,
          times,
          b.scale.flatMap((k) => k.value),
        ),
      );
    }
  }
  const three = new THREE.AnimationClip(clip.name, clip.lengthSeconds, tracks);
  return three;
}

// usage
const mixer = new THREE.AnimationMixer(mobRoot);
const action = mixer.clipAction(toAnimationClip(clip, boneUuidByName));
action.setLoop(clip.loop ? THREE.LoopRepeat : THREE.LoopOnce).play();
// in your render loop: mixer.update(deltaSeconds)
```

Note three.js `InterpolateSmooth` is not identical to Minecraft's Catmull-Rom; if you
need exact parity on the (few) Catmull-Rom clips, prefer the §4 sampler. Most Java
Edition clips are `linear`, and all `baked` clips are `linear`.

## 6. UX suggestions for the profile viewer

- **Autoplay `idle`** if present, else the first `baked` clip, else a looping
  `keyframe` clip. Fall back to the static pose for `unresolved` mobs.
- **Clip picker**: list `clip.name` (group by `trigger`: locomotion `walk`, resting
  `idle`, and one-shot `state` clips like `croak` / `emerge` / `attack`). One-shot
  clips usually have `loop:false` — play once on click.
- `approximateLoop: true` means the loop point is a best fit (a tiny seam on subtle
  idle bobs). It's fine to loop; optionally cross-fade ~0.1 s at the seam.
- `baked` `walk` isolates the locomotion cycle — the idle head/arm bob (driven by
  `ageInTicks`) is frozen in it and lives in the separate `idle` clip. Cross-fade
  between `idle` and `walk` for a natural transition.

## 7. What this data does not cover (show, don't fake)

World-space locomotion (pathfinding is server AI) and AI-driven _triggers_ (when a frog
decides to croak) are not animation and aren't included — expose each clip with
play/loop controls instead. A few renderer-level transforms (baby scaling, death flip,
squid body rotation) are generic and belong in the viewer, not the dataset.
