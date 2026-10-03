import { PowerSource } from "matterbridge/matter/clusters";
import { describe, expect, it } from "vitest";

import type { BatteryInfo } from "../src/elgato/types.ts";
import {
  BAT_CHARGE_LEVEL,
  BAT_CHARGE_STATE,
  batteryUpdate,
  DEVICE_TYPE_NAMES,
  clamp,
  detectCapability,
  deviceTypeName,
  hsvSaturation,
  isSceneState,
  toElgatoBrightness,
  toElgatoHue,
  toElgatoSaturation,
  toBatChargeLevel,
  toBatChargeState,
  toElgatoTemperature,
  toMatterBatPercent,
  toMatterBatVoltage,
  toMatterHue,
  toMatterLevel,
  toMatterMireds,
  toMatterSaturation,
} from "../src/mapping.ts";

import { fixture, light } from "./helpers/fixtures.ts";

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

describe("battery (PowerSource)", () => {
  const battery = fixture<BatteryInfo>("key-light-mini-battery-info");

  it("uses the installed matter.js enum values", () => {
    expect(BAT_CHARGE_LEVEL).toEqual({
      Ok: PowerSource.BatChargeLevel.Ok,
      Warning: PowerSource.BatChargeLevel.Warning,
      Critical: PowerSource.BatChargeLevel.Critical,
    });
    expect(BAT_CHARGE_STATE).toEqual({
      Unknown: PowerSource.BatChargeState.Unknown,
      IsCharging: PowerSource.BatChargeState.IsCharging,
      IsAtFullCharge: PowerSource.BatChargeState.IsAtFullCharge,
      IsNotCharging: PowerSource.BatChargeState.IsNotCharging,
    });
  });

  it("maps the published Key Light Mini sample", () => {
    expect(toMatterBatPercent(battery.level)).toBe(157); // 78.57 %
    expect(toBatChargeLevel(battery.level)).toBe(PowerSource.BatChargeLevel.Ok);
    expect(toBatChargeState(battery.status)).toBe(PowerSource.BatChargeState.IsCharging);
    expect(toMatterBatVoltage(battery.currentBatteryVoltage)).toBe(3860);
  });

  it("reports batPercentRemaining in whole half-percents, never a fraction", () => {
    expect(toMatterBatPercent(78.57)).toBe(157);
    expect(toMatterBatPercent(96.05)).toBe(192); // the live 2026-10-03 reading
    expect(toMatterBatPercent(0)).toBe(0);
    expect(toMatterBatPercent(50)).toBe(100);
    expect(toMatterBatPercent(100)).toBe(200);
    for (let hundredths = 0; hundredths <= 10_000; hundredths += 1) {
      const value = toMatterBatPercent(hundredths / 100);
      expect(Number.isInteger(value)).toBe(true);
      // Within half a percent of the light's own figure.
      expect(Math.abs((value as number) / 2 - hundredths / 100)).toBeLessThanOrEqual(0.25);
    }
  });

  it("clamps batPercentRemaining to 0–200 and reports garbage as unknown", () => {
    expect(toMatterBatPercent(-3)).toBe(0);
    expect(toMatterBatPercent(100.4)).toBe(200);
    expect(toMatterBatPercent(150)).toBe(200);
    expect(toMatterBatPercent(Number.NaN)).toBeNull();
    expect(toMatterBatPercent(undefined)).toBeNull();
    expect(toMatterBatPercent("50")).toBeNull();
  });

  it("reports Warning below 20 % and Critical below 10 %", () => {
    expect(toBatChargeLevel(100)).toBe(PowerSource.BatChargeLevel.Ok);
    expect(toBatChargeLevel(20)).toBe(PowerSource.BatChargeLevel.Ok);
    expect(toBatChargeLevel(19.99)).toBe(PowerSource.BatChargeLevel.Warning);
    expect(toBatChargeLevel(15)).toBe(PowerSource.BatChargeLevel.Warning);
    expect(toBatChargeLevel(10)).toBe(PowerSource.BatChargeLevel.Warning);
    expect(toBatChargeLevel(9.99)).toBe(PowerSource.BatChargeLevel.Critical);
    expect(toBatChargeLevel(0)).toBe(PowerSource.BatChargeLevel.Critical);
    // No reading is no reason to raise an alarm.
    expect(toBatChargeLevel(undefined)).toBe(PowerSource.BatChargeLevel.Ok);
  });

  it("maps every documented charge status, and anything else to Unknown", () => {
    expect(toBatChargeState(0)).toBe(PowerSource.BatChargeState.IsNotCharging);
    expect(toBatChargeState(1)).toBe(PowerSource.BatChargeState.IsCharging);
    expect(toBatChargeState(2)).toBe(PowerSource.BatChargeState.IsCharging);
    expect(toBatChargeState(3)).toBe(PowerSource.BatChargeState.IsAtFullCharge);
    for (const odd of [4, -1, 2.5, "2", null, undefined]) {
      expect(toBatChargeState(odd)).toBe(PowerSource.BatChargeState.Unknown);
    }
  });

  it("passes the battery voltage through in mV", () => {
    expect(toMatterBatVoltage(4007)).toBe(4007);
    expect(toMatterBatVoltage(4007.6)).toBe(4008);
    expect(toMatterBatVoltage(-1)).toBeNull();
    expect(toMatterBatVoltage(undefined)).toBeNull();
  });
});

describe("battery hysteresis", () => {
  const { Ok, Warning, Critical } = BAT_CHARGE_LEVEL;
  const reading = (level: number, millivolts = 3997, status = 2) => ({
    level,
    status,
    currentBatteryVoltage: millivolts,
  });

  it("reports everything when nothing has been reported yet", () => {
    expect(
      batteryUpdate(
        { batPercentRemaining: null, batChargeLevel: -1, batVoltage: null },
        reading(96.15),
      ),
    ).toEqual({
      batPercentRemaining: 192,
      batChargeLevel: Ok,
      batChargeState: BAT_CHARGE_STATE.IsCharging,
      batVoltage: 3997,
    });
  });

  it("holds the percentage under a 1 % move and follows one of 1 % or more", () => {
    const reported = { batPercentRemaining: 192, batChargeLevel: Ok, batVoltage: 3997 };
    expect(batteryUpdate(reported, reading(95.7)).batPercentRemaining).toBeUndefined(); // 191
    expect(batteryUpdate(reported, reading(96.4)).batPercentRemaining).toBeUndefined(); // 193
    expect(batteryUpdate(reported, reading(96.0)).batPercentRemaining).toBeUndefined(); // 192
    expect(batteryUpdate(reported, reading(95.1)).batPercentRemaining).toBe(190);
    expect(batteryUpdate(reported, reading(94.65)).batPercentRemaining).toBe(189);
  });

  it("follows any percentage change that crosses a charge-level threshold", () => {
    // 20.5 % → 20.1 %: one half-percent step that stays Ok, so it is held.
    expect(
      batteryUpdate(
        { batPercentRemaining: 41, batChargeLevel: Ok, batVoltage: 3700 },
        reading(20.1),
      ).batPercentRemaining,
    ).toBeUndefined();
    // 10.5 % → 9.8 %: one half-percent step, but Warning → Critical.
    const atCritical = batteryUpdate(
      { batPercentRemaining: 21, batChargeLevel: Warning, batVoltage: 3600 },
      reading(9.8),
    );
    expect(atCritical).toMatchObject({ batPercentRemaining: 20, batChargeLevel: Critical });
    // 20.5 % → 19.9 %: one half-percent step, but Ok → Warning.
    const crossing = batteryUpdate(
      { batPercentRemaining: 41, batChargeLevel: Ok, batVoltage: 3700 },
      reading(19.9),
    );
    expect(crossing).toMatchObject({ batPercentRemaining: 40, batChargeLevel: Warning });
  });

  it("always reports reaching 0 % or 100 %", () => {
    expect(
      batteryUpdate(
        { batPercentRemaining: 199, batChargeLevel: Ok, batVoltage: 4100 },
        reading(100),
      ).batPercentRemaining,
    ).toBe(200);
    expect(
      batteryUpdate(
        { batPercentRemaining: 1, batChargeLevel: Critical, batVoltage: 3300 },
        reading(0.1),
      ).batPercentRemaining,
    ).toBe(0);
  });

  it("holds the voltage under 20 mV and follows a move of 20 mV or more", () => {
    const reported = { batPercentRemaining: 192, batChargeLevel: Ok, batVoltage: 3997 };
    expect(batteryUpdate(reported, reading(96.15, 3996)).batVoltage).toBeUndefined();
    expect(batteryUpdate(reported, reading(96.15, 4016)).batVoltage).toBeUndefined();
    expect(batteryUpdate(reported, reading(96.15, 4017)).batVoltage).toBe(4017);
    expect(batteryUpdate(reported, reading(96.15, 3977)).batVoltage).toBe(3977);
  });

  it("always passes charge state and level through, and keeps the last values on garbage", () => {
    const reported = { batPercentRemaining: 192, batChargeLevel: Ok, batVoltage: 3997 };
    expect(batteryUpdate(reported, reading(96.15, 3997, 0))).toEqual({
      batChargeLevel: Ok,
      batChargeState: BAT_CHARGE_STATE.IsNotCharging,
    });
    expect(batteryUpdate(reported, { status: 3 })).toEqual({
      batChargeLevel: Ok,
      batChargeState: BAT_CHARGE_STATE.IsAtFullCharge,
    });
  });
});
