/**
 * Live smoke test against two real lights on the LAN. It physically switches them,
 * so it is opt-in three times over: `ELGATO_LIVE=1`, plus `ELGATO_KEY_LIGHT_HOST`
 * and `ELGATO_LIGHT_STRIP_HOST` pointing at your own devices. No address is
 * hard-coded, and with any of the three unset the whole suite is skipped.
 *
 *   ELGATO_LIVE=1 ELGATO_KEY_LIGHT_HOST=192.168.1.50 \
 *   ELGATO_LIGHT_STRIP_HOST=192.168.1.51 npm run test:live
 *
 * Both devices are captured before the run and restored byte-identically afterwards,
 * scene included.
 */

import type { MatterbridgeEndpoint, PlatformConfig } from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import { ColorControl, LevelControl, OnOff } from "matterbridge/matter/clusters";
import {
  addMatterbridge,
  createServerNode,
  createTestEnvironment,
  getMatterbridge,
  log,
  setupTest,
  startServerNode,
  stopServerNode,
} from "matterbridge/test-utils/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ElgatoClient } from "../src/elgato/client.ts";
import type { LightStripDevice } from "../src/devices/lightStrip.ts";
import { ElgatoPlatform } from "../src/index.ts";
import { isSceneState } from "../src/mapping.ts";
import type { LightState } from "../src/elgato/types.ts";

const KEY_LIGHT_HOST = process.env.ELGATO_KEY_LIGHT_HOST;
const STRIP_HOST = process.env.ELGATO_LIGHT_STRIP_HOST;
const LIVE = process.env.ELGATO_LIVE === "1" && !!KEY_LIGHT_HOST && !!STRIP_HOST;
const MATTER_TEST_PORT = 5562;

if (process.env.ELGATO_LIVE === "1" && !LIVE) {
  // Written straight to stderr: vitest drops module-level console output for a
  // suite it never runs, and this message is the whole point of that case.
  process.stderr.write(
    "live tests skipped: set ELGATO_KEY_LIGHT_HOST and ELGATO_LIGHT_STRIP_HOST to the " +
      "addresses of your own Key Light and Light Strip (see README > Live tests).\n",
  );
}

const keyLightClient = new ElgatoClient(KEY_LIGHT_HOST ?? "", { timeoutMs: 4000 });
const stripClient = new ElgatoClient(STRIP_HOST ?? "", { timeoutMs: 4000 });

// Serials are read off the devices themselves, so nobody's real serial lives in git.
let keyLightSerial: string;
let stripSerial: string;

let platform: ElgatoPlatform;
let keyLight: MatterbridgeEndpoint;
let strip: MatterbridgeEndpoint;
let keyLightBefore: LightState;
let stripBefore: LightState;

const readLight = async (client: ElgatoClient): Promise<LightState> => {
  const state = (await client.getLights()).lights[0];
  if (!state) throw new Error("no lights[0]");
  return state;
};

const restore = async (client: ElgatoClient, state: LightState): Promise<void> => {
  // One body: `on: 0` sent together with a scene object is honored and keeps the
  // scene, whereas a bare `{on: 0}` afterwards would destroy it (verified 2026-09-04).
  await client.putLights(state);
};

const command = async (
  endpoint: MatterbridgeEndpoint,
  name: Parameters<MatterbridgeEndpoint["executeCommandHandler"]>[0],
  request: object = {},
): Promise<void> => {
  await endpoint.executeCommandHandler(
    name,
    request as never,
    "onOff" as never,
    {} as never,
    endpoint,
  );
};

describe.skipIf(!LIVE)("live devices", () => {
  beforeAll(async () => {
    keyLightSerial = (await keyLightClient.getAccessoryInfo()).serialNumber;
    stripSerial = (await stripClient.getAccessoryInfo()).serialNumber;
    keyLightBefore = await readLight(keyLightClient);
    stripBefore = await readLight(stripClient);
    log?.notice?.(`live: captured KLA ${JSON.stringify(keyLightBefore)}`);
    log?.notice?.(`live: captured STRIP ${JSON.stringify(stripBefore)}`);

    await setupTest("ElgatoLive", false);
    await createTestEnvironment();
    await createServerNode(MATTER_TEST_PORT);
    await startServerNode();

    platform = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      {
        name: "matterbridge-elgato",
        type: "DynamicPlatform",
        version: "0.1.0",
        debug: false,
        unregisterOnShutdown: false,
        enableMdns: false,
        pollInterval: 1000,
        colorDebounce: 0,
        devices: [{ host: KEY_LIGHT_HOST as string }, { host: STRIP_HOST as string }],
      } as PlatformConfig,
    );
    addMatterbridge(platform);
    await platform.onStart("live");
    await platform.onConfigure();

    keyLight = platform.getDeviceBySerialNumber(keyLightSerial) as MatterbridgeEndpoint;
    strip = platform.getDeviceBySerialNumber(stripSerial) as MatterbridgeEndpoint;
  }, 60_000);

  afterAll(async () => {
    if (platform) await platform.onShutdown("live");
    await stopServerNode();
    if (keyLightBefore) await restore(keyLightClient, keyLightBefore);
    if (stripBefore) await restore(stripClient, stripBefore);
  }, 60_000);

  it("discovered both real lights with the right device types", () => {
    expect(platform.devices.size).toBe(2);
    expect([...keyLight.deviceTypes.keys()]).toContain(0x010c);
    expect([...strip.deviceTypes.keys()]).toContain(0x010d);
    expect(keyLight.getAttribute(ColorControl.id, "colorTempPhysicalMinMireds")).toBe(143);
  });

  it("switches the Key Light Air off and on", async () => {
    await command(keyLight, "off");
    expect((await readLight(keyLightClient)).on).toBe(0);
    await command(keyLight, "on");
    expect((await readLight(keyLightClient)).on).toBe(1);
  });

  it("sets Key Light Air brightness without ever emitting 0", async () => {
    await command(keyLight, "moveToLevel", { level: 254 });
    expect((await readLight(keyLightClient)).brightness).toBe(100);
    await command(keyLight, "moveToLevel", { level: 1 });
    expect((await readLight(keyLightClient)).brightness).toBe(3);
  });

  it("sets Key Light Air color temperature and clamps the range", async () => {
    await command(keyLight, "moveToColorTemperature", { colorTemperatureMireds: 300 });
    expect((await readLight(keyLightClient)).temperature).toBe(300);
    await command(keyLight, "moveToColorTemperature", { colorTemperatureMireds: 5000 });
    expect((await readLight(keyLightClient)).temperature).toBe(344);
  });

  it("reflects the real state back into Matter attributes on the poll loop", async () => {
    await keyLightClient.putLights({ on: 1, brightness: 50, temperature: 200 });
    await platform.executeIntervals(1);
    expect(keyLight.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(keyLight.getAttribute(LevelControl.id, "currentLevel")).toBe(124);
    expect(keyLight.getAttribute(ColorControl.id, "colorTemperatureMireds")).toBe(200);
  });

  it("treats moveToLevelWithOnOff at level 1 as an off on the real Key Light", async () => {
    await command(keyLight, "on");
    await command(keyLight, "moveToLevelWithOnOff", { level: 1 });
    expect((await readLight(keyLightClient)).on).toBe(0);
    await command(keyLight, "moveToLevelWithOnOff", { level: 200 });
    const state = await readLight(keyLightClient);
    expect(state.on).toBe(1);
    expect(state.brightness).toBe(79);
  });

  it("switches the Light Strip off and on", async () => {
    await command(strip, "off");
    expect((await readLight(stripClient)).on).toBe(0);
    await command(strip, "on");
    expect((await readLight(stripClient)).on).toBe(1);
  });

  it("sets Light Strip hue and saturation", async () => {
    await command(strip, "moveToHueAndSaturation", { hue: 141, saturation: 254 });
    const state = await readLight(stripClient);
    // Whole degrees: the firmware truncates fractions, so the mapping emits integers.
    expect(state.hue).toBe(200);
    expect(state.saturation).toBe(100);
  });

  it("turns a color temperature request into a real color on the Light Strip", async () => {
    await command(strip, "moveToColorTemperature", { colorTemperatureMireds: 400 });
    const warm = await readLight(stripClient);
    expect(warm).not.toHaveProperty("temperature");
    expect(warm.hue).toBeLessThan(90);
    expect(warm.saturation as number).toBeGreaterThan(40);

    await command(strip, "moveToColorTemperature", { colorTemperatureMireds: 147 });
    const cool = await readLight(stripClient);
    expect(cool.saturation as number).toBeLessThan(15);
  });

  it("resumes a scene across an off/on cycle", async () => {
    const device = platform.devices.get(stripSerial) as LightStripDevice;
    const cached = device.cachedScene;
    if (!cached) {
      // Nothing to resume unless the strip was playing a scene when we started.
      expect(isSceneState(stripBefore)).toBe(false);
      return;
    }

    await stripClient.putLights(cached);
    await platform.executeIntervals(1);
    expect(device.sceneActive).toBe(true);

    await command(strip, "off");
    expect((await readLight(stripClient)).on).toBe(0);

    await command(strip, "on");
    const resumed = await readLight(stripClient);
    expect(isSceneState(resumed)).toBe(true);
    expect(resumed.id).toBe(cached.id);
  });

  it("restores both lights to their captured state", async () => {
    await restore(keyLightClient, keyLightBefore);
    await restore(stripClient, stripBefore);
    expect(await readLight(keyLightClient)).toEqual(keyLightBefore);
    expect(await readLight(stripClient)).toEqual(stripBefore);
  });
});
