/**
 * Shared plumbing for the two Elgato device flavours: endpoint identity, the write
 * queue, reachability tracking, the seed/poll cycle and the PowerSource cluster
 * (wired, or the battery of a Key Light Mini). The endpoint shape, the command
 * handlers and the state mapping come from the subclasses.
 */

import type { MatterbridgeEndpoint } from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import { BridgedDeviceBasicInformation, PowerSource } from "matterbridge/matter/clusters";
import type { ClusterId } from "matterbridge/matter/types";

import type { ElgatoClient } from "../elgato/client.ts";
import type {
  AccessoryInfo,
  BatteryInfo,
  LightPatch,
  LightState,
  LightsResponse,
} from "../elgato/types.ts";
import {
  batteryUpdate,
  toBatChargeLevel,
  toBatChargeState,
  toMatterBatPercent,
  toMatterBatVoltage,
} from "../mapping.ts";
import { WriteQueue } from "../writeQueue.ts";

export const VENDOR_NAME = "Elgato";
/** Consecutive poll failures before the bridged device is reported as unreachable. */
export const UNREACHABLE_AFTER_FAILURES = 3;

/**
 * The loose `setAttribute`/`updateAttribute` overload, named so the emitted `.d.ts`
 * does not have to reference matterbridge's own `@matter` internals.
 */
export type AttributeWriter = (
  cluster: ClusterId | string,
  attribute: string,
  value: boolean | number | bigint | string | object | null,
  log?: AnsiLogger,
) => Promise<boolean>;

/** An attribute a command handler owns. Matterbridge writes those itself after the handler. */
export type OwnedAttribute = "onOff" | "level" | "ct" | "hue" | "saturation";

export interface ApplyOptions {
  /** `setAttribute` (unconditional) for seeding, `updateAttribute` (diffing) for polling. */
  seed?: boolean;
  /** Attributes the in-flight command owns, skipped to avoid double-reporting. */
  skip?: readonly OwnedAttribute[];
  /** Set when the state came back from a command's PUT rather than from the poll loop. */
  command?: boolean;
}

export interface DeviceContext {
  serial: string;
  /** Feeds `uniqueId`, see docs/matterbridge-api-cheatsheet.md §3. */
  deviceName: string;
  info: AccessoryInfo;
  client: ElgatoClient;
  log: AnsiLogger;
  vendorId: number;
  debug: boolean;
  /** Hue/saturation debounce window, ms. Controllers send the two as separate commands. */
  colorDebounceMs: number;
  /**
   * The first battery reading, present only when the battery probe said yes. It decides
   * the PowerSource feature set, which is fixed once the endpoint is built.
   */
  battery?: BatteryInfo;
  /** Read `battery-info` on every Nth successful poll tick (config.ts `batteryPollEvery`). */
  batteryPollEvery?: number;
}

/**
 * Put the PowerSource cluster on a light's endpoint: Wired for a light on mains, or
 * Battery + Rechargeable for a light with a battery. Matter makes Wired and Battery
 * mutually exclusive features of one cluster instance, and matter.js fixes the
 * features when the endpoint is built, so this has to know the probe's answer first.
 * See docs/matterbridge-api-cheatsheet.md §3.
 */
export const withPowerSource = (
  endpoint: MatterbridgeEndpoint,
  battery: BatteryInfo | undefined,
): MatterbridgeEndpoint => {
  if (battery === undefined) return endpoint.createDefaultPowerSourceWiredClusterServer();
  // The helper takes whole percent and doubles it without rounding, so 96.05 would
  // land as 192.1. Hand it the already-rounded half-percent count, halved back.
  const halfPercents = toMatterBatPercent(battery.level);
  endpoint.createDefaultPowerSourceRechargeableBatteryClusterServer(
    halfPercents === null ? null : halfPercents / 2,
    toBatChargeLevel(battery.level) as PowerSource.BatChargeLevel,
    toMatterBatVoltage(battery.currentBatteryVoltage),
    PowerSource.BatReplaceability.NotReplaceable,
  );
  // The helper hard-codes batChargeState IsNotCharging and takes no argument for it,
  // and setAttribute refuses an endpoint that is not registered yet. The options
  // object the helper handed to `behaviors.require` is what matter.js reads the
  // initial state from (Behaviors.defaultsFor), so set the probed state there.
  const powerSourceType = endpoint.behaviors.supported["powerSource"];
  const options = powerSourceType && endpoint.behaviors.optionsFor(powerSourceType);
  if (options) {
    Object.assign(options, { batChargeState: toBatChargeState(battery.status) });
  }
  return endpoint;
};

export abstract class ElgatoDevice {
  readonly serial: string;
  readonly deviceName: string;
  readonly endpoint: MatterbridgeEndpoint;
  protected readonly client: ElgatoClient;
  protected readonly log: AnsiLogger;
  protected readonly queue: WriteQueue;
  /** Whether the endpoint carries the battery variant of PowerSource. Fixed for its lifetime. */
  readonly hasBattery: boolean;
  readonly #batteryPollEvery: number;
  /** The probe's reading, handed to the first seed so it need not ask again. */
  #probedBattery: BatteryInfo | undefined;
  /** Successful poll ticks, to read the battery on every Nth. */
  #ticks = 0;
  #failures = 0;
  #reachable = true;

  constructor(context: DeviceContext) {
    this.serial = context.serial;
    this.deviceName = context.deviceName;
    this.client = context.client;
    this.log = context.log;
    this.hasBattery = context.battery !== undefined;
    this.#probedBattery = context.battery;
    this.#batteryPollEvery = Math.max(1, Math.floor(context.batteryPollEvery ?? 1));
    this.queue = new WriteQueue((patch) => this.client.putLights(patch));
    this.endpoint = this.createEndpoint(context);
    this.registerHandlers();
  }

  protected abstract createEndpoint(context: DeviceContext): MatterbridgeEndpoint;
  protected abstract registerHandlers(): void;
  /** Push one polled or echoed light object into the Matter attributes. */
  protected abstract applyState(light: LightState, options?: ApplyOptions): Promise<void>;

  /** Unconditional one-shot state push, for `onConfigure` once the server node is online. */
  async seed(): Promise<void> {
    const light = await this.readLight();
    if (!light) return;
    await this.applyState(light, { seed: true });
    await this.#readBattery(true);
  }

  /**
   * Diffing state push on the poll interval, plus reachability bookkeeping. A light
   * with a battery also has `battery-info` read on every Nth tick, in this same tick
   * rather than on a timer of its own, and only when the light answered: an offline
   * light would otherwise cost a second timeout per tick (docs/elgato-protocol.md §2,
   * the firmware serves one request at a time).
   */
  async poll(): Promise<void> {
    const light = await this.readLight();
    if (!light) return;
    await this.applyState(light);
    this.#ticks += 1;
    if (this.#ticks % this.#batteryPollEvery === 0) await this.#readBattery(false);
  }

  /**
   * Read the battery and push it into PowerSource. A failure here is logged at debug
   * and nothing else: it never counts towards `unreachable` and never touches the
   * light's own attributes, because the light itself just answered. The first seed
   * reuses the reading the probe took moments earlier instead of asking again.
   */
  async #readBattery(seed: boolean): Promise<void> {
    if (!this.hasBattery) return;
    const probed = this.#probedBattery;
    this.#probedBattery = undefined;
    if (seed && probed) {
      await this.applyBattery(probed, true);
      return;
    }
    let info: BatteryInfo;
    try {
      info = await this.client.getBatteryInfo();
    } catch (error) {
      this.log.debug(
        `${this.deviceName}: battery read failed, keeping the last values: ${(error as Error).message}`,
      );
      return;
    }
    await this.applyBattery(info, seed);
  }

  /**
   * Push one `battery-info` reading into the PowerSource attributes. Seeding writes
   * every value; polling goes through `batteryUpdate`'s hysteresis, because the
   * firmware's percentage and voltage wobble between reads (mapping.ts).
   */
  protected async applyBattery(info: BatteryInfo, seed = false): Promise<void> {
    const push = this.attributeWriter(seed);
    const update = seed
      ? batteryUpdate({ batPercentRemaining: null, batChargeLevel: -1, batVoltage: null }, info)
      : batteryUpdate(
          {
            batPercentRemaining: this.endpoint.getAttribute(
              PowerSource.id,
              "batPercentRemaining",
            ) as number | null,
            batChargeLevel: this.endpoint.getAttribute(PowerSource.id, "batChargeLevel") as number,
            batVoltage: this.endpoint.getAttribute(PowerSource.id, "batVoltage") as number | null,
          },
          info,
        );
    for (const [attribute, value] of Object.entries(update)) {
      await push(PowerSource.id, attribute, value as number, this.log);
    }
  }

  /**
   * Queue a PUT, then feed the echoed full state back into the attributes.
   * A rejected write is logged at error and otherwise swallowed.
   * Returns whether the device accepted the write; callers that update their own
   * bookkeeping on success (scene resume) need to know.
   */
  protected async write(patch: LightPatch, skip: readonly OwnedAttribute[] = []): Promise<boolean> {
    try {
      await this.applyEcho(await this.queue.push(patch), skip);
      return true;
    } catch (error) {
      // Do not fail the Matter command: log it and let the next poll reconcile.
      this.log.error(`${this.deviceName} did not accept the change: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Feed a PUT response into the attributes. Split out of `write` for a caller that
   * has to tell a rejected PUT apart from a failure after it (the Light Strip's
   * scene-preserving off).
   */
  protected async applyEcho(
    response: LightsResponse,
    skip: readonly OwnedAttribute[] = [],
  ): Promise<void> {
    const light = response.lights[0];
    // The PUT response is byte-identical to a following GET, so never re-GET
    // to confirm (docs/elgato-protocol.md §5).
    if (light) await this.applyState(light, { skip, command: true });
    await this.setReachable(true);
  }

  /**
   * Push any debounced work out and wait for the queue to empty. Called on shutdown so
   * that a color change made a moment before a restart is not silently dropped.
   */
  async flush(): Promise<void> {
    await this.queue.settled();
  }

  /** Keep the controller-visible label in step with a rename in the Elgato app. */
  async refreshLabel(displayName: string): Promise<void> {
    if (!displayName) return;
    await this.endpoint.updateAttribute(
      BridgedDeviceBasicInformation.id,
      "nodeLabel",
      displayName.slice(0, 32),
      this.log,
    );
  }

  protected async readLight(): Promise<LightState | undefined> {
    let response: LightsResponse;
    try {
      response = await this.client.getLights();
    } catch (error) {
      await this.#markFailure(error);
      return undefined;
    }
    const light = response.lights[0];
    if (!light) {
      await this.#markFailure(new Error("the device reported no lights"));
      return undefined;
    }
    this.#failures = 0;
    await this.setReachable(true);
    return light;
  }

  async #markFailure(error: unknown): Promise<void> {
    this.#failures += 1;
    this.log.debug(
      `${this.deviceName}: poll failed (${this.#failures}/${UNREACHABLE_AFTER_FAILURES}): ${(error as Error).message}`,
    );
    if (this.#failures >= UNREACHABLE_AFTER_FAILURES) await this.setReachable(false);
  }

  /** The endpoint stays registered when a light drops off the network; only `reachable` flips. */
  protected async setReachable(reachable: boolean): Promise<void> {
    if (this.#reachable === reachable) return;
    this.#reachable = reachable;
    this.#failures = reachable ? 0 : this.#failures;
    // A Key Light Mini set to save energy turns its Wi-Fi off on low battery
    // (docs/elgato-protocol.md §3, `lights/settings.battery.energySaving`).
    const hint = this.hasBattery
      ? " (on battery it may have switched its Wi-Fi off to save energy)"
      : "";
    this.log.notice(
      reachable
        ? `${this.deviceName} is answering again at ${this.client.host}`
        : `${this.deviceName} stopped answering at ${this.client.host}, reporting it as unreachable${hint}`,
    );
    await this.endpoint.updateAttribute(
      BridgedDeviceBasicInformation,
      "reachable",
      reachable,
      this.log,
    );
  }

  get reachable(): boolean {
    return this.#reachable;
  }

  /**
   * `setAttribute` (unconditional) when seeding in `onConfigure`, `updateAttribute`
   * (diffing) on the poll path so unchanged values do not spam every paired fabric.
   * Bound to the loose `ClusterId` overload, so pass `OnOff.id` and friends.
   */
  protected attributeWriter(seed?: boolean): AttributeWriter {
    return seed
      ? this.endpoint.setAttribute.bind(this.endpoint)
      : this.endpoint.updateAttribute.bind(this.endpoint);
  }

  /** Release timers. Called from the platform's `onShutdown`. */
  dispose(): void {
    // Subclasses with timers override this and call super.
  }
}
