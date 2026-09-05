import { describe, expect, it, vi } from "vitest";

import type { LightPatch, LightsResponse } from "../src/elgato/types.ts";
import { WriteQueue, mergePatch } from "../src/writeQueue.ts";

import { light } from "./helpers/fixtures.ts";

const respond = (patch: LightPatch): LightsResponse => ({
  numberOfLights: 1,
  lights: [{ on: 1, ...patch }],
});

describe("mergePatch", () => {
  it("lets the newer value win", () => {
    expect(mergePatch({ brightness: 10 }, { brightness: 90 })).toEqual({ brightness: 90 });
  });

  it("drops temperature when color arrives, and vice versa", () => {
    expect(mergePatch({ temperature: 200 }, { hue: 90 })).toEqual({ hue: 90 });
    expect(mergePatch({ hue: 90, saturation: 50 }, { temperature: 200 })).toEqual({
      temperature: 200,
    });
  });

  it("keeps on/off and brightness across a color change", () => {
    expect(mergePatch({ on: 1, brightness: 40 }, { hue: 90 })).toEqual({
      on: 1,
      brightness: 40,
      hue: 90,
    });
  });

  it("replaces the whole body for a scene write", () => {
    const scene = light("light-strip-lights-scene");
    expect(mergePatch({ on: 1, hue: 90, brightness: 40 }, scene)).toEqual(scene);
  });

  it("strips scene keys when a color or temperature write follows a scene", () => {
    const scene = light("light-strip-lights-scene");
    const merged = mergePatch(scene, { hue: 90 });
    expect(merged).not.toHaveProperty("scene");
    expect(merged).not.toHaveProperty("id");
    expect(merged).not.toHaveProperty("numberOfSceneElements");
    expect(merged.hue).toBe(90);
  });
});

describe("WriteQueue", () => {
  it("serializes writes and coalesces everything queued behind the one in flight", async () => {
    const seen: LightPatch[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = new WriteQueue(async (patch) => {
      seen.push(patch);
      if (seen.length === 1) await gate;
      return respond(patch);
    });

    expect(queue.idle).toBe(true);
    const first = queue.push({ brightness: 10 });
    const second = queue.push({ brightness: 20 });
    const third = queue.push({ brightness: 30, hue: 90 });
    expect(queue.idle).toBe(false);

    release?.();
    await Promise.all([first, second, third]);
    await queue.settled();

    // One write for the first patch, one for the coalesced remainder.
    expect(seen).toEqual([{ brightness: 10 }, { brightness: 30, hue: 90 }]);
    expect(queue.idle).toBe(true);
  });

  it("rejects every waiter of a failed write but keeps going", async () => {
    const write = vi
      .fn<(patch: LightPatch) => Promise<LightsResponse>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(async (patch) => respond(patch));
    const queue = new WriteQueue(write);

    await expect(queue.push({ on: 0 })).rejects.toThrow("boom");
    await expect(queue.push({ on: 1 })).resolves.toMatchObject({ numberOfLights: 1 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("hands the same PUT response to every caller coalesced into one write", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const queue = new WriteQueue(async (patch) => {
      calls += 1;
      if (calls === 1) await gate;
      return respond(patch);
    });

    const blocking = queue.push({ on: 1 });
    const a = queue.push({ brightness: 5 });
    const b = queue.push({ brightness: 6 });
    release?.();

    const [first, second, third] = await Promise.all([blocking, a, b]);
    expect(calls).toBe(2);
    expect(first.lights[0]?.brightness).toBeUndefined();
    expect(second).toBe(third);
    expect(third.lights[0]?.brightness).toBe(6);
  });
});
