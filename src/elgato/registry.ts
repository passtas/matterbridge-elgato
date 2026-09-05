/**
 * Device records keyed by `accessory-info.serialNumber`.
 *
 * Not keyed by the mDNS TXT `id`: on the Light Strip that value is neither the MAC
 * nor stable (docs/elgato-protocol.md §1). An IP change updates the record in place
 * so the Matter endpoint and its identity survive DHCP.
 */

import type { ElgatoClient } from "./client.ts";
import type { AccessoryInfo, LightCapability } from "./types.ts";

export interface DeviceRecord {
  serial: string;
  client: ElgatoClient;
  info: AccessoryInfo;
  capability: LightCapability;
}

export class DeviceRegistry {
  readonly #bySerial = new Map<string, DeviceRecord>();

  get size(): number {
    return this.#bySerial.size;
  }

  has(serial: string): boolean {
    return this.#bySerial.has(serial);
  }

  get(serial: string): DeviceRecord | undefined {
    return this.#bySerial.get(serial);
  }

  add(record: DeviceRecord): void {
    this.#bySerial.set(record.serial, record);
  }

  /** Point a known device at a new address. Returns true when it actually moved. */
  updateHost(serial: string, host: string): boolean {
    const record = this.#bySerial.get(serial);
    if (!record || record.client.host === host) return false;
    record.client.host = host;
    return true;
  }
}
