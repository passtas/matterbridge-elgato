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
/** First wait before re-probing a light that could not be reached; doubles per failure. */
export const RETRY_INITIAL_MS = 10_000;
/** The backoff stops doubling here, so a light that comes back is found within 5 min. */
export const RETRY_MAX_MS = 5 * 60_000;
/** How often the retry timer looks for a due probe. Separate from the poll interval. */
export const RETRY_TICK_MS = 5000;

/** The wait before the next try, after one that has just failed. */
export const nextRetryDelayMs = (previousMs: number): number =>
  Math.min(previousMs * 2, RETRY_MAX_MS);

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

/**
 * Light Strip only: switch off by re-sending the cached scene with `on: 0`, so the
 * strip parks with its scene intact (docs/elgato-protocol.md, addendum). Off unless
 * set to exactly `true`, because it changes what is stored on the user's light.
 */
export const preserveSceneOnOff = (config: PlatformConfig): boolean =>
  config.preserveSceneOnOff === true;

/**
 * How often a battery light's `battery-info` is read. Charge does not need the 3 s
 * resolution of the light state, and the firmware serves one request at a time
 * (docs/elgato-protocol.md §2), so it rides along on every Nth poll tick instead of
 * on a timer of its own.
 */
export const BATTERY_POLL_INTERVAL_MS = 30_000;

/** Every how many poll ticks the battery is read: about 30 s whatever `pollInterval` is. */
export const batteryPollEvery = (config: PlatformConfig): number =>
  Math.max(1, Math.round(BATTERY_POLL_INTERVAL_MS / pollIntervalMs(config)));

/**
 * Unanswered battery probes a light gets before it is added without a battery. Its
 * lights endpoint works, so retrying for ever would lose a light that registers fine
 * without one; the wired PowerSource persists nothing, so a later restart that does
 * read the battery rebuilds it cleanly.
 */
export const BATTERY_PROBE_ATTEMPTS = 3;
