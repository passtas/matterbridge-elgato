import { afterEach, describe, expect, it } from "vitest";

import { MockElgatoDevice, RAINBOW_SCENE, type MockModel } from "../scripts/mock-elgato.ts";
import { ElgatoClient } from "../src/elgato/client.ts";
import type { LightsResponse } from "../src/elgato/types.ts";

import { fixture, light } from "./helpers/fixtures.ts";

const started: MockElgatoDevice[] = [];

const boot = async (
  model: MockModel,
): Promise<{ mock: MockElgatoDevice; client: ElgatoClient }> => {
  const mock = new MockElgatoDevice({ model });
  started.push(mock);
  const port = await mock.start();
  return { mock, client: new ElgatoClient("127.0.0.1", { port, timeoutMs: 2000 }) };
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((mock) => mock.stop()));
});

describe("mock honors the captured fixtures", () => {
  it("serves the Key Light Air fixtures byte-for-byte", async () => {
    const { client } = await boot("key-light-air");
    expect(await client.getAccessoryInfo()).toEqual(fixture("key-light-air-accessory-info"));
    expect(await client.getLights()).toEqual(fixture<LightsResponse>("key-light-air-lights"));
    expect(await client.getLightsSettings()).toEqual(fixture("key-light-air-lights-settings"));
  });

  it("serves the Light Strip fixtures byte-for-byte", async () => {
    const { client } = await boot("light-strip");
    expect(await client.getAccessoryInfo()).toEqual(fixture("light-strip-accessory-info"));
    expect(await client.getLights()).toEqual(fixture<LightsResponse>("light-strip-lights-hsv"));
    expect(await client.getLightsSettings()).toEqual(fixture("light-strip-lights-settings"));
  });
});

describe("Key Light Air PUT semantics", () => {
  it("preserves unnamed fields on a partial body", async () => {
    const { client } = await boot("key-light-air");
    expect((await client.putLights({ on: 0 })).lights[0]).toEqual({
      on: 0,
      brightness: 43,
      temperature: 221,
    });
    expect((await client.putLights({ on: 1 })).lights[0]).toEqual({
      on: 1,
      brightness: 43,
      temperature: 221,
    });
  });

  it("silently ignores out-of-range brightness and never clamps it", async () => {
    const { client } = await boot("key-light-air");
    expect((await client.putLights({ brightness: 101 })).lights[0]?.brightness).toBe(43);
    expect((await client.putLights({ brightness: -1 })).lights[0]?.brightness).toBe(43);
    expect((await client.putLights({ brightness: 0 })).lights[0]).toMatchObject({
      on: 1,
      brightness: 0,
    });
  });

  it("stores any temperature verbatim, however silly", async () => {
    const { client } = await boot("key-light-air");
    expect((await client.putLights({ temperature: 5000 })).lights[0]?.temperature).toBe(5000);
    expect((await client.putLights({ temperature: 100 })).lights[0]?.temperature).toBe(100);
  });

  it("drops unknown fields but still applies the valid ones", async () => {
    const { client } = await boot("key-light-air");
    const state = (await client.putLights({ hue: 200, brightness: 50 })).lights[0];
    expect(state).toEqual({ on: 1, brightness: 50, temperature: 221 });
    expect(state).not.toHaveProperty("hue");
  });
});

describe("Light Strip PUT semantics", () => {
  it("rejects out-of-range values with 400", async () => {
    const { client } = await boot("light-strip");
    await expect(client.putLights({ hue: 400 })).rejects.toMatchObject({ status: 400 });
    await expect(client.putLights({ saturation: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(client.putLights({ brightness: 101 })).rejects.toMatchObject({ status: 400 });
  });

  it("accepts hue 360 verbatim rather than folding it", async () => {
    const { client } = await boot("light-strip");
    const state = (await client.putLights({ hue: 360, saturation: 100 })).lights[0];
    expect(state).toMatchObject({ hue: 360, saturation: 100 });
  });

  it("switches wholesale into the scene schema and back out again", async () => {
    const { mock, client } = await boot("light-strip");

    const entered = (await client.putLights(RAINBOW_SCENE)).lights[0];
    expect(entered).toMatchObject({
      on: 1,
      id: "com.corsair.cc.scene.rainbow",
      numberOfSceneElements: 6,
    });
    expect(entered?.scene).toHaveLength(6);
    expect(mock.currentState).toBe(mock.scene);

    // A color write destroys the scene: no scene keys at all in the response.
    const afterColor = (
      await client.putLights({ on: 1, hue: 200, saturation: 100, brightness: 50 })
    ).lights[0];
    expect(afterColor).toEqual({ on: 1, hue: 200, saturation: 100, brightness: 50 });
    expect(afterColor).not.toHaveProperty("scene");
  });

  it("destroys the scene on a bare off and reverts to the previous HSV state", async () => {
    const { client } = await boot("light-strip");
    await client.putLights(RAINBOW_SCENE);
    const afterOff = (await client.putLights({ on: 0 })).lights[0];
    expect(afterOff).toEqual({ on: 0, hue: 200, saturation: 100, brightness: 50 });
  });

  it("does not resume a scene on a bare `on: 1` from a parked-off scene", async () => {
    const { client } = await boot("light-strip");
    await client.putLights({ ...RAINBOW_SCENE, on: 0 });
    const resumed = (await client.putLights({ on: 1 })).lights[0];
    // Reverts to the previous HSV object as a whole. Only a full scene body keeps it.
    expect(resumed).toEqual({ on: 1, hue: 200, saturation: 100, brightness: 50 });
    expect(resumed).not.toHaveProperty("scene");
  });

  it("keeps the scene when `on: 0` travels in the same body as the scene", async () => {
    const { client } = await boot("light-strip");
    const parked = (await client.putLights({ ...RAINBOW_SCENE, on: 0 })).lights[0];
    expect(parked).toMatchObject({ on: 0, id: "com.corsair.cc.scene.rainbow" });
    expect(parked?.scene).toHaveLength(6);
  });

  it("truncates fractional hue and saturation like the firmware", async () => {
    const { client } = await boot("light-strip");
    const state = (await client.putLights({ hue: 123.7, saturation: 50.5 })).lights[0];
    expect(state).toMatchObject({ hue: 123, saturation: 50 });
  });

  it("powers the light on when a scene body is written without `on`", async () => {
    const { client } = await boot("light-strip");
    await client.putLights({ on: 0 });
    const { on, ...sceneWithoutOn } = RAINBOW_SCENE;
    expect(on).toBe(1);
    expect((await client.putLights(sceneWithoutOn)).lights[0]?.on).toBe(1);
  });

  it("matches the captured scene fixture shape", async () => {
    const { client } = await boot("light-strip");
    const captured = light("light-strip-lights-scene");
    const replayed = (await client.putLights(captured)).lights[0];
    expect(replayed).toEqual(captured);
  });
});

describe("mock transport quirks", () => {
  it("answers unknown paths with an empty-bodied 404", async () => {
    const { mock } = await boot("key-light-air");
    const response = await fetch(`${mock.url}/elgato/battery-info`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("answers malformed JSON with the same 400 the firmware uses", async () => {
    const { mock } = await boot("key-light-air");
    const response = await fetch(`${mock.url}/elgato/lights`, {
      method: "PUT",
      body: '{"lights":[{"brightness":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: [{ message: "Fail to parse JSON data", code: -1 }],
    });
  });

  it("serves the Strip error object with HTTP 200 on GET /", async () => {
    const { mock } = await boot("light-strip");
    const response = await fetch(`${mock.url}/`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ errors: [{ code: -1 }] });
  });

  it("serves the Key Light Air setup page on GET /", async () => {
    const { mock } = await boot("key-light-air");
    const response = await fetch(`${mock.url}/`);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Elgato Key Light Setup");
  });
});
