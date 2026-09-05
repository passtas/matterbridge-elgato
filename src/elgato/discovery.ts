/**
 * mDNS discovery of `_elg._tcp` devices (docs/elgato-protocol.md §1).
 *
 * `bonjour-service` does the work matterbridge's raw `Mdns` codec would leave to us:
 * it parses TXT into an object and merges the A/AAAA answers into `addresses`.
 *
 * Not every light shows up here. Key Light Neo owners report that Control Center
 * finds their light while mDNS clients do not (raine/Lolgato#4), and multicast does
 * not survive every network. The manual `devices` list in the config is the way in
 * for those, and it goes through the same probe.
 */

import { EventEmitter } from "node:events";

import { Bonjour, type Service } from "bonjour-service";

import type { DiscoveredService } from "./types.ts";

export const ELGATO_SERVICE_TYPE = "elg";

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
    port: service.port,
    txt: (service.txt ?? {}) as DiscoveredService["txt"],
  };
};

export interface DiscoveryEvents {
  up: [service: DiscoveredService];
  down: [service: DiscoveredService];
}

/**
 * Thin wrapper so the platform sees plain `up`/`down` events and tests can drive it
 * without multicast. `start()` and `stop()` are both idempotent.
 */
export class ElgatoDiscovery extends EventEmitter<DiscoveryEvents> {
  #bonjour: Bonjour | undefined;
  #browser: ReturnType<Bonjour["find"]> | undefined;

  start(): void {
    if (this.#bonjour) return;
    this.#bonjour = new Bonjour();
    this.#browser = this.#bonjour.find({ type: ELGATO_SERVICE_TYPE, protocol: "tcp" });

    const forward = (event: keyof DiscoveryEvents) => (service: Service) => {
      const discovered = toDiscoveredService(service);
      if (discovered) this.emit(event, discovered);
    };
    this.#browser.on("up", forward("up"));
    this.#browser.on("down", forward("down"));
    // An IP change arrives as an `srv-update`, which is the same news as an `up`.
    this.#browser.on("srv-update", forward("up"));
  }

  /** Re-send the PTR query; devices answer even if the browser started before they did. */
  refresh(): void {
    this.#browser?.update();
  }

  stop(): void {
    this.#browser?.stop();
    this.#browser = undefined;
    this.#bonjour?.destroy();
    this.#bonjour = undefined;
  }
}
