/**
 * Wire types for the Elgato local HTTP API (port 9123, no auth).
 * Shapes verified live 2026-09-04, see docs/elgato-protocol.md §3 and §4.
 */

/** `GET /elgato/accessory-info`. */
export interface AccessoryInfo {
  productName: string;
  hardwareBoardType: number;
  /** String `"1"` on both verified devices, a number in some prior art, so parse loosely. */
  hardwareRevision: string | number;
  macAddress: string;
  firmwareBuildNumber: number;
  firmwareVersion: string;
  serialNumber: string;
  /** May be `""` on some firmwares; fall back to the mDNS instance name. */
  displayName: string;
  features: string[];
  "wifi-info"?: { ssid: string; frequencyMHz: number; rssi: number };
}

/** One keyframe of a Light Strip scene (schema 4c). */
export interface SceneElement {
  hue: number;
  saturation: number;
  brightness: number;
  durationMs: number;
  transitionMs: number;
}

/**
 * A single entry of `lights[]`. Three schemas share this type:
 * 4a CCT (`temperature`), 4b HSV (`hue`/`saturation`), 4c scene (`scene`).
 * A Light Strip flips between 4b and 4c at runtime, so re-detect on every poll.
 */
export interface LightState {
  /** Integer 0/1, never a JSON boolean. */
  on: number;
  brightness?: number;
  /** Mireds, usable range 143 to 344. Absent on color-only models. */
  temperature?: number;
  /** Degrees 0 to 360 (float). */
  hue?: number;
  /** Percent 0 to 100 (float). */
  saturation?: number;
  /** Scene id, e.g. `com.corsair.cc.scene.rainbow`. */
  id?: string;
  /** Scene label, e.g. `Rainbow`. */
  name?: string;
  numberOfSceneElements?: number;
  scene?: SceneElement[];
}

/** A scene-mode light object, narrowed so `scene` is guaranteed. */
export type SceneLightState = LightState & {
  id: string;
  name: string;
  numberOfSceneElements: number;
  scene: SceneElement[];
};

/** `GET`/`PUT /elgato/lights` response envelope. */
export interface LightsResponse {
  numberOfLights: number;
  lights: LightState[];
}

/** `GET /elgato/lights/settings`, the power-on defaults and device-side fade times. */
export interface LightsSettings {
  powerOnBehavior: number;
  powerOnBrightness?: number;
  powerOnTemperature?: number;
  powerOnHue?: number;
  powerOnSaturation?: number;
  switchOnDurationMs: number;
  switchOffDurationMs: number;
  colorChangeDurationMs: number;
  /**
   * Only on a light with a battery (the Key Light Mini). Read-only here: the plugin
   * never writes battery settings. `energySaving.disableWifi: 1` makes the light drop
   * off the network below `minimumBatteryLevel`. See docs/elgato-protocol.md §3.
   */
  battery?: {
    energySaving: {
      enable: number;
      minimumBatteryLevel: number;
      disableWifi: number;
      adjustBrightness: { enable: number; brightness: number };
    };
    bypass: number;
  };
}

/**
 * `GET /elgato/battery-info`, Key Light Mini only; every other model answers 404.
 * Live capture 2026-10-03 (fw 1.0.4 build 240), docs/elgato-protocol.md §3.
 */
export interface BatteryInfo {
  /** `1` power adapter / USB-C, `2` battery, `0` unknown. */
  powerSource: number;
  /** Charge in percent, fractional (`78.57`). */
  level: number;
  /** `0` not charging, `1` pre-charge, `2` fast charge, `3` complete. */
  status: number;
  /** Battery voltage, mV. */
  currentBatteryVoltage: number;
  /** USB-C input voltage, mV. */
  inputChargeVoltage: number;
  /** Charge current, mA. */
  inputChargeCurrent: number;
}

/** Body of a `PUT /elgato/lights`. Partial bodies are the intended usage. */
export type LightPatch = Partial<LightState>;

/** Error envelope returned by a bad request, and by `GET /` on the Strip with HTTP 200. */
export interface ElgatoErrorBody {
  errors: { message: string; code: number }[];
}

/** What `GET /elgato/lights` tells us the device can do. */
export type LightCapability = "ct" | "color";

/** A device seen on mDNS `_elg._tcp`. */
export interface DiscoveredService {
  /** mDNS instance name, e.g. `Elgato Key Light Air 1A2B`. */
  instanceName: string;
  host: string;
  /**
   * The `.local` name from the SRV record, so the platform can ask mDNS for the
   * light's address again when it stops answering at the one it has.
   */
  hostname?: string;
  port: number;
  txt: {
    /** Neither a reliable MAC nor a stable key, see docs/elgato-protocol.md §1. */
    id?: string;
    /** Model and SKU, e.g. `Elgato Key Light Air 20LAB9901`. */
    md?: string;
    /** Device type, same value as `hardwareBoardType`, e.g. `200`. */
    dt?: string;
    mf?: string;
    pv?: string;
    /**
     * Only the MK.2 generation publishes this (`tls=CERT_1_VER_EN`). Its port 9123
     * speaks mutual-TLS WebSocket instead of plain HTTP, see src/elgato/unsupported.ts.
     */
    tls?: string;
  };
}
