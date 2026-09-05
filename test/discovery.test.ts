/**
 * Real multicast: the mock advertises `_elg._tcp`, the plugin's browser finds it.
 * Skips cleanly where multicast is unavailable (containers, restricted CI runners).
 */

import type { AnsiLogger } from "matterbridge/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MK2_TXT } from "../scripts/mock-elgato-mk2.ts";
import { MockElgatoDevice } from "../scripts/mock-elgato.ts";
import { ElgatoDiscovery, pickAddress, toDiscoveredService } from "../src/elgato/discovery.ts";
import {
  advertisedModel,
  EMPTY_REPLY_RETRY_MS,
  UnsupportedDevices,
  usesTlsTransport,
} from "../src/elgato/unsupported.ts";
import type { DiscoveredService } from "../src/elgato/types.ts";

const MDNS_TIMEOUT_MS = 8000;
const MOCK_INSTANCE = "Vitest Mock Key Light";

const mock = new MockElgatoDevice({
  model: "key-light-air",
  advertise: true,
  instanceName: MOCK_INSTANCE,
});
const discovery = new ElgatoDiscovery();
let found: DiscoveredService | undefined;

beforeAll(async () => {
  await mock.start();
  found = await new Promise<DiscoveredService | undefined>((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, MDNS_TIMEOUT_MS);
    discovery.on("up", (service) => {
      // The real office lights answer the same browse; only the mock is ours.
      if (service.instanceName !== MOCK_INSTANCE) return;
      clearTimeout(timer);
      resolve(service);
    });
    try {
      discovery.start();
      discovery.refresh();
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}, 20_000);

afterAll(async () => {
  discovery.stop();
  await mock.stop();
});

describe("pure helpers", () => {
  it("prefers an IPv4 address over link-local IPv6", () => {
    expect(
      pickAddress({ addresses: ["fe80::3e6a:9dff:fe00:1", "192.168.1.50"], host: "x.local" }),
    ).toBe("192.168.1.50");
    expect(pickAddress({ addresses: ["fe80::1", "fd00::1"], host: "x.local" })).toBe("fd00::1");
    // Link-local only: fall back to the .local hostname, which needs no scope id.
    expect(pickAddress({ addresses: ["fe80::1"], host: "x.local" })).toBe("x.local");
    expect(pickAddress({ addresses: [], host: "x.local" })).toBe("x.local");
  });

  it("maps a bonjour service onto our shape", () => {
    const service = toDiscoveredService({
      name: "Elgato Light Strip 3C4D",
      port: 9123,
      host: "elgato-light-strip-3c4d.local",
      addresses: ["192.168.1.51"],
      txt: {
        pv: "1.0",
        md: "Elgato Light Strip 20LAA9901",
        id: "01:C4:63:00:00:02",
        dt: "70",
        mf: "Elgato",
      },
    } as never);
    expect(service).toEqual({
      instanceName: "Elgato Light Strip 3C4D",
      host: "192.168.1.51",
      port: 9123,
      txt: {
        pv: "1.0",
        md: "Elgato Light Strip 20LAA9901",
        id: "01:C4:63:00:00:02",
        dt: "70",
        mf: "Elgato",
      },
    });
  });

  it("recognizes the MK.2 by the tls key in its TXT record", () => {
    const mk2: DiscoveredService = {
      instanceName: "Elgato Key Light Air MK.2 5E6F",
      host: "192.168.1.60",
      port: 9123,
      txt: MK2_TXT,
    };
    expect(usesTlsTransport(mk2)).toBe(true);
    expect(advertisedModel(mk2.txt)).toBe("Elgato Key Light Air MK.2 20LAM9901");

    const air: DiscoveredService = { ...mk2, txt: { md: "Elgato Key Light Air 20LAB9901" } };
    expect(usesTlsTransport(air)).toBe(false);
  });

  it("names a device from its dt code when the TXT carries no model", () => {
    expect(advertisedModel({ dt: "214" })).toBe("Elgato Key Light Air MK.2");
    expect(advertisedModel({})).toBe("Elgato light");
  });

  it("drops a service with no usable address", () => {
    expect(
      toDiscoveredService({ name: "x", port: 9123, host: "", addresses: [] } as never),
    ).toBeUndefined();
  });
});

describe("mDNS browse", () => {
  it("finds the advertised mock on _elg._tcp", (ctx) => {
    if (!found) {
      ctx.skip("mDNS unavailable on this host (UDP 5353 blocked or no multicast route)");
      return;
    }
    expect(found.instanceName).toBe(MOCK_INSTANCE);
    expect(found.port).toBe(mock.port);
    expect(found.txt.dt).toBe("200");
    expect(found.txt.md).toContain("Elgato Key Light Air");
    // txt.id is captured but must never be used as the registry key.
    expect(found.txt.id).toBe("3C:6A:9D:00:00:01");
  });

  it("is idempotent on start/stop", () => {
    const extra = new ElgatoDiscovery();
    extra.stop();
    extra.start();
    extra.start();
    extra.refresh();
    extra.stop();
    extra.stop();
    expect(true).toBe(true);
  });
});

describe("UnsupportedDevices", () => {
  const MK2 = "192.168.1.60";
  const FLAKY = "192.168.1.61";

  const tracker = (now: () => number) => {
    const log = { info: vi.fn(), debug: vi.fn() } as unknown as AnsiLogger;
    return { log, devices: new UnsupportedDevices(log, now) };
  };

  it("keeps a light that advertised the TLS protocol out of the way for good", () => {
    let clock = 0;
    const { log, devices } = tracker(() => clock);
    devices.note(MK2, "Elgato Key Light Air MK.2 20LAM9901", { permanent: true });

    expect(devices.has(MK2)).toBe(true);
    clock += EMPTY_REPLY_RETRY_MS * 100;
    expect(devices.has(MK2)).toBe(true);
    expect(devices.count).toBe(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("tries a light that only closed the connection again after the retry window", () => {
    let clock = 0;
    const { log, devices } = tracker(() => clock);
    devices.note(FLAKY, "Elgato light", { permanent: false });

    clock += EMPTY_REPLY_RETRY_MS - 1;
    expect(devices.has(FLAKY)).toBe(true);

    clock += 2;
    expect(devices.has(FLAKY)).toBe(false);
    expect(devices.count).toBe(0);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("again"));

    // A second sighting is the same news, so it is not announced twice.
    devices.note(FLAKY, "Elgato light", { permanent: false });
    expect(devices.has(FLAKY)).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(2);
  });
});
