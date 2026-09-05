import { describe, expect, it } from "vitest";

import { ElgatoClient } from "../src/elgato/client.ts";
import { DeviceRegistry } from "../src/elgato/registry.ts";

import { fixture } from "./helpers/fixtures.ts";

const record = (serial: string, host: string) => ({
  serial,
  client: new ElgatoClient(host),
  info: fixture<never>("key-light-air-accessory-info"),
  capability: "ct" as const,
});

describe("DeviceRegistry", () => {
  it("keys on the serial, not on the address", () => {
    const registry = new DeviceRegistry();
    registry.add(record("CW33J1A00001", "192.168.1.50"));
    expect(registry.size).toBe(1);
    expect(registry.has("CW33J1A00001")).toBe(true);
    expect(registry.has("EW52J1A00002")).toBe(false);
    expect(registry.get("CW33J1A00001")?.client.host).toBe("192.168.1.50");
  });

  it("follows an IP change in place and reports whether it moved", () => {
    const registry = new DeviceRegistry();
    registry.add(record("CW33J1A00001", "192.168.1.50"));
    expect(registry.updateHost("CW33J1A00001", "192.168.1.50")).toBe(false);
    expect(registry.updateHost("CW33J1A00001", "192.168.1.55")).toBe(true);
    expect(registry.get("CW33J1A00001")?.client.baseUrl).toBe("http://192.168.1.55:9123");
    expect(registry.updateHost("unknown", "10.0.0.1")).toBe(false);
  });
});
