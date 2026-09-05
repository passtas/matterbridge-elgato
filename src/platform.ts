/**
 * The Matterbridge dynamic platform: discovery, then one bridged endpoint per light,
 * then the poll loop that keeps the Matter attributes in step with the devices.
 */

import {
  MatterbridgeDynamicPlatform,
  type PlatformConfig,
  type PlatformMatterbridge,
} from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import { fireAndForget } from "matterbridge/utils";

import {
  colorDebounceMs,
  DISCOVERY_WINDOW_MS,
  manualDevices,
  mdnsEnabled,
  pollIntervalMs,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
} from "./config.ts";
import { ElgatoClient, ElgatoHttpError, parseHost } from "./elgato/client.ts";
import { ElgatoDiscovery } from "./elgato/discovery.ts";
import { DeviceRegistry } from "./elgato/registry.ts";
import { advertisedModel, UnsupportedDevices, usesTlsTransport } from "./elgato/unsupported.ts";
import type { AccessoryInfo, DiscoveredService } from "./elgato/types.ts";
import { KeyLightDevice } from "./devices/keyLight.ts";
import { LightStripDevice } from "./devices/lightStrip.ts";
import type { SceneStore } from "./devices/scenes.ts";
import type { DeviceContext, ElgatoDevice } from "./devices/shared.ts";
import { detectCapability, deviceTypeName } from "./mapping.ts";
import { PluginStorage } from "./pluginStorage.ts";

const REQUIRED_MATTERBRIDGE_VERSION = "3.10.0";

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

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? "none"}`);
    await this.ready;
    await this.clearSelect();
    await this.#storage.load();

    for (const device of manualDevices(this.config)) {
      await this.addDeviceByHost(device.host, { name: device.name });
    }

    if (mdnsEnabled(this.config)) {
      this.#discovery = new ElgatoDiscovery();
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
    const interval = pollIntervalMs(this.config);
    this.addInterval(() => this.pollAll(), interval);
    this.log.info(`Polling ${this.devices.size} device(s) every ${interval} ms`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.clearIntervals();
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
    this.log.debug(`mDNS: ${service.instanceName} at ${service.host}:${service.port}`);
    if (usesTlsTransport(service)) {
      this.#unsupported.note(service.host, advertisedModel(service.txt), { permanent: true });
      return;
    }
    await this.addDeviceByHost(service.host, {
      instanceName: service.instanceName,
      model: advertisedModel(service.txt),
    });
  }

  /**
   * Probe one host and, if it is a light we do not know yet, build and register its
   * endpoint. Idempotent: a known serial only gets its address and label refreshed.
   */
  async addDeviceByHost(
    host: string,
    options: { name?: string; instanceName?: string; model?: string } = {},
  ): Promise<ElgatoDevice | undefined> {
    // A rejected device must not be re-probed over HTTP on every mDNS announcement.
    if (this.#skippedHosts.has(host) || this.#unsupported.has(host)) return undefined;
    if (this.#probingHosts.has(host)) return undefined;
    this.#probingHosts.add(host);
    let claimedSerial: string | undefined;
    try {
      const { host: address, port } = parseHost(host);
      const client = new ElgatoClient(address, { port });
      const info = await client.getAccessoryInfo();
      const serial = info.serialNumber;

      if (this.#skippedSerials.has(serial)) {
        this.#skippedHosts.add(host);
        return undefined;
      }

      // Re-check after the await: the same light can announce itself under two host
      // strings (an IPv4 `up` and an `srv-update` with the hostname) at the same time,
      // and the check before the await would let both through to registerDevice.
      const known = await this.#refreshKnownDevice(serial, address, host, info.displayName);
      if (known !== undefined) return known;
      if (this.#probingSerials.has(serial)) return undefined;
      this.#probingSerials.add(serial);
      claimedSerial = serial;

      return await this.#registerLight(host, client, info, options);
    } catch (error) {
      // An MK.2 light accepts the connection and then closes it without answering.
      // Not proof on its own, so this one is retried later (elgato/unsupported.ts).
      if (error instanceof ElgatoHttpError && error.emptyReply) {
        this.#unsupported.note(host, options.model ?? deviceTypeName(undefined), {
          permanent: false,
        });
        return undefined;
      }
      this.log.error(`Could not add the Elgato device at ${host}: ${(error as Error).message}`);
      return undefined;
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
    options: { name?: string; instanceName?: string },
  ): Promise<ElgatoDevice | undefined> {
    const serial = info.serialNumber;
    const light = (await client.getLights()).lights[0];
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

    const context: DeviceContext = {
      serial,
      deviceName,
      info,
      client,
      log: this.log,
      vendorId: this.matterbridge.aggregatorVendorId,
      debug: this.config.debug === true,
      colorDebounceMs: colorDebounceMs(this.config),
    };
    const device =
      capability === "ct"
        ? new KeyLightDevice(context)
        : new LightStripDevice({ ...context, sceneStore: this.#sceneStore });

    this.registry.add({ serial, client, info, capability });
    this.devices.set(serial, device);
    await this.#storage.rememberName(serial, deviceName);
    await this.registerDevice(device.endpoint);
    // The name is pinned, but the label a controller shows should still follow a
    // rename in the Elgato app.
    await device.refreshLabel(info.displayName);
    this.log.notice(
      `Registered ${deviceTypeName(info.hardwareBoardType)} "${deviceName}" (${serial}) at ${host} as ${
        capability === "ct" ? "colorTemperatureLight" : "extendedColorLight"
      }`,
    );
    return device;
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
