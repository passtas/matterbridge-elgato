/**
 * What the mocked models answer with. Every value here is synthetic but has the
 * shape of a real capture, see test/fixtures and docs/elgato-protocol.md §3.
 */

import type {
  AccessoryInfo,
  BatteryInfo,
  LightState,
  LightsSettings,
} from "../src/elgato/types.ts";

export type MockModel = "key-light-air" | "light-strip" | "key-light-mini";

export interface MockModelProfile {
  info: AccessoryInfo;
  settings: LightsSettings;
  /** mDNS TXT record, as `bonjour-service` publishes it. */
  txt: Record<string, string>;
  light: LightState;
  /** `GET /elgato/battery-info`; a model without it answers that path with 404. */
  battery?: BatteryInfo;
}

export const MOCK_MODELS: Record<MockModel, MockModelProfile> = {
  "key-light-air": {
    info: {
      productName: "Elgato Key Light Air",
      hardwareBoardType: 200,
      hardwareRevision: "1",
      macAddress: "3C:6A:9D:00:00:01",
      firmwareBuildNumber: 222,
      firmwareVersion: "1.0.3",
      serialNumber: "CW33J1A00001",
      displayName: "Elgato Key Light Air 1A2B",
      features: ["lights"],
      "wifi-info": { ssid: "Example Wi-Fi", frequencyMHz: 2400, rssi: -38 },
    },
    settings: {
      powerOnBehavior: 1,
      powerOnBrightness: 20,
      powerOnTemperature: 213,
      switchOnDurationMs: 100,
      switchOffDurationMs: 300,
      colorChangeDurationMs: 100,
    },
    txt: {
      pv: "1.0",
      md: "Elgato Key Light Air 20LAB9901",
      id: "3C:6A:9D:00:00:01",
      dt: "200",
      mf: "Elgato",
    },
    light: { on: 1, brightness: 43, temperature: 221 },
  },
  "light-strip": {
    info: {
      productName: "Elgato Light Strip",
      hardwareBoardType: 70,
      hardwareRevision: "1",
      macAddress: "3C:6A:9D:00:00:02",
      firmwareBuildNumber: 233,
      firmwareVersion: "1.0.4",
      serialNumber: "EW52J1A00002",
      displayName: "Elgato Light Strip 3C4D",
      features: ["lights"],
      "wifi-info": { ssid: "Example Wi-Fi", frequencyMHz: 2400, rssi: -46 },
    },
    settings: {
      powerOnBehavior: 1,
      powerOnHue: 40.0,
      powerOnSaturation: 15.0,
      powerOnBrightness: 40,
      switchOnDurationMs: 150,
      switchOffDurationMs: 400,
      colorChangeDurationMs: 150,
    },
    txt: {
      pv: "1.0",
      // `id` deliberately differs from the MAC, as it does on the real Strip.
      md: "Elgato Light Strip 20LAA9901",
      id: "01:C4:63:00:00:02",
      dt: "70",
      mf: "Elgato",
    },
    light: { on: 1, hue: 200.0, saturation: 100.0, brightness: 50 },
  },
  // The only model with a battery. Same CCT schema and PUT semantics as the Key Light
  // Air; `lights/settings` gains a `battery` block. Matches test/fixtures/key-light-mini-*.
  "key-light-mini": {
    info: {
      productName: "Elgato Key Light Mini",
      hardwareBoardType: 202,
      hardwareRevision: "1",
      macAddress: "3C:6A:9D:00:00:03",
      firmwareBuildNumber: 240,
      firmwareVersion: "1.0.4",
      serialNumber: "CW43K1A00003",
      displayName: "Elgato Key Light Mini 7A8B",
      // No "battery" here on the real Mini either: probe battery-info instead.
      features: ["lights"],
      "wifi-info": { ssid: "Example Wi-Fi", frequencyMHz: 2400, rssi: -52 },
    },
    settings: {
      powerOnBehavior: 1,
      powerOnBrightness: 20,
      powerOnTemperature: 213,
      switchOnDurationMs: 100,
      switchOffDurationMs: 300,
      colorChangeDurationMs: 100,
      battery: {
        energySaving: {
          enable: 0,
          minimumBatteryLevel: 15.0,
          disableWifi: 0,
          adjustBrightness: { enable: 0, brightness: 10.0 },
        },
        bypass: 0,
      },
    },
    txt: {
      pv: "1.0",
      md: "Elgato Key Light Mini 20LAD9901",
      id: "3C:6A:9D:00:00:03",
      dt: "202",
      mf: "Elgato",
    },
    light: { on: 1, brightness: 30, temperature: 200 },
    battery: {
      powerSource: 1,
      level: 78.57,
      status: 2,
      currentBatteryVoltage: 3860,
      inputChargeVoltage: 4208,
      inputChargeCurrent: 3008,
    },
  },
};

/** Give the Strip mock a running scene, matching test/fixtures/light-strip-lights-scene.json. */
export const RAINBOW_SCENE = {
  on: 1,
  id: "com.corsair.cc.scene.rainbow",
  name: "Rainbow",
  brightness: 98.0,
  numberOfSceneElements: 6,
  scene: [0, 60, 120, 180, 240, 300].map((hue) => ({
    hue,
    saturation: 100.0,
    brightness: 100.0,
    durationMs: 2000,
    transitionMs: 10000,
  })),
} satisfies LightState;
