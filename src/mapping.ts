/**
 * Pure conversions between the Elgato wire values and Matter cluster attributes,
 * plus the client-side clamps. Formulas and ranges: docs/elgato-protocol.md §6, §9.
 *
 * Neither firmware clamps: the Key Light Air stores nonsense verbatim
 * (`temperature: 5000`) and the Light Strip answers 400. Clamping here is what
 * makes the two models behave identically.
 */

import type { LightCapability, LightState, SceneLightState } from "./elgato/types.ts";

/** Elgato brightness we are willing to emit. 0 is legal but leaves the light on at zero output. */
export const MIN_BRIGHTNESS = 3;
export const MAX_BRIGHTNESS = 100;
/** Elgato color temperature range, in mireds (about 6993 K down to 2907 K). */
export const MIN_MIREDS = 143;
export const MAX_MIREDS = 344;
/** Matter LevelControl reserves 0. */
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 254;
/** Matter encodes a full 360 degree turn, and 0 to 100 % saturation, in 0 to 254. */
export const MAX_HUE = 254;
export const MAX_SATURATION = 254;

export const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

/** Elgato brightness (3 to 100) to Matter CurrentLevel (1 to 254). Every value round-trips. */
export const toMatterLevel = (brightness: number): number =>
  clamp(
    Math.round(1 + ((clamp(brightness, MIN_BRIGHTNESS, MAX_BRIGHTNESS) - 3) * 253) / 97),
    MIN_LEVEL,
    MAX_LEVEL,
  );

/** Matter CurrentLevel to Elgato brightness. Lossy by construction: 254 levels, 98 values. */
export const toElgatoBrightness = (level: number): number =>
  clamp(
    Math.round(3 + ((clamp(level, MIN_LEVEL, MAX_LEVEL) - 1) * 97) / 253),
    MIN_BRIGHTNESS,
    MAX_BRIGHTNESS,
  );

/** Mireds map 1:1 between Elgato and Matter; only the clamp differs. */
export const toMatterMireds = (temperature: number): number =>
  clamp(Math.round(temperature), MIN_MIREDS, MAX_MIREDS);

export const toElgatoTemperature = (mireds: number): number =>
  clamp(Math.round(mireds), MIN_MIREDS, MAX_MIREDS);

/**
 * Elgato hue (0 to 360) to Matter CurrentHue (0 to 254).
 * The `% 360` matters: the Strip stores `hue: 360.0` verbatim instead of folding it
 * to 0, and a naive scale would map red to the wrong end of the wheel.
 */
export const toMatterHue = (hue: number): number =>
  clamp(Math.round((clamp(hue, 0, 360) % 360) * (254 / 360)), 0, MAX_HUE);

/**
 * Matter CurrentHue (0 to 254) to Elgato hue degrees.
 *
 * docs/elgato-protocol.md §9 rounds to one decimal, but the Light Strip firmware
 * truncates the fraction (verified 2026-09-04: PUT `hue: 123.7` stores `123.0`,
 * PUT `saturation: 50.5` stores `50.0`). Emitting whole degrees therefore costs
 * nothing and makes the round-trip exact instead of drifting a step.
 */
export const toElgatoHue = (hue: number): number =>
  Math.round(clamp(hue, 0, MAX_HUE) * (360 / 254)) % 360;

export const toMatterSaturation = (saturation: number): number =>
  clamp(Math.round(clamp(saturation, 0, 100) * (254 / 100)), 0, MAX_SATURATION);

/** Matter CurrentSaturation to Elgato percent. Whole numbers, see `toElgatoHue`. */
export const toElgatoSaturation = (saturation: number): number =>
  Math.round(clamp(saturation, 0, MAX_SATURATION) * (100 / 254));

/**
 * HSV saturation of an RGB triple, as a percentage.
 *
 * matterbridge ships `rgbColorToHslColor`, but HSL saturation is not usable here:
 * a near-white like `rgb(250,246,255)` is 100 % saturated in HSL (at lightness 98 %),
 * and the Elgato strip has a separate `brightness` field, so it is an HSV device.
 * Sending the HSL saturation would paint every white a vivid color. HSL and HSV
 * agree on hue, so only saturation is recomputed.
 */
export const hsvSaturation = (rgb: { r: number; g: number; b: number }): number => {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max === 0 ? 0 : ((max - min) / max) * 100;
};

/** True when the light object carries a full, replayable scene. */
export const isSceneState = (light: LightState): light is SceneLightState =>
  Array.isArray(light.scene) && light.scene.length > 0 && typeof light.id === "string";

/**
 * Capability probe. Never switch on the mDNS `dt` code alone: the table below is a
 * naming hint, and an unlisted model still has to work (docs/elgato-protocol.md §1).
 */
export const detectCapability = (light: LightState): LightCapability =>
  light.temperature !== undefined ? "ct" : "color";

/**
 * `dt` / `hardwareBoardType` to a friendly model name. A logging and labeling hint
 * only, never a capability check. Codes from frenck/python-elgato `BOARD_TYPES` plus
 * the two verified here (200, 70).
 */
export const DEVICE_TYPE_NAMES: Readonly<Record<number, string>> = {
  53: "Elgato Key Light",
  70: "Elgato Light Strip",
  200: "Elgato Key Light Air",
  201: "Elgato Ring Light",
  202: "Elgato Key Light Mini",
  205: "Elgato Key Light MK.2",
  206: "Elgato Light Strip Pro",
  210: "Elgato Key Light Neo",
  /** Speaks TLS rather than the HTTP API, see src/elgato/unsupported.ts. */
  214: "Elgato Key Light Air MK.2",
};

export const deviceTypeName = (dt: number | undefined): string =>
  (dt !== undefined && DEVICE_TYPE_NAMES[dt]) || "Elgato light";
