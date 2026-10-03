/**
 * Real multicast: the mock advertises `_elg._tcp`, the plugin's browser finds it.
 * Skips cleanly where multicast is unavailable (containers, restricted CI runners).
 */

import type { AnsiLogger } from "matterbridge/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MK2_TXT } from "../scripts/mock-elgato-mk2.ts";
import { MockElgatoDevice } from "../scripts/mock-elgato.ts";
import { formatHost, parseHost } from "../src/elgato/client.ts";
import { nextRetryDelayMs, RETRY_INITIAL_MS, RETRY_MAX_MS } from "../src/config.ts";
import { ElgatoDiscovery, pickAddress, toDiscoveredService } from "../src/elgato/discovery.ts";
import {
  advertisedModel,
  EMPTY_REPLY_RETRY_MS,
  UnsupportedDevices,
  usesTlsTransport,
} from "../src/elgato/unsupported.ts";
import type { DiscoveredService } from "../src/elgato/types.ts";
import { announcement, aRecordPacket, fakeDiscovery } from "./helpers/fakeBonjour.ts";

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
      hostname: "elgato-light-strip-3c4d.local",
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

describe("an announcement that carries only the .local name", () => {
  // What the production Key Light Mini sent: an `up` whose packet held no A record, so
  // bonjour-service left `addresses` empty and never filled it in later
  // (docs/how-it-works.md, "Addresses from mDNS").
  const MINI_HOST = "Elgato-Key-Light-Mini-0A0B.local";
  const MINI = announcement({ name: "Elgato Key Light Mini 0A0B", host: MINI_HOST, port: 9123 });

  const nextUp = (discovery: ElgatoDiscovery): Promise<DiscoveredService> =>
    new Promise((resolve) => {
      discovery.once("up", resolve);
    });

  it("is resolved to an IPv4 with an A query over bonjour's own socket", async () => {
    const { discovery, browser, mdns } = fakeDiscovery();
    mdns.answers.set(MINI_HOST.toLowerCase(), "192.0.2.70");
    discovery.start();
    try {
      const up = nextUp(discovery);
      browser.emit("up", MINI);
      expect(await up).toMatchObject({
        instanceName: "Elgato Key Light Mini 0A0B",
        host: "192.0.2.70",
        hostname: MINI_HOST,
        port: 9123,
      });
      expect(mdns.queries).toEqual([{ name: MINI_HOST, type: "A" }]);
    } finally {
      discovery.stop();
    }
  });

  it("passes an IPv4 announcement straight through, with no query, keeping the name", () => {
    const { discovery, browser, mdns } = fakeDiscovery();
    const seen: DiscoveredService[] = [];
    discovery.on("up", (service) => seen.push(service));
    discovery.start();
    browser.emit("up", { ...MINI, addresses: ["fe80::1", "192.0.2.70"] });
    discovery.stop();
    expect(seen).toEqual([expect.objectContaining({ host: "192.0.2.70", hostname: MINI_HOST })]);
    expect(mdns.queries).toHaveLength(0);
  });

  it("shares one query between an up and an srv-update of the same light", async () => {
    const { discovery, browser, mdns } = fakeDiscovery();
    mdns.answers.set(MINI_HOST.toLowerCase(), "192.0.2.70");
    const seen: DiscoveredService[] = [];
    discovery.on("up", (service) => seen.push(service));
    discovery.start();
    try {
      browser.emit("up", MINI);
      browser.emit("srv-update", MINI, MINI);
      await vi.waitFor(() => {
        expect(seen).toHaveLength(2);
      });
      expect(seen.map((service) => service.host)).toEqual(["192.0.2.70", "192.0.2.70"]);
      expect(mdns.queries).toHaveLength(1);
    } finally {
      discovery.stop();
    }
  });

  it("keeps the .local name as a last resort when nothing answers", async () => {
    const { discovery, browser } = fakeDiscovery({ resolveTimeoutMs: 20 });
    discovery.start();
    try {
      const up = nextUp(discovery);
      browser.emit("up", MINI);
      expect(await up).toMatchObject({ host: MINI_HOST, hostname: MINI_HOST });
    } finally {
      discovery.stop();
    }
  });

  it("settles a lookup on stop, announces nothing after it, and leaves no timer", async () => {
    vi.useFakeTimers();
    try {
      const { discovery, browser } = fakeDiscovery({ resolveTimeoutMs: 60_000 });
      const up = vi.fn();
      discovery.on("up", up);
      discovery.start();
      const lookup = discovery.resolve(MINI_HOST);
      browser.emit("up", MINI);
      // The give-up timer and the second query, shared by both lookups.
      expect(vi.getTimerCount()).toBe(2);

      discovery.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(await lookup).toBeUndefined();
      await vi.runAllTimersAsync();
      expect(up).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has nothing to ask through when discovery is not running", async () => {
    const { discovery } = fakeDiscovery();
    expect(await discovery.resolve(MINI_HOST)).toBeUndefined();
    const shapeless = new ElgatoDiscovery({
      createBonjour: () =>
        ({ find: () => fakeDiscovery().browser, destroy: () => undefined }) as never,
    });
    shapeless.start();
    expect(await shapeless.resolve(MINI_HOST)).toBeUndefined();
    shapeless.stop();
  });
});

describe("the A records heard on the socket", () => {
  // The order a real Key Light Mini used on power-up: its A record in packets of its
  // own, then the PTR packet bonjour builds the `up` from, with no A record in it.
  const MINI_HOST = "elgato-key-light-mini-0a0b.local";
  const MINI = announcement({ name: "Elgato Key Light Mini 0A0B", host: MINI_HOST, port: 9123 });

  it("answer a later name-only announcement at once, with no query", async () => {
    const { discovery, browser, mdns } = fakeDiscovery();
    discovery.start();
    try {
      mdns.emit("response", aRecordPacket("Elgato-Key-Light-Mini-0A0B.local.", "192.0.2.71"));
      const up = new Promise<DiscoveredService>((resolve) => {
        discovery.once("up", resolve);
      });
      browser.emit("up", MINI);
      expect(await up).toMatchObject({ host: "192.0.2.71", hostname: MINI_HOST });
      expect(mdns.queries).toHaveLength(0);
    } finally {
      discovery.stop();
    }
  });

  it("are forgotten after their TTL, at most 2 min, and on a goodbye", async () => {
    let clock = 0;
    const { discovery, mdns } = fakeDiscovery({ resolveTimeoutMs: 20, now: () => clock });
    discovery.startResolver();
    try {
      mdns.emit("response", aRecordPacket(MINI_HOST, "192.0.2.71", 4500));
      clock += 2 * 60_000 - 1;
      expect(await discovery.resolve(MINI_HOST)).toBe("192.0.2.71");
      clock += 2;
      expect(await discovery.resolve(MINI_HOST)).toBeUndefined();
      expect(mdns.queries.length).toBeGreaterThan(0);

      mdns.emit("response", aRecordPacket(MINI_HOST, "192.0.2.71", 10));
      clock += 10_001;
      expect(await discovery.resolve(MINI_HOST)).toBeUndefined();

      mdns.emit("response", aRecordPacket(MINI_HOST, "192.0.2.71"));
      mdns.emit("response", aRecordPacket(MINI_HOST, "192.0.2.71", 0));
      const queries = mdns.queries.length;
      expect(await discovery.resolve(MINI_HOST)).toBeUndefined();
      expect(mdns.queries.length).toBeGreaterThan(queries);
    } finally {
      discovery.stop();
    }
  });

  it("are not listened for after stop", () => {
    const { discovery, mdns } = fakeDiscovery();
    discovery.start();
    expect(mdns.listenerCount("response")).toBe(1);
    expect(mdns.listenerCount("error")).toBe(1);
    discovery.stop();
    expect(mdns.listenerCount("response")).toBe(0);
    expect(mdns.listenerCount("error")).toBe(0);
  });
});

describe("the A query", () => {
  it("goes out a second time inside the window, and that one is answered", async () => {
    const { discovery, mdns } = fakeDiscovery({ resolveTimeoutMs: 200 });
    // The light ignores the first query, as it does one sent right after its own answer.
    mdns.answerFrom = 2;
    mdns.answers.set("elgato-key-light-0b0b.local", "192.0.2.72");
    discovery.startResolver();
    try {
      expect(await discovery.resolve("elgato-key-light-0b0b.local")).toBe("192.0.2.72");
      expect(mdns.queries).toEqual([
        { name: "elgato-key-light-0b0b.local", type: "A" },
        { name: "elgato-key-light-0b0b.local", type: "A" },
      ]);
    } finally {
      discovery.stop();
    }
  });

  it("is switched off, not thrown, when the socket fails", async () => {
    const { discovery, mdns } = fakeDiscovery({ resolveTimeoutMs: 60_000 });
    const warning = vi.fn();
    discovery.on("warning", warning);
    discovery.startResolver();
    try {
      const pending = discovery.resolve("elgato-key-light-0b0b.local");
      const failure = Object.assign(new Error("bind EADDRINUSE 0.0.0.0:5353"), {
        code: "EADDRINUSE",
      });
      // multicast-dns emits `error` for this; with no listener, Node would throw.
      expect(() => mdns.emit("error", failure)).not.toThrow();
      expect(() => mdns.emit("error", failure)).not.toThrow();
      expect(warning).toHaveBeenCalledWith(failure);
      expect(await pending).toBeUndefined();

      const queries = mdns.queries.length;
      expect(await discovery.resolve("elgato-key-light-0b0b.local")).toBeUndefined();
      expect(mdns.queries).toHaveLength(queries);
    } finally {
      discovery.stop();
    }
  });
});

describe("retry helpers", () => {
  it("doubles the wait from 10 s up to a 5 min cap", () => {
    const waits = [RETRY_INITIAL_MS];
    for (let i = 0; i < 8; i += 1) waits.push(nextRetryDelayMs(waits.at(-1) as number));
    expect(waits.map((ms) => ms / 1000)).toEqual([10, 20, 40, 80, 160, 300, 300, 300, 300]);
    expect(RETRY_MAX_MS).toBe(300_000);
  });

  it("spells the port out only when it is not 9123", () => {
    expect(formatHost("192.0.2.70", 9123)).toBe("192.0.2.70");
    expect(formatHost("192.0.2.70", undefined)).toBe("192.0.2.70");
    expect(formatHost("127.0.0.1", 40123)).toBe("127.0.0.1:40123");
    expect(formatHost("fd00::1", 40123)).toBe("[fd00::1]:40123");
    expect(parseHost(formatHost("fd00::1", 40123))).toEqual({ host: "fd00::1", port: 40123 });
  });
});
