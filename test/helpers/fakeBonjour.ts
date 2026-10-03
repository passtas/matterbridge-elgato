/**
 * A bonjour-service stand-in with no multicast: a browser the test makes announce,
 * and a `server.mdns` socket that answers A queries from a table. It has the shape
 * src/elgato/discovery.ts reaches for, so the A-query path runs exactly as it does
 * against bonjour-service 1.4.4.
 */

import { EventEmitter } from "node:events";

import { ElgatoDiscovery } from "../../src/elgato/discovery.ts";

interface Record {
  name: string;
  type: string;
  ttl?: number;
  data: unknown;
}

/** A packet that carries only a light's A record, as it sends one before its PTR. */
export const aRecordPacket = (name: string, address: string, ttl = 120): object => ({
  answers: [{ name, type: "A", ttl, data: address }],
  additionals: [],
});

export class FakeMdns extends EventEmitter {
  readonly queries: { name: string; type: string }[] = [];
  /** Hostname (as the light spells it) to IPv4. A name missing here gets no answer. */
  readonly answers = new Map<string, string>();
  /**
   * Which query for a name is the first to get an answer. A real light ignores one
   * that lands within 1 s of its own last answer (RFC 6762 §6).
   */
  answerFrom = 1;

  query(name: string, type: string): void {
    this.queries.push({ name, type });
    const address = this.answers.get(name.toLowerCase());
    if (address === undefined) return;
    if (this.queries.filter((query) => query.name === name).length < this.answerFrom) return;
    const answers: Record[] = [
      // Noise first: another host's A, and this host's link-local AAAA.
      { name: "some-other-host.local", type: "A", data: "192.0.2.99" },
      { name: name.toUpperCase(), type: "AAAA", data: "fe80::1" },
    ];
    const additionals: Record[] = [
      { name: `${name.toUpperCase()}.`, type: "A", ttl: 120, data: address },
    ];
    setImmediate(() => this.emit("response", { answers, additionals }));
  }
}

export class FakeBrowser extends EventEmitter {
  updates = 0;
  stopped = false;

  update(): void {
    this.updates += 1;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** A bonjour `Service` as the browser emits it, with only the fields discovery reads. */
export const announcement = (fields: {
  name: string;
  host: string;
  port: number;
  addresses?: string[];
  txt?: object;
}): object => ({ addresses: [], txt: {}, ...fields });

export const fakeDiscovery = (
  options: { resolveTimeoutMs?: number; now?: () => number } = {},
): { discovery: ElgatoDiscovery; browser: FakeBrowser; mdns: FakeMdns } => {
  const mdns = new FakeMdns();
  const browser = new FakeBrowser();
  const discovery = new ElgatoDiscovery({
    createBonjour: () =>
      ({ server: { mdns }, find: () => browser, destroy: () => undefined }) as never,
    resolveTimeoutMs: options.resolveTimeoutMs ?? 100,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { discovery, browser, mdns };
};
