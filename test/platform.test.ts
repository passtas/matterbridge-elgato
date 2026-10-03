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
  PowerSource,
} from "matterbridge/matter/clusters";
import {
  addMatterbridge,
  aggregator,
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
import { batteryPollEvery } from "../src/config.ts";
import { ElgatoClient, ElgatoHttpError } from "../src/elgato/client.ts";
import { isMdnsName } from "../src/elgato/discovery.ts";
import type { DiscoveredService } from "../src/elgato/types.ts";
import type { LightStripDevice } from "../src/devices/lightStrip.ts";
import initializePlugin, { ElgatoPlatform } from "../src/index.ts";
import { announcement, aRecordPacket, fakeDiscovery } from "./helpers/fakeBonjour.ts";

const KEY_LIGHT_SERIAL = "CW33J1A00001";
const STRIP_SERIAL = "EW52J1A00002";
const MINI_SERIAL = "CW43K1A00003";
/** Not 5540: the real matterbridge default must stay free while tests run. */
const MATTER_TEST_PORT = 5561;

const keyLightMock = new MockElgatoDevice({ model: "key-light-air" });
const stripMock = new MockElgatoDevice({ model: "light-strip" });
const miniMock = new MockElgatoDevice({ model: "key-light-mini" });
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
let mini: MatterbridgeEndpoint;

const batteryReads = (mock: MockElgatoDevice): number =>
  mock.requests.filter((request) => request.path === "/elgato/battery-info").length;

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
      { host: `127.0.0.1:${miniMock.port}` },
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
  await miniMock.start();
  await mk2Mock.start();
});

afterAll(async () => {
  if (platform) await platform.onShutdown("test complete");
  await stopServerNode();
  await keyLightMock.stop();
  await stripMock.stop();
  await miniMock.stop();
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

  it("registers every manual device as a bridged endpoint", async () => {
    addMatterbridge(platform);
    await platform.onStart("vitest");

    expect(platform.devices.size).toBe(3);
    expect(platform.registry.size).toBe(3);
    expect(platform.getDevices()).toHaveLength(3);

    const keyLightEndpoint = platform.getDeviceBySerialNumber(KEY_LIGHT_SERIAL);
    const stripEndpoint = platform.getDeviceBySerialNumber(STRIP_SERIAL);
    expect(keyLightEndpoint).toBeDefined();
    expect(stripEndpoint).toBeDefined();
    keyLight = keyLightEndpoint as MatterbridgeEndpoint;
    strip = stripEndpoint as MatterbridgeEndpoint;
    mini = platform.getDeviceBySerialNumber(MINI_SERIAL) as MatterbridgeEndpoint;
    expect(mini).toBeDefined();
  });

  it("gives the Key Light Mini a battery PowerSource, and the others a wired one", () => {
    expect([...mini.deviceTypes.keys()]).toEqual(expect.arrayContaining([0x010c, 0x0013, 0x0011]));
    expect(mini.getAttribute(PowerSource.id, "featureMap")).toMatchObject({
      wired: false,
      battery: true,
      rechargeable: true,
      replaceable: false,
    });
    expect(mini.getAttribute(PowerSource.id, "batReplaceability")).toBe(
      PowerSource.BatReplaceability.NotReplaceable,
    );
    expect(mini.getAttribute(PowerSource.id, "batReplacementNeeded")).toBe(false);
    expect(mini.getAttribute(PowerSource.id, "status")).toBe(PowerSource.PowerSourceStatus.Active);
    // Built from the probe's reading, before onConfigure: 78.57 % must not land as 157.14.
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(157);
    expect(mini.getAttribute(PowerSource.id, "batVoltage")).toBe(3860);
    // The helper would say IsNotCharging until the seed; the probe says charging.
    expect(mini.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.IsCharging,
    );

    for (const wired of [keyLight, strip]) {
      expect(wired.getAttribute(PowerSource.id, "featureMap")).toMatchObject({
        wired: true,
        battery: false,
      });
    }
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
    const probes = batteryReads(miniMock);
    expect(probes).toBe(1);
    await platform.onConfigure();
    // The seed reuses the probe's reading rather than asking the light again.
    expect(batteryReads(miniMock)).toBe(probes);
    expect(keyLight.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(keyLight.getAttribute(LevelControl.id, "currentLevel")).toBe(105); // brightness 43
    expect(keyLight.getAttribute(ColorControl.id, "colorTemperatureMireds")).toBe(221);
    expect(strip.getAttribute(ColorControl.id, "currentHue")).toBe(141); // hue 200°
    expect(strip.getAttribute(ColorControl.id, "currentSaturation")).toBe(254);
    // The poll loop and the retry queue, on separate timers.
    expect(platform.intervals).toHaveLength(2);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(157);
    expect(mini.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.IsCharging,
    );
    expect(mini.getAttribute(PowerSource.id, "batChargeLevel")).toBe(PowerSource.BatChargeLevel.Ok);
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
    expect(platform.getDevices()).toHaveLength(3);
  });
});

describe("Key Light Mini battery", () => {
  /** Poll ticks per battery read at the test's 1000 ms poll interval. */
  const every = batteryPollEvery(makeConfig());

  it("reads the battery about every 30 s, on the existing poll tick", async () => {
    expect(every).toBe(30);
    expect(platform.intervals).toHaveLength(2);
    const before = batteryReads(miniMock);
    // Any 2N consecutive ticks hold exactly two multiples of N.
    await platform.executeIntervals(every * 2);
    expect(batteryReads(miniMock) - before).toBe(2);
  });

  it("asks a light without a battery once, at registration, and never again", async () => {
    await platform.executeIntervals(every);
    expect(batteryReads(keyLightMock)).toBe(1);
    expect(batteryReads(stripMock)).toBe(1);
  });

  it("reflects unplugging and a draining battery within one battery read", async () => {
    miniMock.battery = {
      powerSource: 2,
      level: 15.4,
      status: 0,
      currentBatteryVoltage: 3600,
      inputChargeVoltage: 0,
      inputChargeCurrent: 0,
    };
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.IsNotCharging,
    );
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(31);
    expect(mini.getAttribute(PowerSource.id, "batChargeLevel")).toBe(
      PowerSource.BatChargeLevel.Warning,
    );
    expect(mini.getAttribute(PowerSource.id, "batVoltage")).toBe(3600);

    miniMock.battery = { ...miniMock.battery, level: 7.2 };
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(14);
    expect(mini.getAttribute(PowerSource.id, "batChargeLevel")).toBe(
      PowerSource.BatChargeLevel.Critical,
    );

    miniMock.battery = { ...miniMock.battery, level: 100, status: 3, powerSource: 1 };
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.IsAtFullCharge,
    );
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(200);
  });

  it("does not re-report a percentage or voltage that only wobbles", async () => {
    const steady = {
      powerSource: 1,
      level: 96.15,
      status: 2,
      currentBatteryVoltage: 3997,
      inputChargeVoltage: 4208,
      inputChargeCurrent: 3008,
    };
    miniMock.battery = steady;
    // Down from 100 %: one read is held, the second agrees and is reported.
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(200);
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(192);

    // The documented one-read dip, 96.15 → 94.65 → 96.15 %, is never reported.
    miniMock.battery = { ...steady, level: 94.65 };
    await platform.executeIntervals(every);
    miniMock.battery = steady;
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(192);
    expect(mini.getAttribute(PowerSource.id, "batVoltage")).toBe(3997);

    // Half a percent and a few millivolts: below both thresholds.
    miniMock.battery = { ...steady, level: 95.7, currentBatteryVoltage: 3981 };
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(192);
    expect(mini.getAttribute(PowerSource.id, "batVoltage")).toBe(3997);

    // A full percent and 20 mV: both follow. The charge state never waits.
    miniMock.battery = { ...steady, level: 95.1, currentBatteryVoltage: 3977, status: 0 };
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(190);
    expect(mini.getAttribute(PowerSource.id, "batVoltage")).toBe(3977);
    expect(mini.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.IsNotCharging,
    );
  });

  it("reports a charge status it does not know as Unknown", async () => {
    miniMock.battery = { ...(miniMock.battery as NonNullable<typeof miniMock.battery>), status: 7 };
    await platform.executeIntervals(every);
    expect(mini.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.Unknown,
    );
    expect(mini.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(true);
  });

  it("never lets a failing battery read mark the light unreachable or touch its state", async () => {
    miniMock.light = { on: 1, brightness: 50, temperature: 250 };
    await platform.executeIntervals(1);
    const level = mini.getAttribute(LevelControl.id, "currentLevel");
    const percent = mini.getAttribute(PowerSource.id, "batPercentRemaining");

    miniMock.batteryFault = true;
    const before = batteryReads(miniMock);
    await platform.executeIntervals(every * 3);
    miniMock.batteryFault = false;

    expect(batteryReads(miniMock) - before).toBe(3);
    expect(mini.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(true);
    expect(mini.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(mini.getAttribute(LevelControl.id, "currentLevel")).toBe(level);
    expect(mini.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(percent);
  });

  it("skips the battery read while the light itself is not answering", async () => {
    const before = batteryReads(miniMock);
    miniMock.fault = "offline";
    await platform.executeIntervals(every);
    miniMock.fault = "none";
    // The offline mock still logs the request it dropped, so only lights paths appear.
    expect(batteryReads(miniMock)).toBe(before);
    await platform.executeIntervals(1);
    expect(mini.getAttribute(BridgedDeviceBasicInformation.id, "reachable")).toBe(true);
  });
});

describe("a battery probe that gets no answer", () => {
  const FLAKY_SERIAL = "CW43K1A00004";
  const flaky = new MockElgatoDevice({ model: "key-light-mini" });
  flaky.info.serialNumber = FLAKY_SERIAL;
  let other: ElgatoPlatform;
  let host: string;

  beforeAll(async () => {
    flaky.batteryFault = true;
    await flaky.start();
    host = `127.0.0.1:${flaky.port}`;
    other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [{ host }] }),
    );
    addMatterbridge(other);
  });

  afterAll(async () => {
    await other.onShutdown("flaky battery");
    await flaky.stop();
  });

  it("keeps the light out and queues it for a retry, rather than building it wired", async () => {
    const error = vi.spyOn(other.log, "error");
    try {
      await other.onStart("flaky battery");
      expect(other.devices.has(FLAKY_SERIAL)).toBe(false);
      expect(other.registry.has(FLAKY_SERIAL)).toBe(false);
      expect(other.pendingRetries.get(host)).toMatchObject({ host, retries: 0 });
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/did not answer its battery probe/));
      // A dropped battery probe must not be mistaken for an MK.2's closed socket.
      expect(other.unsupportedCount).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  it("is retried, then registered with its battery and seeded from the probe", async () => {
    await other.onConfigure();
    flaky.batteryFault = false;
    const before = batteryReads(flaky);
    await other.retryPending({ force: true });

    const device = other.devices.get(FLAKY_SERIAL);
    expect(device?.hasBattery).toBe(true);
    expect(other.pendingRetries.size).toBe(0);
    const endpoint = device?.endpoint as MatterbridgeEndpoint;
    expect(endpoint.getAttribute(PowerSource.id, "featureMap")).toMatchObject({
      wired: false,
      battery: true,
      rechargeable: true,
    });
    // Seeded on the late-registration path, after onConfigure had already run.
    expect(endpoint.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(endpoint.getAttribute(PowerSource.id, "batPercentRemaining")).toBe(157);
    expect(endpoint.getAttribute(PowerSource.id, "batChargeState")).toBe(
      PowerSource.BatChargeState.IsCharging,
    );
    // One battery request: the probe. The seed reused its reading.
    expect(batteryReads(flaky) - before).toBe(1);
  });
});

describe("a battery probe that never answers", () => {
  it("adds the light without a battery after three tries, with one warning", async () => {
    const SERIAL = "CW43K1A00005";
    const stubborn = new MockElgatoDevice({ model: "key-light-mini" });
    stubborn.info.serialNumber = SERIAL;
    // A 5xx is a struggling light, not "no battery": it goes the retry route.
    stubborn.batteryFault = 500;
    await stubborn.start();
    const host = `127.0.0.1:${stubborn.port}`;
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [{ host }] }),
    );
    addMatterbridge(other);
    const warn = vi.spyOn(other.log, "warn");
    try {
      await other.onStart("stubborn battery"); // try 1
      await other.onConfigure();
      expect(other.devices.has(SERIAL)).toBe(false);
      await other.retryPending({ force: true }); // try 2
      expect(other.devices.has(SERIAL)).toBe(false);
      expect(other.pendingRetries.get(host)).toMatchObject({ retries: 1 });
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/battery not read/));

      await other.retryPending({ force: true }); // try 3
      const device = other.devices.get(SERIAL);
      expect(device?.hasBattery).toBe(false);
      expect(device?.endpoint.getAttribute(PowerSource.id, "featureMap")).toMatchObject({
        wired: true,
        battery: false,
      });
      expect(other.pendingRetries.size).toBe(0);
      expect(batteryReads(stubborn)).toBe(3);
      expect(
        warn.mock.calls.filter(([message]) => /battery not read/.test(String(message))),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await other.onShutdown("stubborn battery");
      await stubborn.stop();
    }
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
      makeConfig({ blackList: [KEY_LIGHT_SERIAL, STRIP_SERIAL, MINI_SERIAL] }),
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
      makeConfig({ blackList: [KEY_LIGHT_SERIAL, STRIP_SERIAL, MINI_SERIAL] }),
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

/** A Key Light Air mock with its own synthetic serial, so it can sit next to the others. */
const extraLight = (serial: string, displayName: string): MockElgatoDevice => {
  const mock = new MockElgatoDevice({ model: "key-light-air" });
  mock.info.serialNumber = serial;
  mock.info.displayName = displayName;
  mock.light = { on: 1, brightness: 20, temperature: 300 };
  return mock;
};

/** Started once to reserve a port, then stopped: a light that is switched off. */
const switchedOff = async (serial: string, displayName: string): Promise<MockElgatoDevice> => {
  const mock = extraLight(serial, displayName);
  await mock.start();
  await mock.stop();
  return mock;
};

const lines = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) => String(call[0]));

/**
 * Stands in for the `.local` name a container cannot resolve. `.invalid` fails at
 * once with the same "fetch failed" (ENOTFOUND), where a `.local` lookup on a dev box
 * with nss-mdns would sit out a 5 s timeout first.
 */
const UNRESOLVABLE = "elgato-key-light-mini-0a0b.invalid";

describe("lights found after startup", () => {
  const mini = extraLight("CW33J1A09001", "Elgato Key Light Mini 0A0B");
  const late = extraLight("CW33J1A09002", "Elgato Key Light Mini 1C1D");
  const { discovery, browser, mdns } = fakeDiscovery({ resolveTimeoutMs: 50 });
  let other: ElgatoPlatform;

  beforeAll(async () => {
    await mini.start();
    await late.start();
    other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [], enableMdns: true }),
    );
    other.createDiscovery = () => discovery;
    addMatterbridge(other);
    await other.onStart("late");
    await other.onConfigure();
  });

  afterAll(async () => {
    await other.onShutdown("late");
    await mini.stop();
    await late.stop();
  });

  it("registers a light that announced only its name, probing the IPv4 mDNS gives back", async () => {
    expect(other.devices.size).toBe(0);
    const notice = vi.spyOn(other.log, "notice");
    mdns.answers.set("elgato-key-light-mini-0a0b.local", "127.0.0.1");
    browser.emit(
      "up",
      announcement({
        name: "Elgato Key Light Mini 0A0B",
        host: "elgato-key-light-mini-0a0b.local",
        port: mini.port,
      }),
    );
    // "Registered ..." comes after registerDevice and the seed, so the endpoint is final.
    await vi.waitFor(
      () => {
        expect(lines(notice).some((line) => line.includes("(CW33J1A09001)"))).toBe(true);
      },
      { timeout: 5000 },
    );
    notice.mockRestore();

    // Probed at the address, never at the name.
    expect(mini.requests[0]?.headers.host).toBe(`127.0.0.1:${mini.port}`);
    expect(other.registry.get("CW33J1A09001")?.client.host).toBe("127.0.0.1");
    expect(other.pendingRetries.size).toBe(0);
  });

  it("puts a light registered after onConfigure on the aggregator, seeded", () => {
    const endpoint = other.devices.get("CW33J1A09001")?.endpoint as MatterbridgeEndpoint;
    expect(aggregator.parts.has(endpoint)).toBe(true);
    expect(other.getDevices()).toContain(endpoint);
    // Seeded on registration, without waiting for a poll tick.
    expect(endpoint.getAttribute(LevelControl.id, "currentLevel")).toBe(45); // brightness 20
    expect(endpoint.getAttribute(ColorControl.id, "colorTemperatureMireds")).toBe(300);
  });

  it("asks mDNS again before retrying a light whose name nothing resolved", async () => {
    const error = vi.spyOn(other.log, "error");
    const info = vi.spyOn(other.log, "info");
    try {
      // No A answer yet, so the bare name is all there is, and it does not resolve.
      browser.emit(
        "up",
        announcement({ name: "Elgato Key Light Mini 1C1D", host: UNRESOLVABLE, port: late.port }),
      );
      await vi.waitFor(() => {
        expect(other.pendingRetries.get("Elgato Key Light Mini 1C1D")).toMatchObject({
          host: `${UNRESOLVABLE}:${late.port}`,
          retries: 0,
        });
      });
      expect(lines(error)).toEqual([
        expect.stringMatching(
          new RegExp(
            `^Could not add the Elgato device at ${UNRESOLVABLE}:\\d+: .*fetch failed`,
            "u",
          ),
        ),
      ]);

      // The light answers its A query now.
      mdns.answers.set(UNRESOLVABLE, "127.0.0.1");
      await other.retryPending({ force: true });

      expect(other.devices.has("CW33J1A09002")).toBe(true);
      expect(late.requests[0]?.headers.host).toBe(`127.0.0.1:${late.port}`);
      expect(other.pendingRetries.size).toBe(0);
      expect(lines(info)).toContain(
        `Added the Elgato device at 127.0.0.1:${late.port} after 1 retry`,
      );
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });
});

/**
 * Make every `.local` name fail at once with "fetch failed", as it does in a container
 * with no nss-mdns, instead of sitting out this box's nss-mdns timeout.
 */
const failLocalNames = () => {
  const original = ElgatoClient.prototype.getAccessoryInfo;
  return vi
    .spyOn(ElgatoClient.prototype, "getAccessoryInfo")
    .mockImplementation(function (this: ElgatoClient) {
      if (!isMdnsName(this.host)) return original.call(this);
      return Promise.reject(
        new ElgatoHttpError(`GET ${this.baseUrl}/elgato/accessory-info failed: fetch failed`, 0),
      );
    });
};

describe("a .local host in the manual list", () => {
  it("is resolved over mDNS with discovery off, and retried until it resolves", async () => {
    const desk = extraLight("CW33J1A09010", "Elgato Key Light 0F0F");
    await desk.start();
    const name = "elgato-key-light-0f0f.local";
    const host = `${name}:${desk.port}`;
    const { discovery, browser, mdns } = fakeDiscovery({ resolveTimeoutMs: 50 });
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ enableMdns: false, devices: [{ host, name: "Desk Lamp" }] }),
    );
    other.createDiscovery = () => discovery;
    addMatterbridge(other);
    const local = failLocalNames();
    try {
      // Nothing answers the A query yet, so the light is queued under its configured host.
      await other.onStart("manual local");
      expect(other.devices.size).toBe(0);
      expect(other.pendingRetries.get(host)).toMatchObject({ host, retries: 0 });
      expect(mdns.queries.length).toBeGreaterThan(0);
      expect(mdns.queries.every((query) => query.name === name && query.type === "A")).toBe(true);
      // Only the socket was opened: discovery is off, so nothing is browsed.
      expect(browser.listenerCount("up")).toBe(0);

      await other.onConfigure();
      mdns.answers.set(name, "127.0.0.1");
      await other.retryPending({ force: true });

      const device = other.devices.get("CW33J1A09010");
      expect(device?.deviceName).toBe("Desk Lamp");
      expect(other.registry.get("CW33J1A09010")?.client.host).toBe("127.0.0.1");
      expect(desk.requests[0]?.headers.host).toBe(`127.0.0.1:${desk.port}`);
      expect(other.pendingRetries.size).toBe(0);
    } finally {
      local.mockRestore();
      await other.onShutdown("manual local");
      await desk.stop();
    }
  });
});

describe("with discovery on, lights from the devices list and lights that move", () => {
  const { discovery, browser, mdns } = fakeDiscovery({ resolveTimeoutMs: 50 });
  let other: ElgatoPlatform;
  let door: MockElgatoDevice;
  let shelf: MockElgatoDevice;
  let local: ReturnType<typeof failLocalNames>;

  beforeAll(async () => {
    door = await switchedOff("CW33J1A09011", "Elgato Key Light 7F7F");
    shelf = await switchedOff("CW33J1A09012", "Elgato Key Light 1E1E");
    local = failLocalNames();
    other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({
        enableMdns: true,
        devices: [
          { host: `127.0.0.1:${door.port}`, name: "Door Light" },
          { host: `elgato-key-light-1e1e.local:${shelf.port}`, name: "Shelf Light" },
        ],
      }),
    );
    other.createDiscovery = () => discovery;
    addMatterbridge(other);
    await other.onStart("devices list");
    await other.onConfigure();
  });

  afterAll(async () => {
    local.mockRestore();
    await other.onShutdown("devices list");
    await door.stop();
    await shelf.stop();
  });

  const registered = async (serial: string): Promise<void> => {
    const notice = vi.spyOn(other.log, "notice");
    try {
      await vi.waitFor(
        () => {
          expect(lines(notice).some((line) => line.includes(`(${serial})`))).toBe(true);
        },
        { timeout: 5000 },
      );
    } finally {
      notice.mockRestore();
    }
  };

  it("keeps the configured name of a listed light that mDNS announces first", async () => {
    // Both were off at startup, so both wait in the retry queue.
    expect(other.devices.size).toBe(0);
    expect(other.pendingRetries.size).toBe(2);
    const register = vi.spyOn(other, "registerDevice");
    try {
      await door.start();
      await shelf.start();
      // Before their retries come round, they announce themselves: one matches its
      // entry by address, the other by its `.local` name.
      const doorUp = registered("CW33J1A09011");
      browser.emit(
        "up",
        announcement({
          name: "Elgato Key Light 7F7F",
          host: "elgato-key-light-7f7f.local",
          port: door.port,
          addresses: ["127.0.0.1"],
        }),
      );
      await doorUp;
      const shelfUp = registered("CW33J1A09012");
      browser.emit(
        "up",
        announcement({
          name: "Elgato Key Light 1E1E",
          host: "elgato-key-light-1e1e.local",
          port: shelf.port,
          addresses: ["127.0.0.1"],
        }),
      );
      await shelfUp;

      expect(other.devices.get("CW33J1A09011")?.deviceName).toBe("Door Light");
      expect(other.devices.get("CW33J1A09012")?.deviceName).toBe("Shelf Light");
      expect(other.pendingRetries.size).toBe(0);
      await other.retryPending({ force: true });
      expect(register).toHaveBeenCalledTimes(2);
    } finally {
      register.mockRestore();
    }
  });

  /**
   * Register a light of its own through an IPv4 announcement, then take it off the
   * network until the poll loop reports it unreachable. Each test that needs a light
   * that moved starts from here, so none depends on another.
   */
  const lostLight = async (serial: string, label: string) => {
    const mock = extraLight(serial, `Elgato Key Light ${label}`);
    await mock.start();
    const name = `elgato-key-light-${label.toLowerCase()}.local`;
    const up = registered(serial);
    browser.emit(
      "up",
      announcement({
        name: `Elgato Key Light ${label}`,
        host: name,
        port: mock.port,
        addresses: ["127.0.0.1"],
      }),
    );
    await up;
    await mock.stop();
    const device = other.devices.get(serial);
    for (let i = 0; i < 3; i += 1) await other.pollAll();
    expect(device?.reachable).toBe(false);
    return { mock, name, device };
  };

  /** A light answering on 127.0.0.2 (Linux only), standing in for a new DHCP lease. */
  const onNewLease = async (
    serial: string,
    port: number,
  ): Promise<MockElgatoDevice | undefined> => {
    const mock = new MockElgatoDevice({ model: "key-light-air", port, listenHost: "127.0.0.2" });
    mock.info.serialNumber = serial;
    try {
      await mock.start();
      return mock;
    } catch {
      return undefined;
    }
  };

  it("follows a registered light to a new address when it stops answering", async (ctx) => {
    const serial = "CW33J1A09015";
    const { mock, name, device } = await lostLight(serial, "2F2F");
    const moved = await onNewLease(serial, mock.port);
    if (!moved) {
      ctx.skip("127.0.0.2 is not a loopback address on this host");
      return;
    }
    const notice = vi.spyOn(other.log, "notice");
    try {
      // Lost, so its name is looked up straight away; nothing has answered yet.
      const before = mdns.queries.length;
      await other.retryPending();
      expect(mdns.queries.length).toBeGreaterThan(before);
      expect(other.registry.get(serial)?.client.host).toBe("127.0.0.1");
      // The next lookup waits out the backoff.
      const after = mdns.queries.length;
      await other.retryPending();
      expect(mdns.queries).toHaveLength(after);

      // The light comes back on its new lease and announces its A record.
      mdns.emit("response", aRecordPacket(name, "127.0.0.2"));
      await other.retryPending({ force: true });
      expect(other.registry.get(serial)?.client.host).toBe("127.0.0.2");
      expect(lines(notice)).toContain(`Device ${serial} is now at 127.0.0.2:${mock.port}`);

      await other.pollAll();
      expect(device?.reachable).toBe(true);
    } finally {
      notice.mockRestore();
      await moved.stop();
    }
  });

  it("stays put when another light answers at the address its name now points to", async (ctx) => {
    const serial = "CW33J1A09016";
    const { mock, name, device } = await lostLight(serial, "3A3A");
    // A different light holds the lease the name points at.
    const stranger = await onNewLease("CW33J1A09099", mock.port);
    if (!stranger) {
      ctx.skip("127.0.0.2 is not a loopback address on this host");
      return;
    }
    const register = vi.spyOn(other, "registerDevice");
    try {
      const devices = other.devices.size;
      mdns.emit("response", aRecordPacket(name, "127.0.0.2"));
      await other.retryPending({ force: true });

      expect(stranger.requests.map((request) => request.path)).toContain("/elgato/accessory-info");
      expect(other.registry.get(serial)?.client.host).toBe("127.0.0.1");
      expect(device?.reachable).toBe(false);
      // Nor is the stranger taken on from here.
      expect(other.devices.size).toBe(devices);
      expect(register).not.toHaveBeenCalled();
    } finally {
      register.mockRestore();
      await stranger.stop();
    }
  });
});

describe("a devices entry whose light is registered", () => {
  it("does not lend its name to another light that took over the address", async () => {
    const first = extraLight("CW33J1A09017", "Elgato Key Light 4C4C");
    await first.start();
    const host = `127.0.0.1:${first.port}`;
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [{ host, name: "Door Light" }] }),
    );
    addMatterbridge(other);
    let second: MockElgatoDevice | undefined;
    try {
      await other.onStart("lease swap");
      await other.onConfigure();
      expect(other.devices.get("CW33J1A09017")?.deviceName).toBe("Door Light");

      // The first light leaves and a second one gets its old lease.
      await first.stop();
      second = new MockElgatoDevice({ model: "key-light-air", port: first.port });
      second.info.serialNumber = "CW33J1A09018";
      second.info.displayName = "Elgato Key Light 5D5D";
      await second.start();
      // Node's fetch may still hold a keep-alive socket to the first light, and a
      // probe that meets it gets "other side closed", which reads as an MK.2. Each
      // failed fetch drops a dead socket from the shared pool, so wait until the
      // address answers as the new light.
      const url = `${second.url}/elgato/accessory-info`;
      await vi.waitFor(async () => {
        const answered = await fetch(url).then(
          (response) => response.ok,
          () => false,
        );
        expect(answered).toBe(true);
      });
      await other.addDiscoveredService({
        instanceName: "Elgato Key Light 5D5D",
        host: "127.0.0.1",
        hostname: "elgato-key-light-5d5d.local",
        port: first.port,
        txt: {},
      });

      expect(other.unsupportedCount).toBe(0);
      expect(other.devices.get("CW33J1A09018")?.deviceName).toBe("Elgato Key Light 5D5D");
      expect(other.devices.get("CW33J1A09017")?.deviceName).toBe("Door Light");
    } finally {
      await other.onShutdown("lease swap");
      await second?.stop();
    }
  });
});

describe("retrying lights that did not answer", () => {
  it("registers a light exactly once after a failed probe and a later success", async () => {
    const flaky = await switchedOff("CW33J1A09003", "Flaky Key Light 0C0D");
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [] }),
    );
    addMatterbridge(other);
    await other.onStart("flaky");
    await other.onConfigure();
    const error = vi.spyOn(other.log, "error");
    const info = vi.spyOn(other.log, "info");
    const register = vi.spyOn(other, "registerDevice");
    const service: DiscoveredService = {
      instanceName: "Flaky Key Light 0C0D",
      host: "127.0.0.1",
      port: flaky.port,
      txt: {},
    };
    try {
      await other.addDiscoveredService(service);
      expect(other.devices.size).toBe(0);
      expect(other.pendingRetries.get(service.instanceName)).toMatchObject({
        host: `127.0.0.1:${flaky.port}`,
        retries: 0,
        delayMs: 10_000,
      });

      // Still off: a second announcement and a retry are not new errors.
      await other.addDiscoveredService(service);
      await other.retryPending({ force: true });
      expect(other.pendingRetries.get(service.instanceName)).toMatchObject({
        retries: 1,
        delayMs: 20_000,
      });
      expect(lines(error).filter((line) => line.startsWith("Could not add"))).toHaveLength(1);

      // Not due yet, so an ordinary tick leaves it alone.
      await other.retryPending();
      expect(other.pendingRetries.get(service.instanceName)?.retries).toBe(1);

      await flaky.start();
      await other.retryPending({ force: true });
      expect(other.devices.size).toBe(1);
      expect(other.pendingRetries.size).toBe(0);
      expect(lines(info)).toContain(
        `Added the Elgato device at 127.0.0.1:${flaky.port} after 2 retries`,
      );

      // Later ticks and announcements find it known.
      await other.retryPending({ force: true });
      await other.addDiscoveredService(service);
      expect(register).toHaveBeenCalledTimes(1);
      expect(other.devices.size).toBe(1);
    } finally {
      error.mockRestore();
      info.mockRestore();
      register.mockRestore();
      await other.onShutdown("flaky");
      await flaky.stop();
    }
  });

  it("registers a configured light that was off at startup once it comes up", async () => {
    const desk = await switchedOff("CW33J1A09004", "Desk Key Light 0E0F");
    const host = `127.0.0.1:${desk.port}`;
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [{ host, name: "Desk Light" }] }),
    );
    addMatterbridge(other);
    try {
      await other.onStart("desk");
      expect(other.devices.size).toBe(0);
      expect(other.pendingRetries.get(host)).toMatchObject({
        host,
        options: { name: "Desk Light" },
      });

      await other.onConfigure();
      await desk.start();
      await other.retryPending({ force: true });

      const device = other.devices.get("CW33J1A09004");
      expect(device?.deviceName).toBe("Desk Light");
      expect(aggregator.parts.has(device?.endpoint as MatterbridgeEndpoint)).toBe(true);
      expect(other.pendingRetries.size).toBe(0);
    } finally {
      await other.onShutdown("desk");
      await desk.stop();
    }
  });

  it("never retries an MK.2 or a host the lists rejected", async () => {
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({
        devices: [{ host: mk2Mock.host }, { host: `127.0.0.1:${keyLightMock.port}` }],
        blackList: [KEY_LIGHT_SERIAL],
      }),
    );
    addMatterbridge(other);
    const parked = await switchedOff("CW33J1A09005", "Parked Key Light 1A1A");
    try {
      await other.onStart("never retry");
      await other.onConfigure();
      await other.addDiscoveredService(mk2Service);
      expect(other.unsupportedCount).toBe(2);
      expect(other.pendingRetries.size).toBe(0);

      // A light queued while off that turns out to be an MK.2 leaves the queue.
      const mk2Later: DiscoveredService = {
        ...mk2Service,
        instanceName: "Elgato Key Light Air MK.2 7A7B",
        host: "127.0.0.1",
        port: parked.port,
        txt: {},
      };
      await other.addDiscoveredService(mk2Later);
      expect(other.pendingRetries.size).toBe(1);
      await other.addDiscoveredService({ ...mk2Later, txt: MK2_TXT });
      expect(other.pendingRetries.size).toBe(0);

      const connections = mk2Mock.connections;
      const requests = keyLightMock.requests.length;
      await other.retryPending({ force: true });
      await other.executeIntervals(1);
      expect(mk2Mock.connections).toBe(connections);
      expect(keyLightMock.requests.length).toBe(requests);
      expect(other.devices.size).toBe(0);
    } finally {
      await other.onShutdown("never retry");
    }
  });

  it("drops a queued host once it turns out to be rejected or unsupported", async () => {
    const blocked = await switchedOff("CW33J1A09006", "Blocked Key Light 2B2B");
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({
        devices: [{ host: `127.0.0.1:${blocked.port}` }, { host: mk2Mock.host }],
        blackList: ["CW33J1A09006"],
      }),
    );
    addMatterbridge(other);
    try {
      // Both start out queued as merely unreachable.
      mk2Mock.connections = 0;
      await mk2Mock.stop();
      await other.onStart("drop");
      await other.onConfigure();
      expect(other.pendingRetries.size).toBe(2);

      // Back up, one blacklisted and one an MK.2: each gets one probe that decides it.
      await blocked.start();
      await mk2Mock.start();
      await other.retryPending({ force: true });
      expect(other.pendingRetries.size).toBe(0);
      expect(other.devices.size).toBe(0);
      expect(mk2Mock.connections).toBe(1);
    } finally {
      await other.onShutdown("drop");
      await blocked.stop();
    }
  });

  it("clears the queue on shutdown and probes nothing afterwards", async () => {
    const gone = await switchedOff("CW33J1A09007", "Gone Key Light 3C3C");
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [{ host: `127.0.0.1:${gone.port}` }] }),
    );
    addMatterbridge(other);
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      await other.onStart("retry shutdown");
      await other.onConfigure();
      expect(other.pendingRetries.size).toBe(1);
      const timers = other.intervals.map(({ interval }) => interval);
      expect(timers).toHaveLength(2);

      await other.onShutdown("retry shutdown");
      expect(other.intervals).toHaveLength(0);
      expect(other.pendingRetries.size).toBe(0);
      for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer);

      await gone.start();
      await other.retryPending({ force: true });
      expect(gone.requests).toHaveLength(0);
      expect(other.devices.size).toBe(0);
    } finally {
      clear.mockRestore();
      await gone.stop();
    }
  });

  it("does not hold up the poll loop while a retry waits on a silent light", async () => {
    const stuck = await switchedOff("CW33J1A09008", "Stuck Key Light 4D4D");
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({
        devices: [{ host: `127.0.0.1:${keyLightMock.port}` }, { host: `127.0.0.1:${stuck.port}` }],
      }),
    );
    addMatterbridge(other);
    try {
      await other.onStart("stuck");
      await other.onConfigure();
      expect(other.pendingRetries.size).toBe(1);

      // Up again, but it takes the request and never answers.
      await stuck.start();
      stuck.fault = "hang";
      let retried = false;
      const retry = other.retryPending({ force: true }).then(() => {
        retried = true;
      });
      await vi.waitFor(() => {
        expect(stuck.requests).toHaveLength(1);
      });

      const polls = keyLightMock.requests.length;
      await other.pollAll();
      expect(keyLightMock.requests.length).toBeGreaterThan(polls);
      expect(retried).toBe(false);

      await stuck.stop();
      await retry;
    } finally {
      await other.onShutdown("stuck");
    }
  });

  it("keeps one entry, then one device, when a light announces a name and then an IPv4", async () => {
    const lamp = extraLight("CW33J1A09009", "Elgato Key Light Mini 5E5E");
    await lamp.start();
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [] }),
    );
    addMatterbridge(other);
    const register = vi.spyOn(other, "registerDevice");
    const byName: DiscoveredService = {
      instanceName: "Elgato Key Light Mini 5E5E",
      host: UNRESOLVABLE,
      hostname: UNRESOLVABLE,
      port: lamp.port,
      txt: {},
    };
    try {
      await other.onStart("name then address");
      await other.onConfigure();
      await other.addDiscoveredService(byName);
      expect([...other.pendingRetries.keys()]).toEqual([byName.instanceName]);

      // The next announcement brings the address, racing a probe by another host string.
      const { hostname: _unused, ...rest } = byName;
      await Promise.all([
        other.addDiscoveredService({ ...rest, host: "127.0.0.1" }),
        other.addDeviceByHost(`localhost:${lamp.port}`),
      ]);
      expect(other.devices.size).toBe(1);
      expect(other.pendingRetries.size).toBe(0);

      await other.retryPending({ force: true });
      expect(register).toHaveBeenCalledTimes(1);
    } finally {
      register.mockRestore();
      await other.onShutdown("name then address");
      await lamp.stop();
    }
  });
});

describe("probes that finish late", () => {
  it("does not register a light whose probe was still out at shutdown", async () => {
    const slow = extraLight("CW33J1A09013", "Slow Key Light 6A6A");
    await slow.start();
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [] }),
    );
    addMatterbridge(other);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ElgatoClient.prototype.getLights;
    const lights = vi
      .spyOn(ElgatoClient.prototype, "getLights")
      .mockImplementation(async function (this: ElgatoClient) {
        if (this.port === slow.port) await gate;
        return original.call(this);
      });
    const register = vi.spyOn(other, "registerDevice");
    try {
      await other.onStart("late probe");
      await other.onConfigure();
      // accessory-info has answered; the lights read is held until after shutdown.
      const adding = other.addDeviceByHost(`127.0.0.1:${slow.port}`);
      await vi.waitFor(() => {
        expect(slow.requests.map((request) => request.path)).toContain("/elgato/accessory-info");
      });
      await other.onShutdown("late probe");
      release();

      expect(await adding).toBeUndefined();
      expect(other.devices.size).toBe(0);
      expect(register).not.toHaveBeenCalled();
    } finally {
      release();
      lights.mockRestore();
      register.mockRestore();
      await slow.stop();
    }
  });

  it("neither queues nor reports a failed probe of a light that is already registered", async () => {
    const lamp = extraLight("CW33J1A09014", "Elgato Key Light Mini 7B7B");
    await lamp.start();
    const other = new ElgatoPlatform(
      getMatterbridge(),
      log as AnsiLogger,
      makeConfig({ devices: [] }),
    );
    addMatterbridge(other);
    const error = vi.spyOn(other.log, "error");
    const announced: DiscoveredService = {
      instanceName: "Elgato Key Light Mini 7B7B",
      host: "127.0.0.1",
      hostname: UNRESOLVABLE,
      port: lamp.port,
      txt: {},
    };
    try {
      await other.onStart("late failure");
      await other.onConfigure();
      await other.addDiscoveredService(announced);
      expect(other.devices.size).toBe(1);

      // The same light's name-only announcement, whose probe fails after the IPv4 won.
      await other.addDiscoveredService({ ...announced, host: UNRESOLVABLE });
      expect(lines(error)).toEqual([]);
      expect(other.pendingRetries.size).toBe(0);
    } finally {
      error.mockRestore();
      await other.onShutdown("late failure");
      await lamp.stop();
    }
  });
});

describe("shutdown", () => {
  it("clears the poll interval and leaves the bridged endpoints in place", async () => {
    expect(platform.getDevices()).toHaveLength(3);
    await platform.onShutdown("vitest");
    expect(platform.intervals).toHaveLength(0);
    // `unregisterOnShutdown` is false, so the endpoints stay on the aggregator; the
    // platform's own registry is cleared by MatterbridgePlatform.destroy().
    expect(platform.devices.size).toBe(3);
  });
});
