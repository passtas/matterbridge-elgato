/**
 * mDNS discovery of `_elg._tcp` devices (docs/elgato-protocol.md §1).
 *
 * `bonjour-service` does the work matterbridge's raw `Mdns` codec would leave to us:
 * it parses TXT into an object and attaches the A/AAAA answers to `addresses`, but
 * only the ones that arrived in the same packet as the PTR, and it never revisits
 * them (docs/how-it-works.md, "Addresses from mDNS"). So an announcement without an
 * IPv4 is resolved here, with an A query over bonjour's own socket, before the
 * platform sees it: a container has no nss-mdns, and a `.local` name handed to
 * `fetch` there fails with "fetch failed".
 *
 * Not every light shows up here. Key Light Neo owners report that Control Center
 * finds their light while mDNS clients do not (raine/Lolgato#4), and multicast does
 * not survive every network. The manual `devices` list in the config is the way in
 * for those, and it goes through the same probe.
 */

import { EventEmitter } from "node:events";
import { isIP } from "node:net";

import { Bonjour, type Service } from "bonjour-service";

import type { DiscoveredService } from "./types.ts";

export const ELGATO_SERVICE_TYPE = "elg";

/** How long one A lookup waits for the light to answer before giving up. */
export const RESOLVE_TIMEOUT_MS = 2000;
/**
 * When the A query goes out a second time, inside the lookup window. A light does not
 * repeat an answer within 1 s of its last one (RFC 6762 §6), so a query that lands
 * right after the light's own announcement goes unanswered; one 1 s later gets through.
 */
export const REQUERY_AFTER_MS = 1000;
/** Upper bound on how long an A record heard on the socket is trusted, whatever its TTL. */
export const ADDRESS_CACHE_MAX_MS = 2 * 60_000;
/** Plenty for a home LAN; past it the oldest entries go first. */
const ADDRESS_CACHE_MAX_ENTRIES = 256;

/** Prefer an IPv4 literal: the devices only publish link-local IPv6, which needs a scope id. */
export const pickAddress = (service: Pick<Service, "addresses" | "host">): string | undefined => {
  const ipv4 = service.addresses?.find((address) => address.includes("."));
  if (ipv4) return ipv4;
  const routable = service.addresses?.find((address) => !address.toLowerCase().startsWith("fe80"));
  return routable ?? service.host;
};

export const toDiscoveredService = (service: Service): DiscoveredService | undefined => {
  const host = pickAddress(service);
  if (!host) return undefined;
  return {
    instanceName: service.name,
    host,
    ...(service.host ? { hostname: service.host } : {}),
    port: service.port,
    txt: (service.txt ?? {}) as DiscoveredService["txt"],
  };
};

interface MdnsRecord {
  name: string;
  type: string;
  ttl?: number;
  data: unknown;
}

interface MdnsPacket {
  answers?: MdnsRecord[];
  additionals?: MdnsRecord[];
}

type ResponseListener = (packet: MdnsPacket) => void;

type ErrorListener = (error: Error) => void;

/** The slice of `multicast-dns` that bonjour-service keeps at `bonjour.server.mdns`. */
interface MdnsSocket {
  query(name: string, type: string): void;
  on(event: "response", listener: ResponseListener): unknown;
  on(event: "error", listener: ErrorListener): unknown;
  removeListener(event: "response", listener: ResponseListener): unknown;
  removeListener(event: "error", listener: ErrorListener): unknown;
}

/**
 * bonjour-service 1.4.4 declares `server` private, but it is a plain property
 * (`dist/lib/bonjour.js:15`) holding the multicast-dns instance the browser itself
 * queries through (`bonjour.js:25`). Checked by shape, so a release that moves it
 * costs the A query, not the process.
 */
const mdnsSocketOf = (bonjour: object): MdnsSocket | undefined => {
  const mdns = (bonjour as { server?: { mdns?: Partial<MdnsSocket> } }).server?.mdns;
  if (
    typeof mdns?.query !== "function" ||
    typeof mdns.on !== "function" ||
    typeof mdns.removeListener !== "function"
  ) {
    return undefined;
  }
  return mdns as MdnsSocket;
};

/** DNS names compare case-insensitively, and a trailing dot changes nothing. */
export const normalizeName = (name: string): string => name.replace(/\.$/u, "").toLowerCase();

/** The IPv4 A records in one packet, answers and additionals alike. */
const ipv4Records = (packet: MdnsPacket): (MdnsRecord & { data: string })[] =>
  [...(packet.answers ?? []), ...(packet.additionals ?? [])].filter(
    (record): record is MdnsRecord & { data: string } =>
      record.type === "A" && typeof record.data === "string" && isIP(record.data) === 4,
  );

/** A name only multicast DNS can answer for, such as `elgato-key-light-0a0b.local`. */
export const isMdnsName = (host: string): boolean =>
  isIP(host) === 0 && normalizeName(host).endsWith(".local");

/** The parts of a `Bonjour` this module uses, so tests can hand in a fake. */
export type BonjourLike = Pick<Bonjour, "find" | "destroy">;

export interface ElgatoDiscoveryOptions {
  createBonjour?: () => BonjourLike;
  resolveTimeoutMs?: number;
  now?: () => number;
}

export interface DiscoveryEvents {
  up: [service: DiscoveredService];
  down: [service: DiscoveredService];
  /** The mDNS socket failed (EADDRINUSE, EACCES); lookups are off from here on. */
  warning: [error: Error];
}

/**
 * Thin wrapper so the platform sees plain `up`/`down` events and tests can drive it
 * without multicast. `start()`, `startResolver()` and `stop()` are all idempotent.
 */
export class ElgatoDiscovery extends EventEmitter<DiscoveryEvents> {
  readonly #createBonjour: () => BonjourLike;
  readonly #resolveTimeoutMs: number;
  readonly #now: () => number;
  #bonjour: BonjourLike | undefined;
  #browser: ReturnType<Bonjour["find"]> | undefined;
  /** The socket our listeners hang on, until `stop()`. */
  #socket: MdnsSocket | undefined;
  /** The same socket while it can be used for lookups; cleared by a socket error. */
  #mdns: MdnsSocket | undefined;
  /**
   * Every IPv4 A record heard on the socket, by normalized name. A light sends its A
   * record in packets of its own, before the PTR packet bonjour builds the service
   * from, so by the time that `up` arrives the address is usually already here.
   */
  readonly #addresses = new Map<string, { address: string; expiresAt: number }>();
  readonly #remember: ResponseListener = (packet) => {
    for (const record of ipv4Records(packet)) {
      const name = normalizeName(record.name);
      this.#addresses.delete(name);
      // TTL 0 is a goodbye: the light is giving the address up.
      if (record.ttl === 0) continue;
      const ttlMs = (record.ttl ?? Number.POSITIVE_INFINITY) * 1000;
      this.#addresses.set(name, {
        address: record.data,
        expiresAt: this.#now() + Math.min(ttlMs, ADDRESS_CACHE_MAX_MS),
      });
      if (this.#addresses.size > ADDRESS_CACHE_MAX_ENTRIES) {
        const oldest = this.#addresses.keys().next().value;
        if (oldest !== undefined) this.#addresses.delete(oldest);
      }
    }
  };
  readonly #onSocketError: ErrorListener = (error) => {
    // The `error` listener stays on, so a second error is swallowed the same way.
    this.#socket?.removeListener("response", this.#remember);
    this.#mdns = undefined;
    this.#addresses.clear();
    for (const { finish } of this.#resolving.values()) finish(undefined);
    this.emit("warning", error);
  };
  /** A queries in flight, by normalized name, so an `up` and an `srv-update` share one. */
  readonly #resolving = new Map<
    string,
    { promise: Promise<string | undefined>; finish: (address: string | undefined) => void }
  >();

  constructor(options: ElgatoDiscoveryOptions = {}) {
    super();
    this.#createBonjour = options.createBonjour ?? (() => new Bonjour());
    this.#resolveTimeoutMs = options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Open the mDNS socket for `resolve()` without browsing, so a `.local` host in the
   * manual list can be looked up with discovery turned off. `start()` can follow.
   */
  startResolver(): BonjourLike {
    if (this.#bonjour) return this.#bonjour;
    this.#bonjour = this.#createBonjour();
    this.#socket = mdnsSocketOf(this.#bonjour);
    this.#mdns = this.#socket;
    // multicast-dns emits `error` when it cannot bind 5353 and bonjour-service does
    // not listen for it, so without this the bridge would die on an uncaught throw.
    this.#socket?.on("error", this.#onSocketError);
    this.#socket?.on("response", this.#remember);
    return this.#bonjour;
  }

  start(): void {
    if (this.#browser) return;
    this.#browser = this.startResolver().find({ type: ELGATO_SERVICE_TYPE, protocol: "tcp" });

    const announce = (service: Service) => {
      this.#announce(service);
    };
    this.#browser.on("up", announce);
    this.#browser.on("down", (service: Service) => {
      const discovered = toDiscoveredService(service);
      if (discovered) this.emit("down", discovered);
    });
    // `srv-update` means the SRV target or port changed. An address change alone
    // raises no event at all (docs/how-it-works.md, "Addresses from mDNS"); the
    // platform follows that by asking for the name again when a light stops answering.
    this.#browser.on("srv-update", announce);
  }

  /** Re-send the PTR query; devices answer even if the browser started before they did. */
  refresh(): void {
    this.#browser?.update();
  }

  /**
   * The IPv4 address of a `.local` name: from an A record already heard on the
   * socket, else from an A query over bonjour's own socket, sent twice. Resolves to
   * `undefined` on timeout, or when discovery is not running.
   */
  resolve(hostname: string): Promise<string | undefined> {
    const key = normalizeName(hostname);
    const cached = this.#addresses.get(key);
    if (cached && cached.expiresAt > this.#now()) return Promise.resolve(cached.address);
    if (cached) this.#addresses.delete(key);
    const inFlight = this.#resolving.get(key);
    if (inFlight) return inFlight.promise;
    const mdns = this.#mdns;
    if (!mdns) return Promise.resolve(undefined);

    const ask = (): void => {
      try {
        mdns.query(hostname, "A");
      } catch {
        finish(undefined);
      }
    };
    let finish: (address: string | undefined) => void = () => undefined;
    const promise = new Promise<string | undefined>((resolve) => {
      const onResponse: ResponseListener = (packet) => {
        const record = ipv4Records(packet).find(
          (candidate) => normalizeName(candidate.name) === key,
        );
        if (record) finish(record.data);
      };
      const requery = setTimeout(ask, Math.min(REQUERY_AFTER_MS, this.#resolveTimeoutMs / 2));
      const timer = setTimeout(() => {
        finish(undefined);
      }, this.#resolveTimeoutMs);
      finish = (address) => {
        clearTimeout(requery);
        clearTimeout(timer);
        mdns.removeListener("response", onResponse);
        this.#resolving.delete(key);
        resolve(address);
      };
      mdns.on("response", onResponse);
    });
    this.#resolving.set(key, { promise, finish });
    ask();
    return promise;
  }

  stop(): void {
    this.#detachSocket();
    for (const { finish } of this.#resolving.values()) finish(undefined);
    this.#browser?.stop();
    this.#browser = undefined;
    this.#bonjour?.destroy();
    this.#bonjour = undefined;
  }

  /** Stop listening on the socket, and forget what was heard on it. */
  #detachSocket(): void {
    this.#socket?.removeListener("response", this.#remember);
    this.#socket?.removeListener("error", this.#onSocketError);
    this.#socket = undefined;
    this.#mdns = undefined;
    this.#addresses.clear();
  }

  /**
   * Forward an `up` or `srv-update`. One that carries only the `.local` name waits for
   * an A answer first; the bare name is kept only if none comes, for a bare-metal
   * install where the OS resolver speaks mDNS.
   */
  #announce(service: Service): void {
    const discovered = toDiscoveredService(service);
    if (!discovered) return;
    if (isIP(discovered.host) !== 0) {
      this.emit("up", discovered);
      return;
    }
    const hostname = discovered.host;
    void this.resolve(hostname).then((address) => {
      if (!this.#bonjour) return;
      this.emit("up", { ...discovered, host: address ?? hostname });
    });
  }
}
