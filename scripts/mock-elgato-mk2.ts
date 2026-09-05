/**
 * Mock Key Light Air MK.2: a light this plugin cannot drive yet.
 *
 * The real MK.2 advertises the same `_elg._tcp` service on the same port, adds
 * `tls=CERT_1_VER_EN` to its TXT record, and expects a TLS handshake where the older
 * models serve plain HTTP. A plain request gets the socket closed on it with no reply.
 * That is all this mock does, and it is enough to exercise both skip paths in
 * src/elgato/unsupported.ts without owning the hardware.
 */

import { createServer, type Server } from "node:net";

import { Bonjour, type Service } from "bonjour-service";

export const MK2_TXT = {
  pv: "1.0",
  md: "Elgato Key Light Air MK.2 20LAM9901",
  id: "80:7B:1E:00:00:03",
  dt: "214",
  tls: "CERT_1_VER_EN",
  mf: "Elgato",
};

export interface MockKeyLightAirMk2Options {
  port?: number;
  /** Advertise on `_elg._tcp`. Off by default so tests do not touch multicast. */
  advertise?: boolean;
  instanceName?: string;
}

export class MockKeyLightAirMk2 {
  /** How many times something connected. Tests use it to prove the plugin stopped probing. */
  connections = 0;

  #server: Server | undefined;
  #bonjour: Bonjour | undefined;
  #service: Service | undefined;
  #port: number;
  readonly #advertise: boolean;
  readonly #instanceName: string;

  constructor(options: MockKeyLightAirMk2Options = {}) {
    this.#port = options.port ?? 0;
    this.#advertise = options.advertise ?? false;
    this.#instanceName = options.instanceName ?? "Mock Elgato Key Light Air MK.2 5E6F";
  }

  get port(): number {
    return this.#port;
  }

  get host(): string {
    return `127.0.0.1:${this.#port}`;
  }

  async start(): Promise<number> {
    this.#server = createServer((socket) => {
      this.connections += 1;
      // Wait for the request bytes before hanging up, so the client sees an answered
      // connection that produced no HTTP response rather than a refused one.
      socket.on("data", () => socket.destroy());
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(this.#port, "127.0.0.1", resolve);
    });
    this.#port = (this.#server.address() as { port: number }).port;

    if (this.#advertise) {
      this.#bonjour = new Bonjour();
      this.#service = this.#bonjour.publish({
        name: this.#instanceName,
        type: "elg",
        protocol: "tcp",
        port: this.#port,
        txt: MK2_TXT,
      });
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
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }
}
