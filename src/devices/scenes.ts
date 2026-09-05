/**
 * Light Strip scene cache (docs/elgato-protocol.md §8).
 *
 * A scene lives only in the strip's volatile state: switching the light off destroys
 * it, and the firmware cannot list scenes back. The only way to put one back is to
 * re-send the object we saw on a poll, so the last one seen is cached per serial and
 * persisted, and an off/on cycle replays it.
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
