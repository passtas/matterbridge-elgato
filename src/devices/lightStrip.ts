/**
 * Color models: the Light Strip, and anything else whose `GET /elgato/lights` has no
 * `temperature`. Two schemas show up at runtime, HSV `{ on, brightness, hue,
 * saturation }` and scene `{ on, id, name, brightness, scene[] }`
 * (docs/elgato-protocol.md §4b and §4c).
 *
 * Matter side: ExtendedColorLight with the XY/HS/CT ColorControl server, per the
 * ecosystem convention (docs/matterbridge-api-cheatsheet.md §3).
 */

import { MatterbridgeEndpoint, bridgedNode, extendedColorLight, powerSource } from "matterbridge";
import { ColorControl, LevelControl, OnOff } from "matterbridge/matter/clusters";
import {
  kelvinToRGB,
  miredToKelvin,
  rgbColorToHslColor,
  xyColorToRgbColor,
} from "matterbridge/utils";

import { ElgatoHttpError } from "../elgato/client.ts";
import type { LightState, LightsResponse, SceneLightState } from "../elgato/types.ts";
import {
  MIN_LEVEL,
  clamp,
  hsvSaturation,
  isSceneState,
  toElgatoBrightness,
  toElgatoHue,
  toElgatoSaturation,
  toMatterHue,
  toMatterLevel,
  toMatterSaturation,
} from "../mapping.ts";
import { type SceneStore, sameScene, sceneToPatch } from "./scenes.ts";
import {
  type ApplyOptions,
  type DeviceContext,
  ElgatoDevice,
  type OwnedAttribute,
  VENDOR_NAME,
} from "./shared.ts";

/**
 * The strip has no white channel, but ColorTemperature is a mandatory
 * ExtendedColorLight feature and `createDefaultColorControlClusterServer()` advertises
 * 147 to 500 mireds. Left unhandled, Google and Apple show a warm-to-cool slider that
 * does nothing, so the command is turned into an HSV write instead.
 */
export const STRIP_CT_MIN_MIREDS = 147;
export const STRIP_CT_MAX_MIREDS = 500;

export interface StripContext extends DeviceContext {
  sceneStore?: SceneStore;
  /** Switch off by parking the scene rather than destroying it. See `#switchOff`. */
  preserveSceneOnOff?: boolean;
}

export class LightStripDevice extends ElgatoDevice {
  readonly #sceneStore: SceneStore | undefined;
  readonly #colorDebounceMs: number;
  readonly #preserveSceneOnOff: boolean;
  #cachedScene: SceneLightState | undefined;
  #sceneActive = false;
  /** Last seen in schema 4c with `on: 0`: off, but holding its scene. */
  #sceneParked = false;
  #resumeScene = false;
  /**
   * Bumped by every command that sets the power state (on, off, level-with-on/off), so
   * an off that is still waiting on the strip can tell a newer one has overtaken it.
   */
  #powerGeneration = 0;
  #colorMode: ColorControl.ColorMode | undefined;
  #colorTimer: NodeJS.Timeout | undefined;
  #pendingHue: number | undefined;
  #pendingSaturation: number | undefined;

  constructor(context: StripContext) {
    super(context);
    this.#colorDebounceMs = context.colorDebounceMs;
    this.#sceneStore = context.sceneStore;
    this.#preserveSceneOnOff = context.preserveSceneOnOff === true;
    this.#cachedScene = context.sceneStore?.load(context.serial);
  }

  /** The scene the strip was last seen playing, if any. */
  get cachedScene(): SceneLightState | undefined {
    return this.#cachedScene;
  }

  get sceneActive(): boolean {
    return this.#sceneActive;
  }

  get resumeScene(): boolean {
    return this.#resumeScene;
  }

  get sceneParked(): boolean {
    return this.#sceneParked;
  }

  protected override createEndpoint(context: DeviceContext): MatterbridgeEndpoint {
    return new MatterbridgeEndpoint(
      [extendedColorLight, bridgedNode, powerSource],
      { id: context.serial },
      context.debug,
    )
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        context.deviceName,
        context.serial,
        context.vendorId,
        VENDOR_NAME,
        context.info.productName,
        context.info.firmwareBuildNumber,
        context.info.firmwareVersion,
        Number(context.info.hardwareRevision) || 1,
        String(context.info.hardwareRevision),
      )
      .createDefaultOnOffClusterServer()
      .createDefaultLevelControlClusterServer()
      .createDefaultColorControlClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();
  }

  protected override registerHandlers(): void {
    this.endpoint
      .addCommandHandler("identify", ({ request }) => {
        this.log.info(`${this.deviceName}: identify for ${request.identifyTime}s`);
      })
      .addCommandHandler("on", async () => {
        const generation = ++this.#powerGeneration;
        // A strip parked off inside a scene does not resume it on a bare `on: 1`, it
        // reverts to the previous HSV state (docs/elgato-protocol.md, addendum). Only
        // the whole scene body brings it back. Gated on the flag so that without it the
        // wire traffic is exactly what v0.1 sent.
        const parked = this.#preserveSceneOnOff && this.#sceneParked;
        if ((this.#resumeScene || parked) && this.#cachedScene) {
          this.log.info(`${this.deviceName}: putting the scene "${this.#cachedScene.name}" back`);
          // Only forget the intent once the device has actually taken the scene back,
          // otherwise a failed write loses it until the next scene is observed. And not
          // if an off arrived meanwhile: it queued behind this write, will destroy the
          // scene again, and set the intent that this line would otherwise clear.
          const resumed = await this.write(sceneToPatch(this.#cachedScene), ["onOff"]);
          if (resumed && generation === this.#powerGeneration) this.#resumeScene = false;
          return;
        }
        await this.write({ on: 1 }, ["onOff"]);
      })
      .addCommandHandler("off", async () => {
        await this.#switchOff(++this.#powerGeneration, ["onOff"]);
      })
      .addCommandHandler("moveToLevel", async ({ request }) => {
        this.#resumeScene = false;
        await this.write({ brightness: toElgatoBrightness(request.level) }, ["level"]);
      })
      .addCommandHandler("moveToLevelWithOnOff", async ({ request }) => {
        // matter.js crops to minLevel 1 and couples OnOff to false there: level 1 or
        // below is an off, not a dim to 3 %.
        const generation = ++this.#powerGeneration;
        if (request.level <= MIN_LEVEL) {
          await this.#switchOff(generation, ["level", "onOff"]);
          return;
        }
        this.#resumeScene = false;
        await this.write({ on: 1, brightness: toElgatoBrightness(request.level) }, [
          "level",
          "onOff",
        ]);
      })
      .addCommandHandler("moveToHueAndSaturation", async ({ request }) => {
        // Arrives complete, so no debounce needed.
        this.#cancelColorDebounce();
        await this.#writeColor(request.hue, request.saturation);
      })
      .addCommandHandler("moveToHue", ({ request }) => {
        this.#pendingHue = request.hue;
        this.#scheduleColorWrite();
      })
      .addCommandHandler("moveToSaturation", ({ request }) => {
        this.#pendingSaturation = request.saturation;
        this.#scheduleColorWrite();
      })
      .addCommandHandler("moveToColor", async ({ request }) => {
        // The strip has no XY model, so convert through matterbridge's color utils.
        const rgb = xyColorToRgbColor(request.colorX / 65536, request.colorY / 65536);
        this.#cancelColorDebounce();
        await this.#writeColor(
          toMatterHue(rgbColorToHslColor(rgb).h),
          toMatterSaturation(hsvSaturation(rgb)),
        );
      })
      .addCommandHandler("moveToColorTemperature", async ({ request }) => {
        // Approximate the requested white point on the color wheel. `temperature` is
        // never sent: the strip has no such field, and mixing it with hue/saturation is
        // forbidden anyway (docs/elgato-protocol.md §9).
        const mireds = clamp(
          Math.round(request.colorTemperatureMireds),
          STRIP_CT_MIN_MIREDS,
          STRIP_CT_MAX_MIREDS,
        );
        const rgb = kelvinToRGB(miredToKelvin(mireds));
        this.#cancelColorDebounce();
        await this.#writeColor(
          toMatterHue(rgbColorToHslColor(rgb).h),
          toMatterSaturation(hsvSaturation(rgb)),
          ["ct"],
        );
      });
  }

  /**
   * Matter Off, and a level command cropped to off. A bare `{on: 0}` destroys a running
   * scene and reverts the strip to its previous HSV state (docs/elgato-protocol.md §8),
   * so the next on replays the cached scene either way.
   *
   * With `preserveSceneOnOff`, the cached scene goes out with `on: 0` in the same body
   * instead, and the strip parks off with the scene still stored (addendum, "`on: 0`
   * sent in the same body as a scene"). Never `brightness: 0` as an off: that leaves
   * the light on at zero output (§10, quirk 3).
   */
  async #switchOff(generation: number, skip: readonly OwnedAttribute[]): Promise<void> {
    if (this.#sceneActive) this.#resumeScene = true;
    const scene = this.#canPark() ? this.#cachedScene : undefined;
    if (!scene) {
      await this.write({ on: 0 }, skip);
      return;
    }

    let response: LightsResponse;
    try {
      response = await this.queue.push({ ...sceneToPatch(scene), on: 0 });
    } catch (error) {
      await this.#parkRejected(error, scene, generation, skip);
      return;
    }
    // Outside the try: the park landed, so a failure from here on must not turn into
    // a bare off that would destroy it.
    try {
      await this.applyEcho(response, skip);
    } catch (error) {
      this.log.error(`${this.deviceName}: parked, but ${(error as Error).message}`);
    }
  }

  /**
   * Park only from a settled state. A write still queued or in flight, or a color change
   * waiting in the debounce, may already have destroyed the scene on the device, and
   * the queue would fold that write into the scene body and drop it (writeQueue.ts).
   * Then the plain v0.1 off is the right answer.
   */
  #canPark(): boolean {
    return (
      this.#preserveSceneOnOff &&
      this.#sceneActive &&
      this.queue.idle &&
      this.#colorTimer === undefined &&
      this.#pendingHue === undefined &&
      this.#pendingSaturation === undefined
    );
  }

  /** The scene-preserving off did not land. Decide whether a bare off should follow. */
  async #parkRejected(
    error: unknown,
    scene: SceneLightState,
    generation: number,
    skip: readonly OwnedAttribute[],
  ): Promise<void> {
    const message = (error as Error).message;
    // The issue asked for a fallback on any throw. Only a refusal from the strip (an
    // HTTP error status, or an `errors` body) proves the park did not land, though. A
    // timeout, a reset or a garbled 200 may hide a park that did, which a bare off
    // would then destroy, and a second write to a light that did not answer the first
    // costs another full timeout. So log it the way `write` does and let the next
    // poll reconcile, as v0.1 does for a failed off.
    if (!(error instanceof ElgatoHttpError) || !error.refused) {
      this.log.error(`${this.deviceName} did not accept the change: ${message}`);
      return;
    }
    // A newer on or off overtook this one while the strip was answering. Sending the
    // bare off now would land after it and switch the light off behind its back.
    if (generation !== this.#powerGeneration) {
      this.log.debug(`${this.deviceName}: could not park "${scene.name}" (${message}), superseded`);
      return;
    }
    // The light going off is not optional: one bare off, and no retry of the scene
    // body. The Strip 400s anything it dislikes (§6).
    this.log.debug(
      `${this.deviceName}: could not park "${scene.name}" (${message}), switching off without it`,
    );
    await this.write({ on: 0 }, skip);
  }

  /**
   * Controllers send hue and saturation as two separate commands. Without a debounce
   * every color change is two PUTs, and the first one uses a stale companion value
   * (docs/matterbridge-api-cheatsheet.md §4).
   */
  #scheduleColorWrite(): void {
    this.#cancelColorDebounce();
    this.#colorTimer = setTimeout(() => {
      void this.flushPendingColor();
    }, this.#colorDebounceMs);
    this.#colorTimer.unref();
  }

  #cancelColorDebounce(): void {
    if (this.#colorTimer) clearTimeout(this.#colorTimer);
    this.#colorTimer = undefined;
  }

  /** Write whatever hue/saturation is pending right now. Exposed so tests need no fake timers. */
  async flushPendingColor(): Promise<void> {
    this.#cancelColorDebounce();
    if (this.#pendingHue === undefined && this.#pendingSaturation === undefined) return;
    const hue =
      this.#pendingHue ?? this.endpoint.getAttribute(ColorControl.id, "currentHue", this.log) ?? 0;
    const saturation =
      this.#pendingSaturation ??
      this.endpoint.getAttribute(ColorControl.id, "currentSaturation", this.log) ??
      0;
    this.#pendingHue = undefined;
    this.#pendingSaturation = undefined;
    await this.#writeColor(hue as number, saturation as number);
  }

  async #writeColor(
    matterHue: number,
    matterSaturation: number,
    extraSkip: readonly OwnedAttribute[] = [],
  ): Promise<void> {
    this.#resumeScene = false;
    // No `on` field: a color command must not power the light on by itself, or the
    // reported OnOff state and the physical light disagree.
    await this.write(
      { hue: toElgatoHue(matterHue), saturation: toElgatoSaturation(matterSaturation) },
      ["hue", "saturation", ...extraSkip],
    );
  }

  protected override async applyState(
    light: LightState,
    options: ApplyOptions = {},
  ): Promise<void> {
    const skip = options.skip ?? [];
    const push = this.attributeWriter(options.seed);

    this.#sceneActive = isSceneState(light);
    // Parked is still scene mode: cache it, report off, keep the scene master level.
    this.#sceneParked = this.#sceneActive && light.on === 0;
    if (isSceneState(light)) {
      // Persist only a scene that is new. A strip parked in a scene reports it on every
      // poll all night, and each save is a disk write (an SD card, on a Pi).
      const changed = !this.#cachedScene || !sameScene(this.#cachedScene, light);
      this.#cachedScene = light;
      if (changed) this.#sceneStore?.save(this.serial, light);
    }

    if (!skip.includes("onOff")) await push(OnOff.id, "onOff", light.on === 1, this.log);
    if (light.brightness !== undefined && !skip.includes("level")) {
      // In scene mode `brightness` is the scene master level, the closest thing to a
      // dimmer the strip exposes while a scene plays.
      await push(LevelControl.id, "currentLevel", toMatterLevel(light.brightness), this.log);
    }

    // While a scene is playing there are no hue/saturation fields at all, so keep the
    // last known color rather than reporting 0/0. On a cold seed there is no last
    // known color, so use the scene's first keyframe instead.
    if (this.#sceneActive) {
      const first = options.seed ? this.#cachedScene?.scene[0] : undefined;
      if (first) {
        await push(ColorControl.id, "currentHue", toMatterHue(first.hue), this.log);
        await push(
          ColorControl.id,
          "currentSaturation",
          toMatterSaturation(first.saturation),
          this.log,
        );
      }
      return;
    }

    if (light.hue !== undefined && !skip.includes("hue")) {
      await push(ColorControl.id, "currentHue", toMatterHue(light.hue), this.log);
    }
    if (light.saturation !== undefined && !skip.includes("saturation")) {
      await push(
        ColorControl.id,
        "currentSaturation",
        toMatterSaturation(light.saturation),
        this.log,
      );
    }
    // Never from a command handler: matterbridge does not sync colorMode itself, and
    // the reference plugins set it only on the update path
    // (docs/matterbridge-api-cheatsheet.md §4).
    if (!options.command && (light.hue !== undefined || light.saturation !== undefined)) {
      await this.#setColorMode(ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
    }
  }

  /**
   * `configureColorControlMode` writes without diffing, so calling it on every poll
   * logs a "0 to 0" change for colorMode and enhancedColorMode every few seconds.
   * The strip only ever moves between two modes, so remember which one is set.
   */
  async #setColorMode(mode: ColorControl.ColorMode): Promise<void> {
    if (this.#colorMode === mode) return;
    this.#colorMode = mode;
    await this.endpoint.configureColorControlMode(mode);
  }

  /** Shutdown path: push the debounced color out before the queue is drained. */
  override async flush(): Promise<void> {
    await this.flushPendingColor();
    await super.flush();
  }

  override dispose(): void {
    this.#cancelColorDebounce();
    super.dispose();
  }
}
