import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MockKeyLightAirMk2 } from "../scripts/mock-elgato-mk2.ts";
import { MockElgatoDevice, RAINBOW_SCENE } from "../scripts/mock-elgato.ts";
import { ElgatoClient, ElgatoHttpError } from "../src/elgato/client.ts";

/** Real HTTP against the mock on an ephemeral port, no fetch mocking anywhere. */
describe("ElgatoClient", () => {
  const keyLight = new MockElgatoDevice({ model: "key-light-air" });
  const strip = new MockElgatoDevice({ model: "light-strip" });
  let keyLightClient: ElgatoClient;
  let stripClient: ElgatoClient;

  beforeAll(async () => {
    keyLightClient = new ElgatoClient("127.0.0.1", {
      port: await keyLight.start(),
      timeoutMs: 2000,
    });
    stripClient = new ElgatoClient("127.0.0.1", { port: await strip.start(), timeoutMs: 2000 });
  });

  afterAll(async () => {
    await keyLight.stop();
    await strip.stop();
  });

  it("reads accessory info", async () => {
    const info = await keyLightClient.getAccessoryInfo();
    expect(info.serialNumber).toBe("CW33J1A00001");
    expect(info.productName).toBe("Elgato Key Light Air");
    expect(info.hardwareBoardType).toBe(200);
  });

  it("reads the CCT light schema", async () => {
    const { numberOfLights, lights } = await keyLightClient.getLights();
    expect(numberOfLights).toBe(1);
    expect(lights[0]).toMatchObject({ on: 1, brightness: 43, temperature: 221 });
  });

  it("reads lights settings", async () => {
    expect((await keyLightClient.getLightsSettings()).powerOnTemperature).toBe(213);
    expect((await stripClient.getLightsSettings()).powerOnHue).toBe(40);
  });

  it("sends partial PUT bodies and gets the full new state back", async () => {
    const off = await keyLightClient.putLights({ on: 0 });
    expect(off.lights[0]).toMatchObject({ on: 0, brightness: 43, temperature: 221 });
    const on = await keyLightClient.putLights({ on: 1 });
    expect(on.lights[0]).toMatchObject({ on: 1, brightness: 43, temperature: 221 });
  });

  it("surfaces the Strip 400 as an ElgatoHttpError", async () => {
    await expect(stripClient.putLights({ hue: 400 })).rejects.toBeInstanceOf(ElgatoHttpError);
    await expect(stripClient.putLights({ hue: 400 })).rejects.toMatchObject({ status: 400 });
  });

  it("treats an `errors` body as a failure even with HTTP 200", async () => {
    strip.fault = "errors200";
    try {
      await expect(stripClient.getLights()).rejects.toThrow(/error body/);
    } finally {
      strip.fault = "none";
    }
  });

  it("marks only an answer that says no as `refused`", async () => {
    // An HTTP error status, or an `errors` body on 200: the device refused.
    await expect(stripClient.putLights({ hue: 400 })).rejects.toMatchObject({ refused: true });
    strip.fault = "errors200";
    try {
      await expect(stripClient.getLights()).rejects.toMatchObject({ refused: true });
    } finally {
      strip.fault = "none";
    }
    // A 200 that does not parse, or no answer at all: the write may still have landed.
    strip.sceneFaults = ["garbled"];
    await expect(stripClient.putLights(RAINBOW_SCENE)).rejects.toMatchObject({
      status: 200,
      refused: false,
    });
    strip.fault = "offline";
    try {
      await expect(stripClient.getLights()).rejects.toMatchObject({ status: 0, refused: false });
    } finally {
      strip.fault = "none";
    }
  });

  it("fails cleanly when the connection drops", async () => {
    strip.fault = "offline";
    try {
      await expect(stripClient.getLights()).rejects.toMatchObject({ status: 0 });
    } finally {
      strip.fault = "none";
    }
  });

  it("times out unreachable hosts instead of hanging", async () => {
    const dead = new ElgatoClient("192.0.2.1", { timeoutMs: 300 });
    await expect(dead.getLights()).rejects.toBeInstanceOf(ElgatoHttpError);
    await expect(dead.getLights()).rejects.toMatchObject({ status: 0 });
  }, 10_000);

  it("never sends an Origin header, which the firmware answers with 403 (CVE-2025-7202)", async () => {
    await keyLightClient.getLights();
    await keyLightClient.putLights({ on: 1 });
    expect(keyLight.requests.length).toBeGreaterThan(1);
    for (const request of keyLight.requests) {
      expect(request.headers.origin).toBeUndefined();
    }
  });

  it("flags a connection that is closed without an HTTP reply", async () => {
    const mk2 = new MockKeyLightAirMk2();
    const client = new ElgatoClient("127.0.0.1", { port: await mk2.start(), timeoutMs: 2000 });
    try {
      await expect(client.getAccessoryInfo()).rejects.toMatchObject({
        status: 0,
        emptyReply: true,
      });
      expect(mk2.connections).toBe(1);
    } finally {
      await mk2.stop();
    }
  });

  it("does not flag an unreachable host as an empty reply", async () => {
    const dead = new ElgatoClient("192.0.2.1", { timeoutMs: 300 });
    await expect(dead.getLights()).rejects.toMatchObject({ emptyReply: false });
  }, 10_000);

  it("probes battery-info once on a light without a battery and never asks again", async () => {
    const client = new ElgatoClient("127.0.0.1", { port: keyLight.port, timeoutMs: 2000 });
    const count = (): number =>
      keyLight.requests.filter((request) => request.path === "/elgato/battery-info").length;
    const before = count();
    expect(client.hasBattery).toBeUndefined();
    expect(await client.probeBattery()).toBeUndefined();
    expect(client.hasBattery).toBe(false);
    expect(await client.probeBattery()).toBeUndefined();
    expect(count() - before).toBe(1);
  });

  it("reads battery-info from a Key Light Mini and remembers it has a battery", async () => {
    const mini = new MockElgatoDevice({ model: "key-light-mini" });
    const client = new ElgatoClient("127.0.0.1", { port: await mini.start(), timeoutMs: 2000 });
    try {
      expect(await client.probeBattery()).toMatchObject({ level: 78.57, status: 2 });
      expect(client.hasBattery).toBe(true);
      expect((await client.getBatteryInfo()).currentBatteryVoltage).toBe(3860);
    } finally {
      await mini.stop();
    }
  });

  it("does not cache a battery probe that got no answer", async () => {
    const mini = new MockElgatoDevice({ model: "key-light-mini" });
    const client = new ElgatoClient("127.0.0.1", { port: await mini.start(), timeoutMs: 2000 });
    try {
      mini.batteryFault = true;
      await expect(client.probeBattery()).rejects.toBeInstanceOf(ElgatoHttpError);
      expect(client.hasBattery).toBeUndefined();
      mini.batteryFault = false;
      expect(await client.probeBattery()).toBeDefined();
      expect(client.hasBattery).toBe(true);
    } finally {
      await mini.stop();
    }
  });

  it("treats a 5xx from battery-info as no answer, and an error body with HTTP 200 as final", async () => {
    const mini = new MockElgatoDevice({ model: "key-light-mini" });
    const client = new ElgatoClient("127.0.0.1", { port: await mini.start(), timeoutMs: 2000 });
    try {
      mini.batteryFault = 500;
      await expect(client.probeBattery()).rejects.toMatchObject({ status: 500, refused: true });
      expect(client.hasBattery).toBeUndefined();
      mini.batteryFault = false;
      mini.fault = "errors200";
      expect(await client.probeBattery()).toBeUndefined();
      expect(client.hasBattery).toBe(false);
    } finally {
      await mini.stop();
    }
  });

  it("brackets IPv6 literals in the base URL and follows host changes", () => {
    const client = new ElgatoClient("192.168.1.50");
    expect(client.baseUrl).toBe("http://192.168.1.50:9123");
    client.host = "fd00::1";
    expect(client.host).toBe("fd00::1");
    expect(client.baseUrl).toBe("http://[fd00::1]:9123");
  });
});
