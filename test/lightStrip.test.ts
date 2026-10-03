/**
 * The Light Strip's `preserveSceneOnOff` flag (GitHub issue #3), end to end: the real
 * platform on a real Matter server node, driving two mock devices, with the wire
 * traffic read back byte for byte from the mocks.
 *
 * The platform's own poll timer is cleared after `onConfigure`, and polls are driven
 * by hand with `pollAll()`, so a background tick can never land between a command
 * and the assertion that follows it.
 */

import type { MatterbridgeEndpoint, PlatformConfig } from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import { LevelControl, OnOff } from "matterbridge/matter/clusters";
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MockElgatoDevice, RAINBOW_SCENE } from "../scripts/mock-elgato.ts";
import type { LightStripDevice } from "../src/devices/lightStrip.ts";
import { ElgatoPlatform } from "../src/index.ts";
import { PluginStorage } from "../src/pluginStorage.ts";

/** Not 5540, 5561 (platform tests) or 5562 (live tests). */
const MATTER_TEST_PORT = 5563;

interface Rig {
  platform: ElgatoPlatform;
  keyLightMock: MockElgatoDevice;
  stripMock: MockElgatoDevice;
  keyLight: MatterbridgeEndpoint;
  strip: MatterbridgeEndpoint;
  device: LightStripDevice;
}

const rigs: Rig[] = [];

const boot = async (overrides: Partial<PlatformConfig> = {}): Promise<Rig> => {
  const keyLightMock = new MockElgatoDevice({ model: "key-light-air" });
  const stripMock = new MockElgatoDevice({ model: "light-strip" });
  // Every rig gets its own serials: one server node cannot register a serial twice.
  const keyLightSerial = `CW33J1A0${100 + rigs.length}`;
  const stripSerial = `EW52J1A0${100 + rigs.length}`;
  keyLightMock.info.serialNumber = keyLightSerial;
  stripMock.info.serialNumber = stripSerial;
  await keyLightMock.start();
  await stripMock.start();
  const platform = new ElgatoPlatform(
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
      devices: [
        { host: `127.0.0.1:${keyLightMock.port}` },
        { host: `127.0.0.1:${stripMock.port}` },
      ],
      whiteList: [],
      blackList: [],
      ...overrides,
    } as PlatformConfig,
  );
  addMatterbridge(platform);
  await platform.onStart("lightStrip");
  await platform.onConfigure();
  platform.clearIntervals();
  const rig: Rig = {
    platform,
    keyLightMock,
    stripMock,
    keyLight: platform.getDeviceBySerialNumber(keyLightSerial) as MatterbridgeEndpoint,
    strip: platform.getDeviceBySerialNumber(stripSerial) as MatterbridgeEndpoint,
    device: platform.devices.get(stripSerial) as LightStripDevice,
  };
  expect(rig.keyLight).toBeDefined();
  expect(rig.strip).toBeDefined();
  rigs.push(rig);
  return rig;
};

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

/** Raw bodies of every PUT a mock has seen since `from`. */
const putsSince = (mock: MockElgatoDevice, from = 0): string[] =>
  mock.requests
    .slice(from)
    .filter((request) => request.method === "PUT")
    .map((request) => request.body ?? "");

// Captured from v0.1 (main at 5d51094) before `preserveSceneOnOff` existed, and pasted
// here verbatim: with the flag unset, not one byte on the wire may change.
const BARE_OFF = '{"numberOfLights":1,"lights":[{"on":0}]}';
const BARE_ON = '{"numberOfLights":1,"lights":[{"on":1}]}';
const RAINBOW_ELEMENTS =
  '[{"hue":0,"saturation":100,"brightness":100,"durationMs":2000,"transitionMs":10000},' +
  '{"hue":60,"saturation":100,"brightness":100,"durationMs":2000,"transitionMs":10000},' +
  '{"hue":120,"saturation":100,"brightness":100,"durationMs":2000,"transitionMs":10000},' +
  '{"hue":180,"saturation":100,"brightness":100,"durationMs":2000,"transitionMs":10000},' +
  '{"hue":240,"saturation":100,"brightness":100,"durationMs":2000,"transitionMs":10000},' +
  '{"hue":300,"saturation":100,"brightness":100,"durationMs":2000,"transitionMs":10000}]';
const RAINBOW_REPLAY =
  '{"numberOfLights":1,"lights":[{"on":1,"id":"com.corsair.cc.scene.rainbow","name":"Rainbow",' +
  `"brightness":98,"numberOfSceneElements":6,"scene":${RAINBOW_ELEMENTS}}]}`;
const GOLDEN_STRIP = [BARE_OFF, RAINBOW_REPLAY, BARE_OFF, RAINBOW_REPLAY, BARE_OFF, BARE_ON];
const GOLDEN_KEY_LIGHT = [BARE_OFF, BARE_ON];
/** The scene-preserving off: the replay body with `on: 0`, keys in the same order. */
const RAINBOW_PARK = RAINBOW_REPLAY.replace('[{"on":1,', '[{"on":0,');

/** Scene master brightness 98 as Matter CurrentLevel. */
const SCENE_LEVEL = 249;

beforeAll(async () => {
  await setupTest("ElgatoLightStrip", false);
  await createTestEnvironment();
  await createServerNode(MATTER_TEST_PORT);
  await startServerNode();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const rig of rigs) {
    await rig.platform.onShutdown("lightStrip complete");
    await rig.keyLightMock.stop();
    await rig.stripMock.stop();
  }
  await stopServerNode();
});

describe("preserveSceneOnOff unset (the default)", () => {
  it("sends the same bytes as v0.1 across scene, HSV and Key Light on/off", async () => {
    const { platform, keyLightMock, stripMock, keyLight, strip } = await boot();
    stripMock.scene = { ...RAINBOW_SCENE };
    await platform.pollAll();

    const from = stripMock.requests.length;
    await command(strip, "off");
    await platform.pollAll();
    await command(strip, "on");
    await command(strip, "moveToLevelWithOnOff", { level: 1 });
    await command(strip, "on");
    stripMock.scene = undefined;
    await platform.pollAll();
    await command(strip, "off");
    await command(strip, "on");

    const keyFrom = keyLightMock.requests.length;
    await command(keyLight, "off");
    await command(keyLight, "on");

    expect(putsSince(stripMock, from)).toEqual(GOLDEN_STRIP);
    expect(putsSince(keyLightMock, keyFrom)).toEqual(GOLDEN_KEY_LIGHT);
  });

  it("treats anything but `true` as off", async () => {
    // A hand-edited config may carry a string; only the real boolean turns it on.
    const { platform, stripMock, strip } = await boot({ preserveSceneOnOff: "true" });
    stripMock.scene = { ...RAINBOW_SCENE };
    await platform.pollAll();
    const from = stripMock.requests.length;
    await command(strip, "off");
    expect(putsSince(stripMock, from)).toEqual([BARE_OFF]);
  });
});

describe("preserveSceneOnOff on, strip already parked in a scene when the bridge starts", () => {
  it("puts the scene back on the first on, instead of a bare on that would lose it", async () => {
    // A bare `on: 1` from a parked scene reverts to HSV (docs/elgato-protocol.md,
    // addendum). After a bridge restart there is no resume intent, only the parked state.
    const { platform, stripMock, strip, device } = await boot({ preserveSceneOnOff: true });
    stripMock.scene = { ...RAINBOW_SCENE, on: 0 };
    await platform.pollAll();
    expect(device.sceneParked).toBe(true);
    expect(device.resumeScene).toBe(false);
    expect(strip.getAttribute(OnOff.id, "onOff")).toBe(false);

    const from = stripMock.requests.length;
    await command(strip, "on");
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_REPLAY]);
    expect(stripMock.scene).toMatchObject({ on: 1, id: "com.corsair.cc.scene.rainbow" });
  });
});

describe("preserveSceneOnOff on", () => {
  let rig: Rig;

  beforeAll(async () => {
    rig = await boot({ preserveSceneOnOff: true });
  });

  /** Put the strip into a running Rainbow and let one poll see it. */
  const playRainbow = async (): Promise<void> => {
    rig.stripMock.sceneFaults = [];
    rig.stripMock.fault = "none";
    rig.stripMock.scene = { ...RAINBOW_SCENE };
    await rig.platform.pollAll();
    expect(rig.device.sceneActive).toBe(true);
    expect(rig.device.sceneParked).toBe(false);
  };

  it("parks the strip with one PUT of the scene body plus `on: 0`, and a GET still shows 4c", async () => {
    const { stripMock, strip, device } = rig;
    await playRainbow();
    expect(strip.getAttribute(LevelControl.id, "currentLevel")).toBe(SCENE_LEVEL);

    const from = stripMock.requests.length;
    await command(strip, "off");
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK]);

    // What a following GET returns: still schema 4c, switched off.
    const response = await fetch(`${stripMock.url}/elgato/lights`);
    const [state] = ((await response.json()) as { lights: Record<string, unknown>[] }).lights;
    expect(state).toMatchObject({ on: 0, id: "com.corsair.cc.scene.rainbow" });
    expect(state?.scene).toHaveLength(6);
    expect(state).not.toHaveProperty("hue");

    expect(device.sceneParked).toBe(true);
    expect(device.resumeScene).toBe(true);
    // The level stays on the scene master brightness; a bare off would have dropped it
    // to the previous HSV brightness.
    expect(strip.getAttribute(LevelControl.id, "currentLevel")).toBe(SCENE_LEVEL);
  });

  it("reads the parked strip on a poll as off, keeps the level, and keeps the cache", async () => {
    const { platform, stripMock, strip, device } = rig;
    const from = stripMock.requests.length;
    await platform.pollAll();
    await platform.pollAll();

    expect(putsSince(stripMock, from)).toEqual([]);
    expect(strip.getAttribute(OnOff.id, "onOff")).toBe(false);
    expect(strip.getAttribute(LevelControl.id, "currentLevel")).toBe(SCENE_LEVEL);
    expect(device.sceneActive).toBe(true);
    expect(device.sceneParked).toBe(true);
    expect(device.resumeScene).toBe(true);
    expect(device.cachedScene).toMatchObject({
      id: RAINBOW_SCENE.id,
      name: RAINBOW_SCENE.name,
      brightness: RAINBOW_SCENE.brightness,
      scene: RAINBOW_SCENE.scene,
    });
  });

  it("puts the scene back on Matter On with exactly one PUT, and the state follows", async () => {
    const { platform, stripMock, strip, device } = rig;
    const from = stripMock.requests.length;
    await command(strip, "on");

    // Neither skipped (a bare on would lose the scene) nor fired twice.
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_REPLAY]);
    expect(device.resumeScene).toBe(false);
    expect(device.sceneParked).toBe(false);
    expect(stripMock.scene).toMatchObject({ on: 1, id: "com.corsair.cc.scene.rainbow" });

    await platform.pollAll();
    expect(strip.getAttribute(OnOff.id, "onOff")).toBe(true);
    expect(strip.getAttribute(LevelControl.id, "currentLevel")).toBe(SCENE_LEVEL);
  });

  it("parks on a level command cropped to off, too", async () => {
    const { stripMock, strip, device } = rig;
    await playRainbow();
    const from = stripMock.requests.length;
    await command(strip, "moveToLevelWithOnOff", { level: 1 });
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK]);
    expect(device.sceneParked).toBe(true);

    await command(strip, "on");
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK, RAINBOW_REPLAY]);
  });

  it("sends a bare off with no scene running, as before", async () => {
    const { platform, stripMock, strip, device } = rig;
    stripMock.scene = undefined;
    await platform.pollAll();
    expect(device.sceneActive).toBe(false);
    expect(device.resumeScene).toBe(false);

    const from = stripMock.requests.length;
    await command(strip, "off");
    await command(strip, "on");
    expect(putsSince(stripMock, from)).toEqual([BARE_OFF, BARE_ON]);
  });

  it.each([400, 500] as const)(
    "falls back to exactly one bare off when the strip answers the scene body with %i",
    async (status) => {
      const { platform, stripMock, strip, device } = rig;
      await playRainbow();
      const debug = vi.spyOn(platform.log, "debug");
      const error = vi.spyOn(platform.log, "error");
      stripMock.sceneFaults = [status];

      const from = stripMock.requests.length;
      await command(strip, "off");

      expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK, BARE_OFF]);
      // The light went off the way a bare off leaves it: scene gone, previous HSV.
      expect(stripMock.scene).toBeUndefined();
      expect(stripMock.currentState.on).toBe(0);
      expect(device.sceneActive).toBe(false);
      expect(device.resumeScene).toBe(true);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(`returned ${status}`));
      expect(error).not.toHaveBeenCalled();

      await platform.pollAll();
      expect(strip.getAttribute(OnOff.id, "onOff")).toBe(false);

      // The cached scene still comes back on the next on, as in v0.1.
      const resumeFrom = stripMock.requests.length;
      await command(strip, "on");
      expect(putsSince(stripMock, resumeFrom)).toEqual([RAINBOW_REPLAY]);
      expect(stripMock.scene).toMatchObject({ on: 1, id: "com.corsair.cc.scene.rainbow" });
    },
  );

  it("sends nothing more when the strip drops the connection on the park", async () => {
    const { platform, stripMock, strip, device } = rig;
    await playRainbow();
    const error = vi.spyOn(platform.log, "error");
    stripMock.fault = "offline";

    const from = stripMock.requests.length;
    await command(strip, "off");
    stripMock.fault = "none";

    // No reply is no proof of a refusal, so no bare off: the next poll reconciles.
    // (A dropped request's body never arrives, so count the PUTs instead.)
    expect(stripMock.requests.slice(from).filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("did not accept the change"));
    expect(device.resumeScene).toBe(true);
  });

  it("sends nothing more when the park times out, so the worst case stays one timeout", async () => {
    const { platform, stripMock, strip } = rig;
    await playRainbow();
    const error = vi.spyOn(platform.log, "error");
    // The client's 5 s timeout, shortened so the test does not sit it out.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(100));
    stripMock.fault = "hang";

    const from = stripMock.requests.length;
    await command(strip, "off");
    stripMock.fault = "none";

    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("did not accept the change"));
  });

  it("sends nothing more when the park comes back as a garbled 200", async () => {
    const { platform, stripMock, strip } = rig;
    await playRainbow();
    const error = vi.spyOn(platform.log, "error");
    // The strip took the park, but the reply was cut short and does not parse.
    stripMock.sceneFaults = ["garbled"];

    const from = stripMock.requests.length;
    await command(strip, "off");

    // A bare off now would destroy the scene the strip just parked.
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK]);
    expect(stripMock.scene).toMatchObject({ on: 0, id: "com.corsair.cc.scene.rainbow" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("non-JSON body"));
  });

  it("still falls back when the strip refuses the park with an error body on HTTP 200", async () => {
    const { platform, stripMock, strip } = rig;
    await playRainbow();
    const debug = vi.spyOn(platform.log, "debug");
    stripMock.fault = "errors200";

    const from = stripMock.requests.length;
    await command(strip, "off");
    stripMock.fault = "none";

    // The fault answers before reading the body, so count the PUTs: the park, then
    // the bare off (refused the same way, since the fault answers every request).
    expect(putsSince(stripMock, from)).toHaveLength(2);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("error body"));
  });

  it("drops the fallback off when an on overtakes a refused park", async () => {
    const { platform, stripMock, strip, device } = rig;
    await playRainbow();
    stripMock.sceneFaults = [400];

    // On arrives while the park is still on the wire; the strip refuses the park.
    const from = stripMock.requests.length;
    await Promise.all([command(strip, "off"), command(strip, "on")]);
    await device.flush();

    // Without the guard a late bare off followed the replay and switched the light
    // off behind the controller's back, scene destroyed.
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK, RAINBOW_REPLAY]);
    expect(stripMock.scene).toMatchObject({ on: 1, id: "com.corsair.cc.scene.rainbow" });
    expect(device.resumeScene).toBe(false);
    await platform.pollAll();
    expect(strip.getAttribute(OnOff.id, "onOff")).toBe(true);
  });

  it("still falls back when only a color change overtakes a refused park", async () => {
    const { stripMock, strip, device } = rig;
    await playRainbow();
    stripMock.sceneFaults = [400];

    const from = stripMock.requests.length;
    await Promise.all([
      command(strip, "off"),
      command(strip, "moveToHueAndSaturation", { hue: 141, saturation: 254 }),
    ]);
    await device.flush();

    // A color command never powers the light on, so it does not revoke the off:
    // the light ends up off, in the new color, as v0.1 would leave it.
    expect(putsSince(stripMock, from)).toEqual([
      RAINBOW_PARK,
      '{"numberOfLights":1,"lights":[{"hue":200,"saturation":100}]}',
      BARE_OFF,
    ]);
    expect(stripMock.currentState).toMatchObject({ on: 0, hue: 200, saturation: 100 });
  });

  it("keeps the resume intent when an off overtakes the replay", async () => {
    const { stripMock, strip, device } = rig;
    await playRainbow();
    await command(strip, "off");
    expect(device.sceneParked).toBe(true);

    const from = stripMock.requests.length;
    await Promise.all([command(strip, "on"), command(strip, "off")]);
    await device.flush();
    // The off queued behind the replay, so it is a bare one and destroys the scene.
    expect(putsSince(stripMock, from)).toEqual([RAINBOW_REPLAY, BARE_OFF]);
    expect(stripMock.scene).toBeUndefined();
    // The replay's success must not wipe the intent the later off set.
    expect(device.resumeScene).toBe(true);

    const onFrom = stripMock.requests.length;
    await command(strip, "on");
    expect(putsSince(stripMock, onFrom)).toEqual([RAINBOW_REPLAY]);
  });

  it("does not park over a color write still in the queue", async () => {
    const { stripMock, strip, device } = rig;
    await playRainbow();

    // The first color PUT is on the wire (and destroys the scene), the second waits.
    const from = stripMock.requests.length;
    await Promise.all([
      command(strip, "moveToHueAndSaturation", { hue: 100, saturation: 200 }),
      command(strip, "moveToHueAndSaturation", { hue: 10, saturation: 200 }),
      command(strip, "off"),
    ]);
    await device.flush();

    // A park would have swallowed the second color and re-parked a scene the strip
    // no longer has. The bare off merges with the color instead, as in v0.1.
    expect(putsSince(stripMock, from)).toEqual([
      '{"numberOfLights":1,"lights":[{"hue":142,"saturation":79}]}',
      '{"numberOfLights":1,"lights":[{"hue":14,"saturation":79,"on":0}]}',
    ]);
    expect(stripMock.scene).toBeUndefined();
    expect(stripMock.currentState).toMatchObject({ on: 0, hue: 14, saturation: 79 });
  });

  it("does not fall back to a bare off when only the echo of a landed park fails", async () => {
    const { platform, stripMock, strip } = rig;
    await playRainbow();
    const error = vi.spyOn(platform.log, "error");
    vi.spyOn(strip, "updateAttribute").mockRejectedValueOnce(new Error("echo broke"));

    const from = stripMock.requests.length;
    await command(strip, "off");

    expect(putsSince(stripMock, from)).toEqual([RAINBOW_PARK]);
    expect(stripMock.scene).toMatchObject({ on: 0, id: "com.corsair.cc.scene.rainbow" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("echo broke"));
  });

  it("writes the scene store only when the scene changes, not on every poll", async () => {
    const { platform, stripMock, strip } = rig;
    await playRainbow();
    const save = vi.spyOn(PluginStorage.prototype, "rememberScene");

    // Running, parked, and parked for a while: the same scene every time.
    await platform.pollAll();
    await command(strip, "off");
    await platform.pollAll();
    await platform.pollAll();
    expect(save).not.toHaveBeenCalled();

    // A new master brightness is a different scene to put back.
    stripMock.scene = { ...RAINBOW_SCENE, on: 0, brightness: 50 };
    await platform.pollAll();
    await platform.pollAll();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ brightness: 50 });
  });

  it("leaves the Key Light alone: bare on and off, and no scene state at all", async () => {
    const { platform, keyLightMock, keyLight } = rig;
    const keyDevice = platform.devices.get(keyLightMock.info.serialNumber);
    expect(keyDevice).toBeDefined();
    expect(keyDevice).not.toHaveProperty("cachedScene");
    expect(keyDevice).not.toHaveProperty("sceneActive");

    const from = keyLightMock.requests.length;
    await command(keyLight, "off");
    await command(keyLight, "on");
    await command(keyLight, "moveToLevelWithOnOff", { level: 1 });
    expect(putsSince(keyLightMock, from)).toEqual([BARE_OFF, BARE_ON, BARE_OFF]);
  });
});

describe("preserveSceneOnOff on, with a color change waiting in the debounce", () => {
  it("sends the plain off rather than parking", async () => {
    const { platform, stripMock, strip, device } = await boot({
      preserveSceneOnOff: true,
      colorDebounce: 60_000,
    });
    stripMock.scene = { ...RAINBOW_SCENE };
    await platform.pollAll();

    await command(strip, "moveToHue", { hue: 100 });
    const from = stripMock.requests.length;
    await command(strip, "off");
    expect(putsSince(stripMock, from)).toEqual([BARE_OFF]);
    await device.flushPendingColor();
  });
});
