/**
 * Shared plumbing for the two Elgato device flavours: endpoint identity, the write
 * queue, reachability tracking and the seed/poll cycle. The endpoint shape, the
 * command handlers and the state mapping come from the subclasses.
 */

import type { MatterbridgeEndpoint } from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";
import { BridgedDeviceBasicInformation } from "matterbridge/matter/clusters";
import type { ClusterId } from "matterbridge/matter/types";

import type { ElgatoClient } from "../elgato/client.ts";
import type { AccessoryInfo, LightPatch, LightState, LightsResponse } from "../elgato/types.ts";
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
}

export abstract class ElgatoDevice {
  readonly serial: string;
  readonly deviceName: string;
  readonly endpoint: MatterbridgeEndpoint;
  protected readonly client: ElgatoClient;
  protected readonly log: AnsiLogger;
  protected readonly queue: WriteQueue;
  #failures = 0;
  #reachable = true;

  constructor(context: DeviceContext) {
    this.serial = context.serial;
    this.deviceName = context.deviceName;
    this.client = context.client;
    this.log = context.log;
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
    if (light) await this.applyState(light, { seed: true });
  }

  /** Diffing state push on the poll interval, plus reachability bookkeeping. */
  async poll(): Promise<void> {
    const light = await this.readLight();
    if (light) await this.applyState(light);
  }

  /**
   * Queue a PUT, then feed the echoed full state back into the attributes.
   * Returns whether the device accepted the write; callers that update their own
   * bookkeeping on success (scene resume) need to know.
   */
  protected async write(patch: LightPatch, skip: readonly OwnedAttribute[] = []): Promise<boolean> {
    try {
      const response = await this.queue.push(patch);
      const light = response.lights[0];
      // The PUT response is byte-identical to a following GET, so never re-GET
      // to confirm (docs/elgato-protocol.md §5).
      if (light) await this.applyState(light, { skip, command: true });
      await this.setReachable(true);
      return true;
    } catch (error) {
      // Do not fail the Matter command: log it and let the next poll reconcile.
      this.log.error(`${this.deviceName} did not accept the change: ${(error as Error).message}`);
      return false;
    }
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
    this.log.notice(
      reachable
        ? `${this.deviceName} is answering again at ${this.client.host}`
        : `${this.deviceName} stopped answering at ${this.client.host}, reporting it as unreachable`,
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
