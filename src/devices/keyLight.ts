/**
 * The CCT models: Key Light, Key Light Air, Key Light Mini and Neo, Ring Light.
 * `GET /elgato/lights` returns `{ on, brightness, temperature }`
 * (docs/elgato-protocol.md §4a).
 *
 * Matter side: ColorTemperatureLight with a CT-only ColorControl server.
 */

import {
  MatterbridgeEndpoint,
  bridgedNode,
  colorTemperatureLight,
  powerSource,
} from "matterbridge";
import { ColorControl, LevelControl, OnOff } from "matterbridge/matter/clusters";

import type { LightState } from "../elgato/types.ts";
import {
  MAX_MIREDS,
  MIN_LEVEL,
  MIN_MIREDS,
  toElgatoBrightness,
  toElgatoTemperature,
  toMatterLevel,
  toMatterMireds,
} from "../mapping.ts";
import { type ApplyOptions, type DeviceContext, ElgatoDevice, VENDOR_NAME } from "./shared.ts";

/** Mid-range default; overwritten by the first seed/poll. */
const DEFAULT_MIREDS = 200;

export class KeyLightDevice extends ElgatoDevice {
  protected override createEndpoint(context: DeviceContext): MatterbridgeEndpoint {
    return (
      new MatterbridgeEndpoint(
        [colorTemperatureLight, bridgedNode, powerSource],
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
        // matterbridge's default physical minimum is 147 mireds, warmer than the
        // Elgato's real 143. Pass the range explicitly or lose the coolest end.
        .createCtColorControlClusterServer(DEFAULT_MIREDS, MIN_MIREDS, MAX_MIREDS)
        .createDefaultPowerSourceWiredClusterServer()
        .addRequiredClusterServers()
    );
  }

  protected override registerHandlers(): void {
    this.endpoint
      .addCommandHandler("identify", ({ request }) => {
        this.log.info(`${this.deviceName}: identify for ${request.identifyTime}s`);
      })
      .addCommandHandler("on", async () => {
        await this.write({ on: 1 }, ["onOff"]);
      })
      .addCommandHandler("off", async () => {
        await this.write({ on: 0 }, ["onOff"]);
      })
      .addCommandHandler("moveToLevel", async ({ request }) => {
        await this.write({ brightness: toElgatoBrightness(request.level) }, ["level"]);
      })
      .addCommandHandler("moveToLevelWithOnOff", async ({ request }) => {
        // matter.js crops the level to minLevel 1 and couples OnOff to false there, so
        // level 1 or below means off, not "dim to 3 %" as the naive mapping would send.
        // Above that, power on and set the brightness in one body.
        if (request.level <= MIN_LEVEL) {
          await this.write({ on: 0 }, ["level", "onOff"]);
          return;
        }
        await this.write({ on: 1, brightness: toElgatoBrightness(request.level) }, [
          "level",
          "onOff",
        ]);
      })
      .addCommandHandler("moveToColorTemperature", async ({ request }) => {
        await this.write({ temperature: toElgatoTemperature(request.colorTemperatureMireds) }, [
          "ct",
        ]);
      });
  }

  protected override async applyState(
    light: LightState,
    options: ApplyOptions = {},
  ): Promise<void> {
    const skip = options.skip ?? [];
    const push = this.attributeWriter(options.seed);

    if (!skip.includes("onOff")) await push(OnOff.id, "onOff", light.on === 1, this.log);
    if (light.brightness !== undefined && !skip.includes("level")) {
      await push(LevelControl.id, "currentLevel", toMatterLevel(light.brightness), this.log);
    }
    if (light.temperature !== undefined && !skip.includes("ct")) {
      await push(
        ColorControl.id,
        "colorTemperatureMireds",
        toMatterMireds(light.temperature),
        this.log,
      );
    }
  }
}
