/**
 * Boots the real platform against two mock devices, on a real Matter server node
 * (matterbridge's own vitest harness), with mDNS disabled and manual `devices`.
 *
 * WARNING: these tests share the Matterbridge/Matter node state and must run
 * sequentially, see docs/matterbridge-api-cheatsheet.md §5.
 */

import type { MatterbridgeEndpoint, PlatformConfig } from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import {
  BridgedDeviceBasicInformation,
  ColorControl,
  LevelControl,
  OnOff,
} from "matterbridge/matter/clusters";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MK2_TXT, MockKeyLightAirMk2 } from "../scripts/mock-elgato-mk2.ts";
import { MockElgatoDevice, RAINBOW_SCENE } from "../scripts/mock-elgato.ts";
import type { DiscoveredService } from "../src/elgato/types.ts";
import type { LightStripDevice } from "../src/devices/lightStrip.ts";
import initializePlugin, { ElgatoPlatform } from "../src/index.ts";

const KEY_LIGHT_SERIAL = "CW33J1A00001";
const STRIP_SERIAL = "EW52J1A00002";
/** Not 5540: the real matterbridge default must stay free while tests run. */
const MATTER_TEST_PORT = 5561;

const keyLightMock = new MockElgatoDevice({ model: "key-light-air" });
const stripMock = new MockElgatoDevice({ model: "light-strip" });
const mk2Mock = new MockKeyLightAirMk2();

/** An MK.2 as mDNS presents it: same service, same port, plus the `tls` TXT key. */
const mk2Service: DiscoveredService = {
  instanceName: "Elgato Key Light Air MK.2 5E6F",
  host: "192.168.1.60",
  port: 9123,
  txt: MK2_TXT,
};

let platform: ElgatoPlatform;
let keyLight: MatterbridgeEndpoint;
let strip: MatterbridgeEndpoint;

const makeConfig = (overrides: Partial<PlatformConfig> = {}): PlatformConfig =>
  ({
    name: "matterbridge-elgato",
    type: "DynamicPlatform",
    version: "0.1.0",
    debug: false,
    unregisterOnShutdown: false,
    enableMdns: false,
    pollInterval: 1000,
    colorDebounce: 0,
    devices: [
      { host: `127.0.0.1:${keyLightMock.port}` },
      { host: `127.0.0.1:${stripMock.port}`, name: "Office Strip" },
    ],
    whiteList: [],
    blackList: [],
    ...overrides,
  }) as PlatformConfig;

/** Fire a command handler exactly as MatterbridgeXServer would, without a controller. */
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

beforeAll(async () => {
  await setupTest("ElgatoPlatform", false);
  await createTestEnvironment();
  await createServerNode(MATTER_TEST_PORT);
  await startServerNode();
  await keyLightMock.start();
  await stripMock.start();
  await mk2Mock.start();
});

afterAll(async () => {
  if (platform) await platform.onShutdown("test complete");
  await stopServerNode();
  await keyLightMock.stop();
  await stripMock.stop();
  await mk2Mock.stop();
});

describe("startup", () => {
  it("is created through the default export and checks the matterbridge version", () => {
    platform = initializePlugin(getMatterbridge(), log as AnsiLogger, makeConfig());
    expect(platform).toBeInstanceOf(ElgatoPlatform);
    expect(() =>
      initializePlugin(
        { ...getMatterbridge(), matterbridgeVersion: "2.0.0" },
        log as AnsiLogger,
        makeConfig(),
      ),
    ).toThrow(/requires Matterbridge version >= "3.10.0"/);
  });

  it("registers both manual devices as bridged endpoints", async () => {
    addMatterbridge(platform);
    await platform.onStart("vitest");

    expect(platform.devices.size).toBe(2);
    expect(platform.registry.size).toBe(2);
    expect(platform.getDevices()).toHaveLength(2);

    const keyLightEndpoint = platform.getDeviceBySerialNumber(KEY_LIGHT_SERIAL);
    const stripEndpoint = platform.getDeviceBySerialNumber(STRIP_SERIAL);
    expect(keyLightEndpoint).toBeDefined();
    expect(stripEndpoint).toBeDefined();
    keyLight = keyLightEndpoint as MatterbridgeEndpoint;
    strip = stripEndpoint as MatterbridgeEndpoint;
  });

  it("names the Key Light from accessory-info and honors the config override", () => {
    expect(keyLight.deviceName).toBe("Elgato Key Light Air 1A2B");
    expect(strip.deviceName).toBe("Office Strip");
    expect(keyLight.uniqueId).toBeDefined();
  });

  it("gives the CCT light a ColorTemperatureLight with the real 143–344 mired range", () => {
    expect([...keyLight.deviceTypes.keys()]).toEqual(
      expect.arrayContaining([0x010c, 0x0013, 0x0011]),
    );
    expect(keyLight.hasClusterServer("colorControl")).toBe(true);
    expect(keyLight.hasClusterServer("levelControl")).toBe(true);
    expect(keyLight.getAttribute(ColorControl.id, "colorTempPhysicalMinMireds")).toBe(143);
    expect(keyLight.getAttribute(ColorControl.id, "colorTempPhysicalMaxMireds")).toBe(344);
    expect(keyLight.getAttribute(ColorControl.id, "colorMode")).toBe(
      ColorControl.ColorMode.ColorTemperatureMireds,
    );
    // CT-only: no hue/saturation capability advertised.
    expect(keyLight.getAttribute(ColorControl.id, "colorCapabilities")).toMatchObject({
      hueSaturation: false,
      colorTemperature: true,
    });
  });

  it("gives the color light an ExtendedColorLight with hue/saturation capability", () => {
    expect([...strip.deviceTypes.keys()]).toEqual(expect.arrayContaining([0x010d, 0x0013, 0x0011]));
    expect(strip.getAttribute(ColorControl.id, "colorCapabilities")).toMatchObject({
      hueSaturation: true,
      colorTemperature: true,
      xy: true,
    });
  });

  it("seeds the live device state in onConfigure", async () => {
    await platform.onConfigure();
    expect(keyLight.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(keyLight.getAttribute(LevelControl.id, "currentLevel")).toBe(105); // brightness 43
    expect(keyLight.getAttribute(ColorControl.id, "colorTemperatureMireds")).toBe(221);
    expect(strip.getAttribute(ColorControl.id, "currentHue")).toBe(141); // hue 200°
    expect(strip.getAttribute(ColorControl.id, "currentSaturation")).toBe(254);
    expect(platform.intervals).toHaveLength(1);
  });
});

describe("command handlers drive the devices", () => {
  it("maps on/off to the `on` field only", async () => {
    await command(keyLight, "off");
    expect(keyLightMock.light).toMatchObject({ on: 0, brightness: 43, temperature: 221 });
    await command(keyLight, "on");
    expect(keyLightMock.light.on).toBe(1);
  });

  it("maps moveToLevel onto brightness and never emits 0", async () => {
    await command(keyLight, "moveToLevel", { level: 254 });
    expect(keyLightMock.light.brightness).toBe(100);
    await command(keyLight, "moveToLevel", { level: 1 });
    expect(keyLightMock.light.brightness).toBe(3);
    await command(keyLight, "moveToLevel", { level: 0 });
    expect(keyLightMock.light.brightness).toBe(3);
    await command(keyLight, "moveToLevelWithOnOff", { level: 124 });
    expect(keyLightMock.light).toMatchObject({ on: 1, brightness: 50 });
  });

  it("clamps color temperature to the Elgato range client-side", async () => {
    await command(keyLight, "moveToColorTemperature", { colorTemperatureMireds: 250 });
    expect(keyLightMock.light.temperature).toBe(250);
    // The firmware would have stored 5000 verbatim; the bridge must not let it.
    await command(keyLight, "moveToColorTemperature", { colorTemperatureMireds: 5000 });
    expect(keyLightMock.light.temperature).toBe(344);
    await command(keyLight, "moveToColorTemperature", { colorTemperatureMireds: 1 });
    expect(keyLightMock.light.temperature).toBe(143);
  });

  it("writes hue and saturation together on moveToHueAndSaturation", async () => {
    await command(strip, "moveToHueAndSaturation", { hue: 141, saturation: 127 });
    expect(stripMock.light.hue).toBe(200);
    expect(stripMock.light.saturation).toBe(50);
    // A color command must not power the light on by itself.
    expect(stripMock.requests.at(-1)?.method).toBe("PUT");
  });

  it("coalesces separate moveToHue / moveToSaturation into one write", async () => {
    const device = platform.devices.get(STRIP_SERIAL) as LightStripDevice;
    const before = stripMock.requests.filter((r) => r.method === "PUT").length;
    await command(strip, "moveToHue", { hue: 0 });
    await command(strip, "moveToSaturation", { saturation: 254 });
    await device.flushPendingColor();
    const after = stripMock.requests.filter((r) => r.method === "PUT").length;
    expect(after - before).toBe(1);
    expect(stripMock.light).toMatchObject({ hue: 0, saturation: 100 });
  });

  it("reads the companion attribute when only one of hue/saturation is commanded", async () => {
    const device = platform.devices.get(STRIP_SERIAL) as LightStripDevice;
    await command(strip, "moveToHueAndSaturation", { hue: 141, saturation: 254 });
    await command(strip, "moveToHue", { hue: 64 });
    await device.flushPendingColor();
    expect(stripMock.light.hue).toBe(91);
    expect(stripMock.light.saturation).toBe(100); // kept from the attribute
  });

  it("synthesizes the strip's mandatory color temperature control into an HSV write", async () => {
    // ExtendedColorLight must expose ColorTemperature, and Google/Apple render a
    // warm-to-cool slider for it, but the strip has no white channel, so the mireds are
    // converted to a point on the color wheel instead of being dropped on the floor.
    await command(strip, "moveToHueAndSaturation", { hue: 141, saturation: 254 });
    const before = { ...stripMock.light };

    await command(strip, "moveToColorTemperature", { colorTemperatureMireds: 370 }); // ~2700 K
    const warm = { ...stripMock.light };
    expect(warm).not.toEqual(before);
    expect(warm.hue).toBeTypeOf("number");
    expect(warm.saturation).toBeTypeOf("number");
    // Never `temperature`: the strip has no such field and mixing it with hue/saturation
    // is forbidden (docs/elgato-protocol.md §9).
    expect(stripMock.light).not.toHaveProperty("temperature");

    await command(strip, "moveToColorTemperature", { colorTemperatureMireds: 147 }); // ~6800 K
    const cool = { ...stripMock.light };

    // Warm white is an amber hue with real saturation; cool white is nearly white.
    // (HSL saturation would have reported 100 % for both, see mapping.hsvSaturation.)
    expect(warm.hue as number).toBeLessThan(90);
    expect(warm.saturation as number).toBeGreaterThan(40);
    expect(cool.saturation as number).toBeLessThan(15);
    expect(cool.saturation).not.toBe(warm.saturation);
    expect(stripMock.light).not.toHaveProperty("temperature");
  });

  it("treats moveToLevelWithOnOff at the cropped minimum as an off, not a dim to 3 %", async () => {
    // matter.js crops to minLevel 1 and couples OnOff false there.
    await command(keyLight, "on");
    await command(keyLight, "moveToLevelWithOnOff", { level: 1 });
    expect(keyLightMock.light.on).toBe(0);
    expect(keyLightMock.light.brightness).not.toBe(3);

    await command(strip, "on");
    await command(strip, "moveToLevelWithOnOff", { level: 1 });
    expect(stripMock.light.on).toBe(0);
  });

  it("powers on and sets brightness in one body above the cropped minimum", async () => {
    await command(keyLight, "off");
    const before = stripMock.requests.filter((r) => r.method === "PUT").length;
    await command(keyLight, "moveToLevelWithOnOff", { level: 124 });
    expect(keyLightMock.light).toMatchObject({ on: 1, brightness: 50 });

    await command(strip, "off");
    await command(strip, "moveToLevelWithOnOff", { level: 254 });
    expect(stripMock.light).toMatchObject({ on: 1, brightness: 100 });
    expect(stripMock.requests.filter((r) => r.method === "PUT").length - before).toBe(2);
  });
});

describe("poll loop", () => {
  it("picks up out-of-band changes through executeIntervals", async () => {
    keyLightMock.light = { on: 0, brightness: 20, temperature: 300 };
    stripMock.light = { on: 1, hue: 120, saturation: 50, brightness: 80 };

    await platform.executeIntervals(1);

    expect(keyLight.getAttribute(OnOff.id, "onOff")).toBe(false);
    expect(keyLight.getAttribute(LevelControl.id, "currentLevel")).toBe(45);
    expect(keyLight.getAttribute(ColorControl.id, "colorTemperatureMireds")).toBe(300);
    expect(strip.getAttribute(LevelControl.id, "currentLevel")).toBe(202);
    expect(strip.getAttribute(ColorControl.id, "currentHue")).toBe(85);
    expect(strip.getAttribute(ColorControl.id, "currentSaturation")).toBe(127);
    expect(strip.getAttribute(ColorControl.id, "colorMode")).toBe(
      ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
    );
  });

  it("clamps a temperature the firmware stored out of range", async () => {
    keyLightMock.light = { on: 1, brightness: 50, temperature: 5000 };
    await platform.executeIntervals(1);
    expect(keyLight.getAttribute(ColorControl.id, "colorTemperatureMireds")).toBe(344);
  });

  it("marks the device unreachable after three consecutive failures and back on success", async () => {
    expect(keyLight.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(true);
    keyLightMock.fault = "offline";
    await platform.executeIntervals(2);
    expect(keyLight.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(true);
    await platform.executeIntervals(1);
    expect(keyLight.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(false);

    keyLightMock.fault = "none";
    await platform.executeIntervals(1);
    expect(keyLight.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(true);
    // The endpoint is never unregistered.
    expect(platform.getDevices()).toHaveLength(2);
  });
});

describe("scene preservation", () => {
  it("caches a scene seen on the poll path", async () => {
    stripMock.scene = { ...RAINBOW_SCENE };
    await platform.executeIntervals(1);

    const device = platform.devices.get(STRIP_SERIAL) as LightStripDevice;
    expect(device.sceneActive).toBe(true);
    expect(device.cachedScene?.id).toBe("com.corsair.cc.scene.rainbow");
    // Reports on + the scene master brightness, keeps the last known hue.
    expect(strip.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(strip.getAttribute(LevelControl.id, "currentLevel")).toBe(249); // brightness 98
    expect(strip.getAttribute(ColorControl.id, "currentHue")).toBe(85);
  });

  it("remembers to resume on off and puts the scene back on the next on", async () => {
    const device = platform.devices.get(STRIP_SERIAL) as LightStripDevice;

    await command(strip, "off");
    expect(device.resumeScene).toBe(true);
    expect(stripMock.scene).toBeUndefined(); // the firmware destroyed it
    expect(stripMock.light.on).toBe(0);

    await command(strip, "on");
    expect(device.resumeScene).toBe(false);
    expect(stripMock.scene).toMatchObject({
      on: 1,
      id: "com.corsair.cc.scene.rainbow",
      numberOfSceneElements: 6,
    });
  });

  it("drops the resume intent as soon as a color or level command arrives", async () => {
    const device = platform.devices.get(STRIP_SERIAL) as LightStripDevice;
    await platform.executeIntervals(1);
    expect(device.sceneActive).toBe(true);

    await command(strip, "off");
    expect(device.resumeScene).toBe(true);
    await command(strip, "moveToLevel", { level: 128 });
    expect(device.resumeScene).toBe(false);

    await command(strip, "on");
    expect(stripMock.scene).toBeUndefined();
    expect(stripMock.light.on).toBe(1);
  });
});

describe("device identity survives a rename", () => {
  it("follows a rename in the label but not in the identity", async () => {
    const endpoint = platform.getDeviceBySerialNumber(KEY_LIGHT_SERIAL) as MatterbridgeEndpoint;
    const uniqueIdBefore = endpoint.uniqueId;
    const original = keyLightMock.info.displayName;

    keyLightMock.info.displayName = "Renamed In The Elgato App";
    try {
      // A repeat mDNS announcement re-reads accessory-info and refreshes the label.
      await platform.addDeviceByHost(`127.0.0.1:${keyLightMock.port}`);
      expect(endpoint.getAttribute(BridgedDeviceBasicInformation.id, "nodeLabel")).toBe(
        "Renamed In The Elgato App",
      );
      // uniqueId = md5(deviceName + serial + vendorName + productName), so unchanged.
      expect(endpoint.uniqueId).toBe(uniqueIdBefore);
      expect(endpoint.deviceName).toBe(original);
    } finally {
      keyLightMock.info.displayName = original;
    }
  });

  it("re-uses the first-seen name on a later boot, so the uniqueId is stable", async () => {
    const uniqueIdBefore = (
      platform.getDeviceBySerialNumber(KEY_LIGHT_SERIAL) as MatterbridgeEndpoint
    ).uniqueId;
    const original = keyLightMock.info.displayName;
    keyLightMock.info.displayName = "Renamed Before Restart";

    const rebooted = new ElgatoPlatform(getMatterbridge(), log as AnsiLogger, makeConfig());
    addMatterbridge(rebooted);
    // A real restart reloads this from ~/.matterbridge/matterbridge-elgato.
    rebooted.context = platform.context;
    await rebooted.onStart("rename");

    try {
      const after = rebooted.devices.get(KEY_LIGHT_SERIAL);
      expect(after?.deviceName).toBe(original);
      expect(after?.endpoint.uniqueId).toBe(uniqueIdBefore);
    } finally {
      keyLightMock.info.displayName = original;
      await rebooted.onShutdown("rename");
    }
  });
});

describe("discovery hygiene", () => {
  it("does not register a duplicate when the same light announces two host strings", async () => {
    const other = new ElgatoPlatform(getMatterbridge(), log as AnsiLogger, makeConfig());
    addMatterbridge(other);
    await other.onStart("dedupe");
    const registered = other.devices.size;

    // Same serial, two different host strings, at the same time: an IPv4 `up` racing an
    // `srv-update` carrying the hostname.
    await Promise.all([
      other.addDeviceByHost(`127.0.0.1:${keyLightMock.port}`),
      other.addDeviceByHost(`localhost:${keyLightMock.port}`),
    ]);
    expect(other.devices.size).toBe(registered);
    await other.onShutdown("dedupe");
  });

  it("stops re-probing a blacklisted host over HTTP", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ blackList: [KEY_LIGHT_SERIAL, STRIP_SERIAL] }),
    );
    addMatterbridge(other);
    await other.onStart("skip");
    const afterFirstPass = keyLightMock.requests.length;

    for (let i = 0; i < 3; i += 1) {
      await other.addDeviceByHost(`127.0.0.1:${keyLightMock.port}`);
    }
    expect(keyLightMock.requests.length).toBe(afterFirstPass);
    await other.onShutdown("skip");
  });

  it("skips a poll tick while the previous one is still running", async () => {
    let running = 0;
    let overlapped = false;
    const slow = {
      async poll() {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
      },
    };
    const other = new ElgatoPlatform(getMatterbridge(), log as AnsiLogger, makeConfig());
    other.devices.set("SLOW", slow as never);
    await Promise.all([other.pollAll(), other.pollAll(), other.pollAll()]);
    expect(overlapped).toBe(false);
  });
});

describe("color mode", () => {
  it("sets colorMode once, not on every poll tick", async () => {
    const other = new ElgatoPlatform(getMatterbridge(), log as AnsiLogger, makeConfig());
    addMatterbridge(other);
    await other.onStart("color mode");
    const device = other.devices.get(STRIP_SERIAL) as LightStripDevice;
    const configure = vi.spyOn(device.endpoint, "configureColorControlMode");
    stripMock.scene = undefined;
    stripMock.light = { on: 1, hue: 120, saturation: 50, brightness: 80 };

    try {
      await device.seed();
      await device.poll();
      await device.poll();
      await device.poll();
      // configureColorControlMode writes without diffing, so an unchanged mode would
      // report colorMode and enhancedColorMode to every fabric on every tick.
      expect(configure).toHaveBeenCalledTimes(1);
    } finally {
      configure.mockRestore();
      await other.onShutdown("color mode");
    }
  });
});

describe("Key Light Air MK.2", () => {
  it("skips a light advertising the TLS protocol and explains it once", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [] }),
    );
    addMatterbridge(other);
    const info = vi.spyOn(other.log, "info");
    try {
      await other.onStart("mk2 txt");
      await other.addDiscoveredService(mk2Service);
      await other.addDiscoveredService(mk2Service);

      expect(other.devices.size).toBe(0);
      expect(other.unsupportedCount).toBe(1);
      const said = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("TLS protocol"));
      expect(said).toHaveLength(1);
      expect(said[0]).toBe(
        "Elgato Key Light Air MK.2 20LAM9901 at 192.168.1.60 uses the TLS protocol, " +
          "which this plugin does not support yet. Follow " +
          "https://github.com/passtas/matterbridge-elgato/issues/1 for progress.",
      );
    } finally {
      info.mockRestore();
      await other.onShutdown("mk2 txt");
    }
  });

  it("skips a light that answers on 9123 without an HTTP reply, and stops probing it", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [] }),
    );
    addMatterbridge(other);
    await other.onStart("mk2 http");

    expect(await other.addDeviceByHost(mk2Mock.host)).toBeUndefined();
    expect(mk2Mock.connections).toBe(1);
    expect(await other.addDeviceByHost(mk2Mock.host)).toBeUndefined();
    expect(mk2Mock.connections).toBe(1);
    expect(other.devices.size).toBe(0);
    expect(other.unsupportedCount).toBe(1);
    await other.onShutdown("mk2 http");
  });

  it("counts unsupported lights in the discovery summary", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [{ host: `127.0.0.1:${keyLightMock.port}` }, { host: mk2Mock.host }] }),
    );
    addMatterbridge(other);
    const notice = vi.spyOn(other.log, "notice");
    try {
      await other.onStart("summary");
      expect(notice.mock.calls.map((call) => String(call[0]))).toContain(
        "Discovered 1 Elgato device(s) and 1 unsupported",
      );
    } finally {
      notice.mockRestore();
      await other.onShutdown("summary");
    }
  });
});

describe("white and black lists", () => {
  it("skips a blacklisted serial but still offers it in the frontend dropdown", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ blackList: [KEY_LIGHT_SERIAL, STRIP_SERIAL] }),
    );
    addMatterbridge(other);
    await other.onStart("blacklist");
    expect(other.devices.size).toBe(0);
    expect(other.getSelectDevices().map((d) => d.serial)).toEqual(
      expect.arrayContaining([KEY_LIGHT_SERIAL, STRIP_SERIAL]),
    );
    await other.onShutdown("blacklist");
  });

  it("keeps only whitelisted devices", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ whiteList: ["nothing-matches-this"] }),
    );
    addMatterbridge(other);
    await other.onStart("whitelist");
    expect(other.devices.size).toBe(0);
    await other.onShutdown("whitelist");
  });
});

describe("shutdown", () => {
  it("clears the poll interval and leaves the bridged endpoints in place", async () => {
    expect(platform.getDevices()).toHaveLength(2);
    await platform.onShutdown("vitest");
    expect(platform.intervals).toHaveLength(0);
    // `unregisterOnShutdown` is false, so the endpoints stay on the aggregator; the
    // platform's own registry is cleared by MatterbridgePlatform.destroy().
    expect(platform.devices.size).toBe(2);
  });
});
