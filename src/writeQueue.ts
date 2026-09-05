/**
 * Per-device serialized write queue with coalescing.
 *
 * The Elgato HTTP server is effectively single-threaded: five concurrent GETs to a
 * Key Light Air came back as a 40 ms ramp (docs/elgato-protocol.md §2). So there is
 * never more than one PUT in flight per device, and anything that arrives while a
 * PUT is running is merged into a single follow-up write, latest state wins.
 */

import type { LightPatch, LightsResponse } from "./elgato/types.ts";

const SCENE_KEYS = ["id", "name", "numberOfSceneElements", "scene"] as const;

const stripScene = (patch: LightPatch): void => {
  for (const key of SCENE_KEYS) delete patch[key];
};

/**
 * Merge `next` into `current` honoring the device's mode exclusivity:
 * `temperature` must never travel in the same body as `hue`/`saturation`, and a
 * color/level write destroys a running scene anyway (docs/elgato-protocol.md §8, §9).
 */
export const mergePatch = (current: LightPatch, next: LightPatch): LightPatch => {
  // A scene write replaces the whole body. The device applies it as one unit and powers on.
  if (next.scene !== undefined) return { ...next };

  const merged: LightPatch = { ...current };
  if (next.hue !== undefined || next.saturation !== undefined) {
    delete merged.temperature;
    stripScene(merged);
  }
  if (next.temperature !== undefined) {
    delete merged.hue;
    delete merged.saturation;
    stripScene(merged);
  }
  return Object.assign(merged, next);
};

interface Waiter {
  resolve: (response: LightsResponse) => void;
  reject: (error: unknown) => void;
}

export class WriteQueue {
  #pending: LightPatch | undefined;
  #waiters: Waiter[] = [];
  #running: Promise<void> | undefined;
  readonly #write: (patch: LightPatch) => Promise<LightsResponse>;

  constructor(write: (patch: LightPatch) => Promise<LightsResponse>) {
    this.#write = write;
  }

  /** True when nothing is queued and nothing is in flight. */
  get idle(): boolean {
    return this.#pending === undefined && this.#running === undefined;
  }

  push(patch: LightPatch): Promise<LightsResponse> {
    this.#pending = this.#pending === undefined ? { ...patch } : mergePatch(this.#pending, patch);
    const promise = new Promise<LightsResponse>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
    this.#running ??= this.#drain();
    return promise;
  }

  /** Resolves once the queue has emptied. Rejections are delivered to `push` callers. */
  async settled(): Promise<void> {
    await this.#running;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending !== undefined) {
        const patch = this.#pending;
        const waiters = this.#waiters;
        this.#pending = undefined;
        this.#waiters = [];
        try {
          const response = await this.#write(patch);
          for (const waiter of waiters) waiter.resolve(response);
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally {
      this.#running = undefined;
    }
  }
}
