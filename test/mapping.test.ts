import { describe, expect, it } from "vitest";

import {
  DEVICE_TYPE_NAMES,
  clamp,
  detectCapability,
  deviceTypeName,
  hsvSaturation,
  isSceneState,
  toElgatoBrightness,
  toElgatoHue,
  toElgatoSaturation,
  toElgatoTemperature,
  toMatterHue,
  toMatterLevel,
  toMatterMireds,
  toMatterSaturation,
} from "../src/mapping.ts";

import { light } from "./helpers/fixtures.ts";

const ctLight = light("key-light-air-lights");
const hsvLight = light("light-strip-lights-hsv");
const sceneLight = light("light-strip-lights-scene");

describe("clamp", () => {
  it("clamps to the closed interval", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe("brightness ⇄ level", () => {
  it("round-trips every usable Elgato brightness exactly", () => {
    for (let brightness = 3; brightness <= 100; brightness += 1) {
      expect(toElgatoBrightness(toMatterLevel(brightness))).toBe(brightness);
    }
  });

  it("anchors the endpoints", () => {
    expect(toMatterLevel(3)).toBe(1);
    expect(toMatterLevel(100)).toBe(254);
    expect(toMatterLevel(50)).toBe(124);
    expect(toMatterLevel(43)).toBe(105);
    expect(toElgatoBrightness(1)).toBe(3);
    expect(toElgatoBrightness(254)).toBe(100);
  });

  it("never emits brightness 0 and never a level outside 1–254", () => {
    for (let level = -10; level <= 300; level += 1) {
      const brightness = toElgatoBrightness(level);
      expect(brightness).toBeGreaterThanOrEqual(3);
      expect(brightness).toBeLessThanOrEqual(100);
    }
    for (let brightness = -10; brightness <= 200; brightness += 1) {
      const level = toMatterLevel(brightness);
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(254);
    }
  });

  it("is idempotent under quantisation", () => {
    for (let level = 1; level <= 254; level += 1) {
      const once = toMatterLevel(toElgatoBrightness(level));
      const twice = toMatterLevel(toElgatoBrightness(once));
      expect(twice).toBe(once);
    }
  });
});

describe("color temperature", () => {
  it("maps mireds 1:1 inside the Elgato range", () => {
    for (let mireds = 143; mireds <= 344; mireds += 1) {
      expect(toMatterMireds(mireds)).toBe(mireds);
      expect(toElgatoTemperature(mireds)).toBe(mireds);
    }
  });

  it("clamps outside the physical range in both directions", () => {
    expect(toElgatoTemperature(100)).toBe(143);
    expect(toElgatoTemperature(5000)).toBe(344);
    expect(toMatterMireds(0)).toBe(143);
    expect(toMatterMireds(400)).toBe(344);
  });
});

describe("hue", () => {
  it("folds 360 to 0 instead of wrapping to the wrong end of the wheel", () => {
    expect(toMatterHue(360)).toBe(0);
    expect(toMatterHue(0)).toBe(0);
    expect(toElgatoHue(0)).toBe(0);
    // The device would store 360 verbatim, so never emit it.
    expect(toElgatoHue(254)).toBe(0);
  });

  it("round-trips every integer degree within one Matter step", () => {
    for (let degrees = 0; degrees < 360; degrees += 1) {
      const back = toElgatoHue(toMatterHue(degrees));
      expect(
        Math.min(Math.abs(back - degrees), 360 - Math.abs(back - degrees)),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("round-trips every Matter hue exactly, because the firmware truncates fractions", () => {
    for (let hue = 0; hue < 254; hue += 1) {
      expect(toMatterHue(toElgatoHue(hue))).toBe(hue);
    }
  });

  it("emits whole degrees near the documented sample", () => {
    expect(toMatterHue(200)).toBe(141);
    expect(toElgatoHue(141)).toBe(200);
  });

  it("clamps out-of-range input", () => {
    expect(toMatterHue(-10)).toBe(0);
    expect(toMatterHue(1000)).toBe(0);
    expect(toElgatoHue(300)).toBe(0);
  });
});

describe("saturation", () => {
  it("round-trips every integer percent exactly", () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      expect(toElgatoSaturation(toMatterSaturation(percent))).toBe(percent);
    }
  });

  it("matches the documented samples", () => {
    expect(toMatterSaturation(100)).toBe(254);
    expect(toMatterSaturation(15)).toBe(38);
    expect(toMatterSaturation(50)).toBe(127);
    expect(toElgatoSaturation(254)).toBe(100);
    expect(toElgatoSaturation(0)).toBe(0);
  });

  it("clamps out-of-range input", () => {
    expect(toMatterSaturation(101)).toBe(254);
    expect(toMatterSaturation(-1)).toBe(0);
    expect(toElgatoSaturation(300)).toBe(100);
  });
});

describe("hsvSaturation", () => {
  it("reports a near-white as almost unsaturated, unlike HSL", () => {
    // rgbColorToHslColor calls this 100 % saturated with 98 % lightness.
    expect(hsvSaturation({ r: 250, g: 246, b: 255 })).toBeCloseTo(3.5, 1);
  });

  it("reports a warm white as partly saturated and a pure hue as fully saturated", () => {
    expect(hsvSaturation({ r: 255, g: 167, b: 88 })).toBeCloseTo(65.5, 1);
    expect(hsvSaturation({ r: 255, g: 0, b: 0 })).toBe(100);
  });

  it("handles black without dividing by zero", () => {
    expect(hsvSaturation({ r: 0, g: 0, b: 0 })).toBe(0);
  });
});

describe("schema detection", () => {
  it("probes capability from the shape, not from dt", () => {
    expect(detectCapability(ctLight)).toBe("ct");
    expect(detectCapability(hsvLight)).toBe("color");
    expect(detectCapability(sceneLight)).toBe("color");
  });

  it("narrows a replayable scene", () => {
    expect(isSceneState(sceneLight)).toBe(true);
    expect(isSceneState(hsvLight)).toBe(false);
    expect(isSceneState({ on: 1, scene: [], id: "x" })).toBe(false);
  });
});

describe("device type names", () => {
  it("knows the verified codes", () => {
    expect(DEVICE_TYPE_NAMES[200]).toBe("Elgato Key Light Air");
    expect(DEVICE_TYPE_NAMES[70]).toBe("Elgato Light Strip");
    expect(DEVICE_TYPE_NAMES[53]).toBe("Elgato Key Light");
    expect(DEVICE_TYPE_NAMES[214]).toBe("Elgato Key Light Air MK.2");
    expect(deviceTypeName(200)).toBe("Elgato Key Light Air");
    expect(deviceTypeName(214)).toBe("Elgato Key Light Air MK.2");
  });

  it("falls back for unknown and missing codes", () => {
    expect(deviceTypeName(999)).toBe("Elgato light");
    expect(deviceTypeName(undefined)).toBe("Elgato light");
  });
});
