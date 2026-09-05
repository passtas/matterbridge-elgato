/**
 * Plugin entry point. Matterbridge calls the default export with
 * `(getPlatformMatterbridge(), log, config)` and refuses to load a plugin without it.
 */

import type { PlatformConfig, PlatformMatterbridge } from "matterbridge";
import type { AnsiLogger } from "matterbridge/logger";

import { ElgatoPlatform } from "./platform.ts";

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PlatformConfig,
): ElgatoPlatform {
  return new ElgatoPlatform(matterbridge, log, config);
}

export { ElgatoPlatform } from "./platform.ts";
export type { ManualDevice } from "./config.ts";
