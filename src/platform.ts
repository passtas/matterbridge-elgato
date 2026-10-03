/**
 * The Matterbridge dynamic platform: discovery, then one bridged endpoint per light,
 * then the poll loop that keeps the Matter attributes in step with the devices.
 */

import { isIP } from "node:net";

import {
  MatterbridgeDynamicPlatform,
  type PlatformConfig,
  type PlatformMatterbridge,
} from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import { fireAndForget } from "matterbridge/utils";

import {
  batteryPollEvery,
  colorDebounceMs,
  DISCOVERY_WINDOW_MS,
  type ManualDevice,
  manualDevices,
  mdnsEnabled,
  nextRetryDelayMs,
  pollIntervalMs,
  preserveSceneOnOff,
  RETRY_INITIAL_MS,
  RETRY_TICK_MS,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
} from "./config.ts";
import {
  ELGATO_PORT,
  ElgatoClient,
  ElgatoHttpError,
  formatHost,
  parseHost,
} from "./elgato/client.ts";
import { ElgatoDiscovery, isMdnsName, normalizeName } from "./elgato/discovery.ts";
import { DeviceRegistry } from "./elgato/registry.ts";
import { advertisedModel, UnsupportedDevices, usesTlsTransport } from "./elgato/unsupported.ts";
import type { AccessoryInfo, BatteryInfo, DiscoveredService } from "./elgato/types.ts";
import { KeyLightDevice } from "./devices/keyLight.ts";
import { LightStripDevice } from "./devices/lightStrip.ts";
import type { SceneStore } from "./devices/scenes.ts";
import type { DeviceContext, ElgatoDevice } from "./devices/shared.ts";
import { detectCapability, deviceTypeName } from "./mapping.ts";
import { PluginStorage } from "./pluginStorage.ts";

const REQUIRED_MATTERBRIDGE_VERSION = "3.10.0";

export interface ProbeOptions {
  /** The name from the manual `devices` list, which wins over everything else. */
  name?: string;
  /** mDNS instance name: the fallback label, and the light's key in the retry queue. */
  instanceName?: string;
  model?: string;
  /**
   * The light's `.local` name, from its SRV record or a manual `devices` host. When a
   * probe gets no answer, mDNS is asked for its address and that is probed too.
   */
  hostname?: string;
}

/**
 * What one probe came to. Only `unreachable` (no HTTP answer at all, and not the MK.2's
 * closed socket) is worth another try; `busy` means another probe of the same host or
 * serial is running and will report for itself.
 */
type ProbeOutcome =
  | { kind: "registered"; device: ElgatoDevice }
  | { kind: "known"; device: ElgatoDevice | undefined }
  | { kind: "unreachable"; error: Error }
  | { kind: "busy" }
  | { kind: "dropped" };

/**
 * The light answered, but its battery probe did not. The PowerSource features cannot
 * change once the endpoint is built, so the whole registration probe counts as
 * unanswered and goes to the retry queue rather than building a guess.
 */
class BatteryProbeUnanswered extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatteryProbeUnanswered";
  }
}

/** A light whose probe failed for a transport reason, waiting for its next try. */
export interface PendingProbe {
  host: string;
  options: ProbeOptions;
  retries: number;
  delayMs: number;
  dueAt: number;
}

export class ElgatoPlatform extends MatterbridgeDynamicPlatform {
  readonly registry = new DeviceRegistry();
  readonly devices = new Map<string, ElgatoDevice>();
  /** Poll timers, wrapped so `onShutdown` can clear them and tests can drive them. */
  intervals: { interval: NodeJS.Timeout; callback: () => Promise<void> }[] = [];

  readonly #storage = new PluginStorage(this.log, () => this.context);
  readonly #unsupported = new UnsupportedDevices(this.log);
  readonly #sceneStore: SceneStore = {
    load: (serial) => this.#storage.sceneOf(serial),
    save: (serial, scene) => this.#storage.rememberScene(serial, scene),
  };
  #discovery: ElgatoDiscovery | undefined;
  /** Probes in flight, so two announcements of one light cannot both register it. */
  #probingHosts = new Set<string>();
  #probingSerials = new Set<string>();
  /** Hosts and serials the white/black list rejected, so mDNS does not re-probe forever. */
  #skippedHosts = new Set<string>();
  #skippedSerials = new Set<string>();
  #polling = false;
  #discoveryTasks: Promise<void>[] = [];
  /**
   * Lights that did not answer, by mDNS instance name (manual hosts by their host
   * string), so the IPv4 and `.local` announcements of one light share an entry.
   */
  readonly #pending = new Map<string, PendingProbe>();
  /** Keys of lights that registered, so a late failed probe of one is not news. */
  readonly #registeredKeys = new Set<string>();
  /** The configured `devices`, so an announcement of one of them keeps its `name`. */
  #manual: ManualDevice[] = [];
  /** Each registered light's `.local` name, to look it up again if it moves. */
  readonly #hostnames = new Map<string, string>();
  /** Registered lights that stopped answering, and when to look up their name next. */
  readonly #relocating = new Map<string, { delayMs: number; dueAt: number }>();
  #retrying = false;
  /** Set once `onConfigure` has seeded the first batch; later lights seed themselves. */
  #configured = false;
  #stopped = false;

  /** Overridden by tests to browse a fake bonjour instead of the LAN. */
  createDiscovery = (): ElgatoDiscovery => new ElgatoDiscovery();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (
      typeof this.verifyMatterbridgeVersion !== "function" ||
      !this.verifyMatterbridgeVersion(REQUIRED_MATTERBRIDGE_VERSION)
    ) {
      throw new Error(
        `This plugin requires Matterbridge version >= "${REQUIRED_MATTERBRIDGE_VERSION}". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info("Initializing the Elgato platform");
  }

  /** Lights found on the network that this plugin cannot drive yet, see elgato/unsupported.ts. */
  get unsupportedCount(): number {
    return this.#unsupported.count;
  }

  /** The retry queue, by key, as a copy for logging and tests. */
  get pendingRetries(): Map<string, PendingProbe> {
    return new Map([...this.#pending].map(([key, entry]) => [key, { ...entry }]));
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? "none"}`);
    this.#stopped = false;
    await this.ready;
    await this.clearSelect();
    await this.#storage.load();

    this.#manual = manualDevices(this.config);
    const manual = this.#manual.map((device) => ({
      ...device,
      hostname: parseHost(device.host).host,
    }));
    const browse = mdnsEnabled(this.config);
    // A `.local` host in the list needs the mDNS socket even with browsing off: a
    // container cannot resolve the name (docs/how-it-works.md, "Addresses from mDNS").
    // The socket alone finds no lights, so "only the manual list" still holds.
    if (browse || manual.some((device) => isMdnsName(device.hostname))) {
      this.#discovery = this.createDiscovery();
      this.#discovery.on("warning", (error) => {
        this.log.warn(`mDNS socket failed, .local names will not be looked up: ${error.message}`);
      });
      this.#discovery.startResolver();
    }

    // Before browsing starts, so a light's configured name wins over its mDNS one.
    // One that does not answer now is queued and retried from onConfigure on.
    for (const { host, name, hostname } of manual) {
      await this.addDeviceByHost(host, {
        ...(name === undefined ? {} : { name }),
        ...(isMdnsName(hostname) ? { hostname } : {}),
      });
    }

    if (browse && this.#discovery) {
      this.#discovery.on("up", (service) => {
        this.#trackDiscovery(this.addDiscoveredService(service));
      });
      this.#discovery.on("down", (service) => {
        // Keep the endpoint registered; the poll loop flips `reachable` on its own.
        this.log.debug(`mDNS: ${service.instanceName} at ${service.host} went down`);
      });
      this.#discovery.start();
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_WINDOW_MS));
      await this.#settleDiscovery();
    } else {
      this.log.debug("mDNS discovery disabled by config");
    }

    const unsupported = this.#unsupported.count;
    this.log.notice(
      `Discovered ${this.devices.size} Elgato device(s)` +
        (unsupported > 0 ? ` and ${unsupported} unsupported` : ""),
    );
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    for (const device of this.devices.values()) {
      await device.seed();
    }
    this.#configured = true;
    const interval = pollIntervalMs(this.config);
    this.addInterval(() => this.pollAll(), interval);
    // Its own timer, never a step of pollAll: a retry can take the full 5 s HTTP
    // timeout, and the lights that do answer must not wait behind it.
    this.addInterval(() => this.retryPending(), RETRY_TICK_MS);
    this.log.info(`Polling ${this.devices.size} device(s) every ${interval} ms`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.#stopped = true;
    this.#configured = false;
    this.clearIntervals();
    this.#pending.clear();
    this.#relocating.clear();
    this.#discovery?.stop();
    this.#discovery = undefined;
    // Push out any debounced color write and let the queues drain, but never let a
    // wedged device hold the whole bridge's shutdown open.
    let flushTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...this.devices.values()].map((device) => device.flush())),
      new Promise((resolve) => {
        flushTimer = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
        flushTimer.unref();
      }),
    ]).catch((error: unknown) => this.log.warn(`Shutdown flush failed: ${String(error)}`));
    clearTimeout(flushTimer);
    for (const device of this.devices.values()) device.dispose();
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? "none"}`);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices(500);
  }

  /**
   * Poll every device in turn, since the lights serialize concurrent requests anyway.
   * A tick is skipped while the previous one is still running: two unreachable devices
   * at a 5 s HTTP timeout overrun the 3 s interval, and the backlog would grow forever.
   */
  async pollAll(): Promise<void> {
    if (this.#polling) {
      this.log.debug("Poll still running, skipping this tick");
      return;
    }
    this.#polling = true;
    try {
      for (const device of this.devices.values()) {
        await device.poll();
      }
    } finally {
      this.#polling = false;
    }
  }

  // ---- device creation ----------------------------------------------------

  /** One `_elg._tcp` announcement. Public so tests can drive discovery without multicast. */
  async addDiscoveredService(service: DiscoveredService): Promise<void> {
    // The advertised port only shows when it is not 9123, so a real light's key is
    // its bare address, the same string a manual `devices` entry would use.
    const host = formatHost(service.host, service.port);
    this.log.debug(`mDNS: ${service.instanceName} at ${host}`);
    if (usesTlsTransport(service)) {
      this.#unsupported.note(host, advertisedModel(service.txt), { permanent: true });
      this.#pending.delete(service.instanceName);
      return;
    }
    // A light from the `devices` list that was off at startup can be announced
    // before its retry comes round. It must register under its configured name
    // even so, or the next restart renames it and controllers see a new device
    // (docs/matterbridge-api-cheatsheet.md §3).
    const manual = this.#manualEntryFor(service);
    const device = await this.addDeviceByHost(host, {
      instanceName: service.instanceName,
      model: advertisedModel(service.txt),
      ...(service.hostname === undefined ? {} : { hostname: service.hostname }),
      ...(manual?.name === undefined ? {} : { name: manual.name }),
    });
    if (device && manual) {
      this.#pending.delete(manual.host);
      this.#registeredKeys.add(manual.host);
    }
  }

  /** The `devices` entry, not yet registered, for an announced light: by address or name, and port. */
  #manualEntryFor(service: DiscoveredService): ManualDevice | undefined {
    const names = new Set(
      [service.host, service.hostname].flatMap((name) => (name ? [normalizeName(name)] : [])),
    );
    const port = service.port || ELGATO_PORT;
    return this.#manual.find((entry) => {
      // An entry that has its light already: whatever answers at that address now is
      // another light, on a lease the first one gave up, and must not take its name.
      if (this.#registeredKeys.has(entry.host)) return false;
      const configured = parseHost(entry.host);
      return (configured.port ?? ELGATO_PORT) === port && names.has(normalizeName(configured.host));
    });
  }

  /**
   * Probe one host and, if it is a light we do not know yet, build and register its
   * endpoint. Idempotent: a known serial only gets its address and label refreshed.
   * A host that does not answer at all is queued for `retryPending`.
   */
  async addDeviceByHost(
    host: string,
    options: ProbeOptions = {},
  ): Promise<ElgatoDevice | undefined> {
    const key = options.instanceName ?? host;
    const { outcome, tried } = await this.#probeWithFallback(host, options);
    switch (outcome.kind) {
      case "unreachable": {
        const message = `Could not add the Elgato device at ${tried}: ${outcome.error.message}`;
        // Registered meanwhile under another of its addresses (an IPv4 `up` won the
        // race against its `.local` one): the poll loop has it from here.
        if (this.#registeredKeys.has(key)) {
          this.log.debug(message);
          return undefined;
        }
        // Only the first failure for a light is an error. The next announcement of a
        // light that is still down is the same news.
        if (this.#pending.has(key)) this.log.debug(message);
        else this.log.error(message);
        this.#queueRetry(key, host, options);
        return undefined;
      }
      case "busy":
        return undefined;
      case "registered":
      case "known":
        // A fresh answer for this light supersedes whatever host it was queued under.
        this.#pending.delete(key);
        this.#registeredKeys.add(key);
        return outcome.device;
      default:
        this.#pending.delete(key);
        return undefined;
    }
  }

  /**
   * Re-probe every queued light that is due. Runs on its own timer from `onConfigure`.
   * Probes run side by side, and a tick is skipped while the previous one runs.
   * `force` ignores the backoff, for tests.
   */
  async retryPending(options: { force?: boolean } = {}): Promise<void> {
    if (this.#retrying || this.#stopped) return;
    this.#retrying = true;
    try {
      const now = Date.now();
      const due = [...this.#pending].filter(
        ([, entry]) => options.force === true || entry.dueAt <= now,
      );
      await Promise.all([
        ...due.map(([key, entry]) => this.#retry(key, entry)),
        ...this.#lostDevices(now, options.force === true).map((serial) => this.#relocate(serial)),
      ]);
    } finally {
      this.#retrying = false;
    }
  }

  /**
   * Registered lights that stopped answering at an address they have a `.local` name
   * for, and are due a lookup. bonjour-service raises no event when a light's address
   * changes and never expires a service (docs/how-it-works.md, "Addresses from
   * mDNS"), so a new DHCP lease is only noticed this way. A light kept on its name
   * is left to the OS resolver, which follows it already.
   */
  #lostDevices(now: number, force: boolean): string[] {
    const due: string[] = [];
    for (const [serial, device] of this.devices) {
      const host = this.registry.get(serial)?.client.host;
      if (device.reachable || host === undefined || isIP(host) === 0) {
        this.#relocating.delete(serial);
        continue;
      }
      if (!this.#hostnames.has(serial) || !this.#discovery) continue;
      let state = this.#relocating.get(serial);
      if (!state) {
        state = { delayMs: RETRY_INITIAL_MS, dueAt: now };
        this.#relocating.set(serial, state);
      }
      if (force || state.dueAt <= now) due.push(serial);
    }
    return due;
  }

  /** Look a lost light's name up again, and point it at the new address if it moved. */
  async #relocate(serial: string): Promise<void> {
    const hostname = this.#hostnames.get(serial);
    const state = this.#relocating.get(serial);
    if (hostname === undefined || !state || !this.#discovery) return;
    const address = await this.#discovery.resolve(hostname);
    if (this.#stopped) return;
    const record = this.registry.get(serial);
    if (address !== undefined && record && address !== record.client.host) {
      // An A record is only a name's claim. Move the light only once the address
      // answers with its serial: a cached record can be stale, and on a reused lease
      // another light can be answering there.
      const host = formatHost(address, record.client.port);
      try {
        const info = await new ElgatoClient(address, {
          port: record.client.port,
        }).getAccessoryInfo();
        if (!this.#stopped && info.serialNumber === serial) {
          await this.#refreshKnownDevice(serial, address, host, info.displayName);
          this.#relocating.delete(serial);
          return;
        }
        this.log.debug(
          `${hostname} points at ${host}, but ${info.serialNumber} answers there, not ${serial}`,
        );
      } catch (error) {
        this.log.debug(
          `${hostname} points at ${host}, which does not answer: ${(error as Error).message}`,
        );
      }
    }
    if (this.#stopped) return;
    state.dueAt = Date.now() + state.delayMs;
    state.delayMs = nextRetryDelayMs(state.delayMs);
    this.log.debug(`Device ${serial} is still not answering, and ${hostname} has not moved`);
  }

  async #retry(key: string, entry: PendingProbe): Promise<void> {
    // Never ours to retry: a list rejection is final, and an MK.2 has its own timer.
    if (this.#skippedHosts.has(entry.host) || this.#unsupported.has(entry.host)) {
      this.#pending.delete(key);
      return;
    }

    entry.retries += 1;
    const { outcome, tried: host } = await this.#probeWithFallback(entry.host, entry.options);
    // An announcement, or shutdown, may have settled this light while the probe was out.
    if (this.#stopped || this.#pending.get(key) !== entry) return;
    switch (outcome.kind) {
      case "unreachable":
        entry.delayMs = nextRetryDelayMs(entry.delayMs);
        entry.dueAt = Date.now() + entry.delayMs;
        this.log.debug(
          `Retry ${entry.retries} of the Elgato device at ${host} failed, next in ` +
            `${entry.delayMs} ms: ${outcome.error.message}`,
        );
        return;
      case "busy":
        return;
      case "registered":
        this.#pending.delete(key);
        this.#registeredKeys.add(key);
        this.log.info(
          `Added the Elgato device at ${host} after ${entry.retries} ` +
            `${entry.retries === 1 ? "retry" : "retries"}`,
        );
        return;
      default:
        this.#pending.delete(key);
    }
  }

  #queueRetry(key: string, host: string, options: ProbeOptions): void {
    if (this.#stopped) return;
    const existing = this.#pending.get(key);
    if (existing) {
      // Same light, possibly a newer address: keep its place in the backoff.
      existing.host = host;
      existing.options = options;
      return;
    }
    this.#pending.set(key, {
      host,
      options,
      retries: 0,
      delayMs: RETRY_INITIAL_MS,
      dueAt: Date.now() + RETRY_INITIAL_MS,
    });
  }

  /**
   * Probe the host as given, and when that gets no answer and the light has a
   * `.local` name, probe the address mDNS gives for it as well. The name goes first
   * so that an OS resolver which speaks mDNS (bare metal with nss-mdns) keeps the
   * device on its name, following address changes; in a container the name fails
   * at once and the address is used (docs/how-it-works.md, "Addresses from mDNS").
   */
  async #probeWithFallback(
    host: string,
    options: ProbeOptions,
  ): Promise<{ outcome: ProbeOutcome; tried: string }> {
    const outcome = await this.#probe(host, options);
    if (outcome.kind !== "unreachable" || options.hostname === undefined || !this.#discovery) {
      return { outcome, tried: host };
    }
    const address = await this.#discovery.resolve(options.hostname);
    if (address === undefined || this.#stopped) return { outcome, tried: host };
    const resolved = formatHost(address, parseHost(host).port);
    if (resolved === host) return { outcome, tried: host };
    return { outcome: await this.#probe(resolved, options), tried: resolved };
  }

  /** One HTTP probe of one host, classified for `addDeviceByHost` and `#retry`. */
  async #probe(host: string, options: ProbeOptions): Promise<ProbeOutcome> {
    // A rejected device must not be re-probed over HTTP on every mDNS announcement.
    if (this.#skippedHosts.has(host) || this.#unsupported.has(host)) return { kind: "dropped" };
    if (this.#probingHosts.has(host)) return { kind: "busy" };
    this.#probingHosts.add(host);
    let claimedSerial: string | undefined;
    try {
      const { host: address, port } = parseHost(host);
      const client = new ElgatoClient(address, { port });
      const info = await client.getAccessoryInfo();
      const serial = info.serialNumber;
      if (this.#stopped) return { kind: "dropped" };

      if (this.#skippedSerials.has(serial)) {
        this.#skippedHosts.add(host);
        return { kind: "dropped" };
      }

      // Re-check after the await: the same light can announce itself under two host
      // strings (an IPv4 `up` and an `srv-update` with the hostname) at the same time,
      // and the check before the await would let both through to registerDevice.
      if (this.registry.has(serial)) {
        if (options.hostname !== undefined) this.#hostnames.set(serial, options.hostname);
        return {
          kind: "known",
          device: await this.#refreshKnownDevice(serial, address, host, info.displayName),
        };
      }
      if (this.#probingSerials.has(serial)) return { kind: "busy" };
      this.#probingSerials.add(serial);
      claimedSerial = serial;

      const device = await this.#registerLight(host, client, info, options);
      return device ? { kind: "registered", device } : { kind: "dropped" };
    } catch (error) {
      // Before the MK.2 check: a dropped battery probe can look like an empty reply.
      if (error instanceof BatteryProbeUnanswered) return { kind: "unreachable", error };
      if (error instanceof ElgatoHttpError && error.status === 0) {
        // An MK.2 light accepts the connection and then closes it without answering.
        // Not proof on its own, so this one is retried later (elgato/unsupported.ts).
        if (error.emptyReply) {
          this.#unsupported.note(host, options.model ?? deviceTypeName(undefined), {
            permanent: false,
          });
          return { kind: "dropped" };
        }
        // No answer at all: off, rebooting, or a name this resolver cannot look up.
        return { kind: "unreachable", error };
      }
      this.log.error(`Could not add the Elgato device at ${host}: ${(error as Error).message}`);
      return { kind: "dropped" };
    } finally {
      this.#probingHosts.delete(host);
      if (claimedSerial !== undefined) this.#probingSerials.delete(claimedSerial);
    }
  }

  /**
   * Build the Matter endpoint for a light we have just identified and hand it to
   * matterbridge. Split out of `addDeviceByHost` so that the probe there is only
   * about "is this a light, and is it new".
   */
  async #registerLight(
    host: string,
    client: ElgatoClient,
    info: AccessoryInfo,
    options: ProbeOptions,
  ): Promise<ElgatoDevice | undefined> {
    const serial = info.serialNumber;
    const light = (await client.getLights()).lights[0];
    // Shut down while that was out: registering now would put an endpoint on an
    // aggregator that is going away, with no poll timer to drive it.
    if (this.#stopped) return undefined;
    if (!light) {
      this.log.error(`The Elgato device at ${host} reported no lights, skipping it`);
      return undefined;
    }
    const capability = detectCapability(light);
    // The first name we ever saw for this serial is what feeds `uniqueId`
    // (docs/matterbridge-api-cheatsheet.md §3).
    const deviceName =
      options.name ??
      this.#storage.nameOf(serial) ??
      (info.displayName || options.instanceName || `${info.productName} ${serial}`);

    this.setSelectDevice(serial, deviceName, client.baseUrl, "wifi");
    if (!this.validateDevice([deviceName, serial])) {
      this.#skippedHosts.add(host);
      this.#skippedSerials.add(serial);
      return undefined;
    }

    // Before the endpoint exists: the answer picks the PowerSource feature set, and
    // matter.js fixes that when the endpoint is built.
    const battery = await this.#probeBattery(client, deviceName);
    if (this.#stopped) return undefined;
    const context: DeviceContext = {
      serial,
      deviceName,
      info,
      client,
      log: this.log,
      vendorId: this.matterbridge.aggregatorVendorId,
      debug: this.config.debug === true,
      colorDebounceMs: colorDebounceMs(this.config),
      ...(battery === undefined
        ? {}
        : { battery, batteryPollEvery: batteryPollEvery(this.config) }),
    };
    const device =
      capability === "ct"
        ? new KeyLightDevice(context)
        : new LightStripDevice({
            ...context,
            sceneStore: this.#sceneStore,
            preserveSceneOnOff: preserveSceneOnOff(this.config),
          });

    this.registry.add({ serial, client, info, capability });
    this.devices.set(serial, device);
    if (options.hostname !== undefined) this.#hostnames.set(serial, options.hostname);
    await this.#storage.rememberName(serial, deviceName);
    await this.registerDevice(device.endpoint);
    // The name is pinned, but the label a controller shows should still follow a
    // rename in the Elgato app.
    await device.refreshLabel(info.displayName);
    // A light that turns up after onConfigure joins the aggregator while the server
    // node is online, which matterbridge supports (it is `aggregatorNode.add`), but
    // it missed the seeding pass there (docs/matterbridge-api-cheatsheet.md §2).
    if (this.#configured) await device.seed();
    this.log.notice(
      `Registered ${deviceTypeName(info.hardwareBoardType)} "${deviceName}" (${serial}) at ${host} as ${
        capability === "ct" ? "colorTemperatureLight" : "extendedColorLight"
      }${battery === undefined ? "" : ` with its battery at ${Math.round(battery.level)} %`}`,
    );
    return device;
  }

  /**
   * Ask the light once whether it has a battery (ElgatoClient.probeBattery). A light
   * that answers 404 is never asked again, and that is logged at debug only, so a Key
   * Light Air or a Light Strip costs one request at registration and nothing in the
   * log. A probe that gets no usable answer throws `BatteryProbeUnanswered`, which
   * `#probe` reports as `unreachable`: the light is not built until its answer is
   * known, because the endpoint cannot change its PowerSource features later.
   */
  async #probeBattery(client: ElgatoClient, deviceName: string): Promise<BatteryInfo | undefined> {
    try {
      const battery = await client.probeBattery();
      if (battery === undefined) this.log.debug(`${deviceName} has no battery`);
      return battery;
    } catch (error) {
      throw new BatteryProbeUnanswered(
        `${deviceName} did not answer its battery probe: ${(error as Error).message}`,
      );
    }
  }

  /** Refresh an already-registered device's address and label. */
  async #refreshKnownDevice(
    serial: string,
    address: string,
    host: string,
    displayName: string,
  ): Promise<ElgatoDevice | undefined> {
    if (!this.registry.has(serial)) return undefined;
    if (this.registry.updateHost(serial, address)) {
      this.log.notice(`Device ${serial} is now at ${host}`);
    }
    const device = this.devices.get(serial);
    await device?.refreshLabel(displayName);
    return device;
  }

  #trackDiscovery(task: Promise<void>): void {
    this.#discoveryTasks.push(
      task.catch((error: unknown) => {
        this.log.error(`Discovery task failed: ${(error as Error).message}`);
      }),
    );
  }

  /** Wait for every announcement handled so far, including ones they started themselves. */
  async #settleDiscovery(): Promise<void> {
    while (this.#discoveryTasks.length > 0) {
      const tasks = this.#discoveryTasks;
      this.#discoveryTasks = [];
      await Promise.all(tasks);
    }
  }

  // ---- interval helpers (mirrors the official dynamic-platform example) ----

  addInterval(callback: () => Promise<void>, intervalTime: number): NodeJS.Timeout {
    const interval = setInterval(
      () => fireAndForget(callback(), this.log, "Failed to execute interval callback"),
      intervalTime,
    );
    this.intervals.push({ interval, callback });
    return interval;
  }

  /** Drives the poll loop deterministically from tests, without waiting on real time. */
  async executeIntervals(times: number, pauseTime = 0): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      for (const { callback } of this.intervals) await callback();
      if (pauseTime > 0) await new Promise((resolve) => setTimeout(resolve, pauseTime));
    }
  }

  clearIntervals(): void {
    for (const { interval } of this.intervals) clearInterval(interval);
    this.intervals = [];
  }
}
