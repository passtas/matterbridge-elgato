#!/usr/bin/env node
/**
 * Mock Elgato device: emulates both HTTP models so the plugin can be developed and
 * tested without strobing a real office.
 *
 * The state machine follows the PUT semantics verified live in
 * docs/elgato-protocol.md: partial bodies, full-state responses, unknown fields
 * dropped in silence, the Key Light Air's "ignore out-of-range brightness, store any
 * temperature" behavior, the Light Strip's HTTP 400, and scene replacement.
 *
 * `npm run mock` starts one of each on ports 9123 and 9124 and advertises them on
 * `_elg._tcp`. Add `--mk2` to also advertise a Key Light Air MK.2, which is the
 * generation this plugin skips (see scripts/mock-elgato-mk2.ts).
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { Bonjour, type Service } from "bonjour-service";

import type { AccessoryInfo, LightPatch, LightState, LightsSettings } from "../src/elgato/types.ts";
import { MOCK_MODELS, type MockModel } from "./mock-elgato-models.ts";
import { MockKeyLightAirMk2 } from "./mock-elgato-mk2.ts";

export { RAINBOW_SCENE, MOCK_MODELS, type MockModel } from "./mock-elgato-models.ts";
export { MockKeyLightAirMk2 } from "./mock-elgato-mk2.ts";

const PARSE_ERROR = { errors: [{ message: "Fail to parse JSON data", code: -1 }] };

const isSceneBody = (patch: LightPatch): boolean =>
  Array.isArray(patch.scene) && patch.scene.length > 0;

export interface MockElgatoOptions {
  model: MockModel;
  port?: number;
  /** Advertise on `_elg._tcp`. Off by default so tests do not touch multicast. */
  advertise?: boolean;
  /** mDNS instance name. Defaults to a "Mock ..." name so it cannot clash with a real light. */
  instanceName?: string;
}

export class MockElgatoDevice {
  readonly model: MockModel;
  readonly info: AccessoryInfo;
  readonly settings: LightsSettings;
  /** Non-scene state; the Strip falls back to this when a scene is destroyed. */
  light: LightState;
  scene: LightState | undefined;
  /** Every request seen, for assertions. */
  readonly requests: { method: string; path: string; headers: IncomingHttpHeaders }[] = [];
  /**
   * Inject failures without unplugging anything: `errors200` reproduces the Strip's
   * "error object with HTTP 200", `offline` drops the connection.
   */
  fault: "none" | "errors200" | "offline" = "none";

  #server: Server | undefined;
  #bonjour: Bonjour | undefined;
  #service: Service | undefined;
  #port: number;
  readonly #advertise: boolean;
  readonly #instanceName: string;

  constructor(options: MockElgatoOptions) {
    const profile = MOCK_MODELS[options.model];
    this.model = options.model;
    this.#port = options.port ?? 0;
    this.#advertise = options.advertise ?? false;
    this.info = { ...profile.info };
    this.settings = { ...profile.settings };
    this.light = { ...profile.light };
    this.#instanceName = options.instanceName ?? `Mock ${profile.info.displayName}`;
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** The light object a GET would return right now. */
  get currentState(): LightState {
    return this.scene ?? this.light;
  }

  async start(): Promise<number> {
    this.#server = createServer((request, response) => {
      this.#handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(this.#port, "127.0.0.1", resolve);
    });
    this.#port = (this.#server.address() as AddressInfo).port;

    if (this.#advertise) {
      this.#bonjour = new Bonjour();
      this.#service = this.#bonjour.publish({
        name: this.#instanceName,
        type: "elg",
        protocol: "tcp",
        port: this.#port,
        txt: MOCK_MODELS[this.model].txt,
      });
      // A name clash with a real light on the LAN must not take the process down.
      this.#service.on("error", () => undefined);
    }
    return this.#port;
  }

  async stop(): Promise<void> {
    this.#service?.stop?.();
    this.#service = undefined;
    this.#bonjour?.destroy();
    this.#bonjour = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? "").split("?")[0] ?? "";
    this.requests.push({ method: request.method ?? "GET", path, headers: request.headers });

    if (this.fault === "offline") {
      request.destroy();
      response.destroy();
      return;
    }
    if (this.fault === "errors200") {
      this.#json(response, 200, { errors: [{ message: "Request not support", code: -1 }] });
      return;
    }

    if (request.method === "GET") {
      switch (path) {
        case "/elgato/lights":
          this.#json(response, 200, { numberOfLights: 1, lights: [this.currentState] });
          return;
        case "/elgato/accessory-info":
          this.#json(response, 200, this.info);
          return;
        case "/elgato/lights/settings":
          this.#json(response, 200, this.settings);
          return;
        case "/":
          // The Strip answers an error object with HTTP 200 here; the Key Light Air
          // serves its setup page.
          if (this.model === "light-strip") {
            this.#json(response, 200, { errors: [{ message: "Request not support", code: -1 }] });
          } else {
            response.writeHead(200, { "content-type": "text/html" });
            response.end("<title>Elgato Key Light Setup</title>");
          }
          return;
        default:
          this.#notFound(response);
          return;
      }
    }

    if (request.method === "PUT" && path === "/elgato/lights") {
      this.#readBody(request)
        .then((body) => {
          this.#putLights(response, body);
        })
        .catch(() => {
          this.#json(response, 400, PARSE_ERROR);
        });
      return;
    }

    this.#notFound(response);
  }

  async #readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  #putLights(response: ServerResponse, body: unknown): void {
    const lights = (body as { lights?: unknown } | null)?.lights;
    if (!Array.isArray(lights) || lights.length === 0) {
      this.#json(response, 400, PARSE_ERROR);
      return;
    }
    const patch = lights[0] as LightPatch;

    if (this.model === "light-strip" && !this.#applyStrip(patch)) {
      this.#json(response, 400, PARSE_ERROR);
      return;
    }
    if (this.model === "key-light-air") this.#applyKeyLight(patch);

    this.#json(response, 200, { numberOfLights: 1, lights: [this.currentState] });
  }

  /** Key Light Air: out-of-range brightness is ignored in silence, temperature stored as sent. */
  #applyKeyLight(patch: LightPatch): void {
    if (patch.on !== undefined) this.light.on = patch.on ? 1 : 0;
    if (patch.brightness !== undefined && patch.brightness >= 0 && patch.brightness <= 100) {
      this.light.brightness = Math.round(patch.brightness);
    }
    if (patch.temperature !== undefined) this.light.temperature = Math.round(patch.temperature);
    // hue, saturation and scene are unknown fields on this model and vanish silently.
  }

  /** Light Strip: 400 on out-of-range; scene writes replace, color and off writes destroy. */
  #applyStrip(patch: LightPatch): boolean {
    if (isSceneBody(patch)) {
      // A scene body powers the light on unless it carries an explicit `on`
      // (verified 2026-09-04: `{on:0, ...scene}` is honored and keeps the scene).
      this.scene = {
        on: patch.on === undefined ? 1 : patch.on ? 1 : 0,
        id: patch.id ?? "com.corsair.cc.scene.custom",
        name: patch.name ?? "Custom",
        brightness: patch.brightness ?? 100,
        numberOfSceneElements: patch.scene?.length ?? 0,
        scene: patch.scene ?? [],
      };
      return true;
    }

    if (patch.hue !== undefined && (patch.hue < 0 || patch.hue > 360)) return false;
    if (patch.saturation !== undefined && (patch.saturation < 0 || patch.saturation > 100))
      return false;
    if (patch.brightness !== undefined && (patch.brightness < 0 || patch.brightness > 100))
      return false;

    const hadScene = this.scene !== undefined;
    const touchesColor =
      patch.hue !== undefined || patch.saturation !== undefined || patch.brightness !== undefined;

    if (hadScene && (touchesColor || patch.on !== undefined)) {
      // Any bare write reverts the device as a whole to the previous HSV object
      // (schema 4b), including `{on:1}` from a strip parked off inside a scene, which
      // does not resume it. Only a full scene body keeps the scene.
      this.scene = undefined;
    }

    const target = this.scene ?? this.light;
    if (patch.on !== undefined) target.on = patch.on ? 1 : 0;
    if (patch.brightness !== undefined) target.brightness = Math.round(patch.brightness);
    // The firmware truncates the fraction: PUT `hue: 123.7` stores `123.0`.
    if (patch.hue !== undefined) target.hue = Math.trunc(patch.hue);
    if (patch.saturation !== undefined) target.saturation = Math.trunc(patch.saturation);
    return true;
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      connection: "keep-alive",
    });
    response.end(payload);
  }

  /** A 404 on this firmware carries no body at all. */
  #notFound(response: ServerResponse): void {
    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "content-length": 0,
    });
    response.end();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];

if (isMain) {
  const devices = [
    new MockElgatoDevice({ model: "key-light-air", port: 9123, advertise: true }),
    new MockElgatoDevice({ model: "light-strip", port: 9124, advertise: true }),
  ];
  const mk2 = process.argv.includes("--mk2")
    ? new MockKeyLightAirMk2({ port: 9125, advertise: true })
    : undefined;

  const shutdown = (): void => {
    void Promise.all([...devices.map((device) => device.stop()), mk2?.stop()]).then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (const device of devices) {
    await device.start();
    // eslint-disable-next-line no-console -- standalone dev tool, not plugin runtime
    console.log(`mock ${device.model} listening on ${device.url} (advertised on _elg._tcp)`);
  }
  if (mk2) {
    await mk2.start();
    // eslint-disable-next-line no-console -- standalone dev tool, not plugin runtime
    console.log(`mock key-light-air-mk2 listening on ${mk2.host} (advertised on _elg._tcp)`);
  }
}
