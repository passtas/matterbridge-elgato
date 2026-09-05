/**
 * The Key Light Air MK.2 generation (`dt=214`) answers on the same `_elg._tcp`
 * service and the same port 9123, but it speaks mutual-TLS WebSocket with JSON-RPC
 * instead of the plain HTTP API, so this plugin cannot drive it yet.
 *
 * There are two ways to notice one, and both end here: a `tls` key in its mDNS TXT
 * record, and an HTTP probe that connects and is closed on without a reply. Either
 * way the device is remembered, so that a light announcing itself every few seconds
 * does not produce a log line every few seconds.
 */

import type { AnsiLogger } from "matterbridge/logger";

import { deviceTypeName } from "../mapping.ts";
import type { DiscoveredService } from "./types.ts";

/** Where a user can follow, or help with, MK.2 support. */
export const MK2_ISSUE_URL = "https://github.com/passtas/matterbridge-elgato/issues/1";

/**
 * How long a device that only closed the connection on us is left alone. The TXT
 * record is proof, a closed socket is not: a healthy light that dropped one request
 * during boot deserves another try rather than silence until the next restart.
 */
export const EMPTY_REPLY_RETRY_MS = 10 * 60 * 1000;

/** MK.2 firmware publishes `tls=CERT_1_VER_EN`; no other generation carries the key. */
export const usesTlsTransport = (service: DiscoveredService): boolean =>
  service.txt.tls !== undefined;

/** The best name for a device we have never talked to: its mDNS model, else its `dt` code. */
export const advertisedModel = (txt: DiscoveredService["txt"]): string =>
  txt.md ?? deviceTypeName(txt.dt === undefined ? undefined : Number(txt.dt));

interface SkippedDevice {
  model: string;
  /** Set for the `tls` TXT key, which never becomes wrong. */
  permanent: boolean;
  notedAt: number;
}

export class UnsupportedDevices {
  readonly #log: AnsiLogger;
  readonly #now: () => number;
  readonly #byHost = new Map<string, SkippedDevice>();
  readonly #explained = new Set<string>();

  constructor(log: AnsiLogger, now: () => number = Date.now) {
    this.#log = log;
    this.#now = now;
  }

  get count(): number {
    this.#dropExpired();
    return this.#byHost.size;
  }

  /** True while the host should be left alone. */
  has(host: string): boolean {
    this.#dropExpired();
    return this.#byHost.has(host);
  }

  /**
   * Record the device and explain it once. Repeat sightings of the same host, and the
   * confirmation after a retry, go to debug instead.
   */
  note(host: string, model: string, options: { permanent: boolean }): void {
    this.#byHost.set(host, { model, permanent: options.permanent, notedAt: this.#now() });
    const message =
      `${model} at ${host} uses the TLS protocol, which this plugin does not support yet. ` +
      `Follow ${MK2_ISSUE_URL} for progress.`;
    if (this.#explained.has(host)) {
      this.#log.debug(message);
      return;
    }
    this.#explained.add(host);
    this.#log.info(message);
  }

  #dropExpired(): void {
    for (const [host, skipped] of this.#byHost) {
      if (skipped.permanent || this.#now() - skipped.notedAt < EMPTY_REPLY_RETRY_MS) continue;
      this.#byHost.delete(host);
      this.#log.debug(`Trying ${skipped.model} at ${host} again after ${EMPTY_REPLY_RETRY_MS} ms`);
    }
  }
}
