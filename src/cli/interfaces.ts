/**
 * Picking the LAN network interface.
 *
 * Matterbridge needs `--mdnsinterface` on any host with more than one external
 * interface (its own README-DOCKER.md says so), and a machine that runs Docker
 * always has
 * several: docker0, a br-* per user-defined network, maybe a VPN. Getting this
 * wrong is the single most common reason a bridge never appears in Google Home,
 * so the CLI picks the interface itself and explains the choice.
 */

import type { NetworkInterfaceInfo } from "node:os";

export type InterfaceCandidate = {
  name: string;
  address: string;
  netmask: string;
};

export type InterfacePick = {
  name: string;
  address: string;
  reason: string;
};

/**
 * Virtual interfaces that are never the LAN: docker's own bridges, per-container
 * veth pairs, VPN and overlay networks, loopback, libvirt.
 */
export const VIRTUAL_INTERFACE_PATTERN = /^(docker|br-|veth|tailscale|lo|virbr|wg|zt)/;

/**
 * Every interface with a usable IPv4 address, virtual ones included. An explicit
 * `--interface` is checked against this rather than against the candidate list,
 * so someone who really wants a bridge interface can still name one.
 */
export function listAddressableInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): InterfaceCandidate[] {
  const found: InterfaceCandidate[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    const ipv4 = addresses?.find((address) => address.family === "IPv4" && !address.internal);
    if (ipv4) found.push({ name, address: ipv4.address, netmask: ipv4.netmask });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function listCandidates(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): InterfaceCandidate[] {
  const candidates: InterfaceCandidate[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses || VIRTUAL_INTERFACE_PATTERN.test(name)) continue;
    const ipv4 = addresses.find((address) => address.family === "IPv4" && !address.internal);
    if (!ipv4) continue;
    candidates.push({ name, address: ipv4.address, netmask: ipv4.netmask });
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `ip route show default` prints one line per default route, lowest metric first:
 *   default via 192.168.1.1 dev enx001a2b3c4d5e proto static metric 50
 */
export function parseDefaultRouteInterface(routeOutput: string): string | undefined {
  for (const line of routeOutput.split("\n")) {
    if (!line.startsWith("default")) continue;
    const match = /\bdev\s+(\S+)/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export type InterfaceChoice =
  | { kind: "none" }
  | { kind: "picked"; pick: InterfacePick }
  | { kind: "ambiguous"; candidates: InterfaceCandidate[] };

/**
 * Deterministic part of the decision: default route wins, then a lone candidate,
 * otherwise the caller has to ask.
 */
export function chooseInterface(
  candidates: readonly InterfaceCandidate[],
  defaultRouteInterface: string | undefined,
): InterfaceChoice {
  if (candidates.length === 0) return { kind: "none" };

  const onDefaultRoute = candidates.find((candidate) => candidate.name === defaultRouteInterface);
  if (onDefaultRoute) {
    return {
      kind: "picked",
      pick: {
        name: onDefaultRoute.name,
        address: onDefaultRoute.address,
        reason: "it carries the host's default route",
      },
    };
  }

  const only = candidates[0];
  if (candidates.length === 1 && only) {
    return {
      kind: "picked",
      pick: {
        name: only.name,
        address: only.address,
        reason: "it is the only non-virtual interface with an IPv4 address",
      },
    };
  }

  return { kind: "ambiguous", candidates: [...candidates] };
}
