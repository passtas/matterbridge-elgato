/**
 * Reading the plugin's configuration.
 *
 * Matterbridge never applies the `default:` values from a schema
 * (docs/matterbridge-api-cheatsheet.md §1), so every key is defaulted here as well
 * as in the shipped `matterbridge-elgato.config.json`. Users edit this by hand in
 * the frontend, so nothing here trusts the type of what it reads.
 */

import type { PlatformConfig } from "matterbridge";

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const MIN_POLL_INTERVAL_MS = 1000;
export const DEFAULT_COLOR_DEBOUNCE_MS = 400;
/** How long `onStart` waits for the first mDNS answers before carrying on. */
export const DISCOVERY_WINDOW_MS = 3000;
/** Upper bound on how long `onShutdown` waits for in-flight device writes. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 2000;

/** One entry of the `devices` list: a light to probe whatever mDNS did or did not find. */
export interface ManualDevice {
  host: string;
  name?: string;
}

/** Only `{ host, name? }` objects, exactly as `matterbridge-elgato.schema.json` declares. */
export const manualDevices = (config: PlatformConfig): ManualDevice[] => {
  if (!Array.isArray(config.devices)) return [];
  return config.devices.flatMap((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const { host, name } = entry as { host?: unknown; name?: unknown };
      if (typeof host === "string" && host.length > 0) {
        return [typeof name === "string" && name.length > 0 ? { host, name } : { host }];
      }
    }
    return [];
  });
};

export const pollIntervalMs = (config: PlatformConfig): number => {
  const configured = Number(config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, configured);
};

export const colorDebounceMs = (config: PlatformConfig): number => {
  const configured = Number(config.colorDebounce ?? DEFAULT_COLOR_DEBOUNCE_MS);
  return Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_COLOR_DEBOUNCE_MS;
};

export const mdnsEnabled = (config: PlatformConfig): boolean => config.enableMdns !== false;
