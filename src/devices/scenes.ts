/**
 * Light Strip scene cache (docs/elgato-protocol.md §8).
 *
 * A scene lives only in the strip's volatile state: switching the light off destroys
 * it, and the firmware cannot list scenes back. The only way to put one back is to
 * re-send the object we saw on a poll, so the last one seen is cached per serial and
 * persisted, and an off/on cycle replays it. With `preserveSceneOnOff` the off sends
 * it too, with `on: 0`, so the strip parks with the scene intact (addendum).
 */

import type { SceneLightState } from "../elgato/types.ts";

/** Where the cached scene is kept between restarts. Implemented by the platform. */
export interface SceneStore {
  load(serial: string): SceneLightState | undefined;
  save(serial: string, scene: SceneLightState): void;
}

/** Rebuild the body the device wants to re-enter a scene. Writing it powers the light on. */
export const sceneToPatch = (scene: SceneLightState): SceneLightState => ({
  on: 1,
  id: scene.id,
  name: scene.name,
  brightness: scene.brightness ?? 100,
  numberOfSceneElements: scene.scene.length,
  scene: scene.scene,
});

/** Same scene for storage purposes: everything `sceneToPatch` sends except `on`. */
export const sameScene = (a: SceneLightState, b: SceneLightState): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.brightness === b.brightness &&
  JSON.stringify(a.scene) === JSON.stringify(b.scene);
