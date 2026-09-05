/**
 * The plugin's slice of matterbridge's per-plugin storage
 * (`~/.matterbridge/matterbridge-elgato`). Two things live there:
 *
 * - the first display name ever seen for a serial, because that name is what pins the
 *   Matter `uniqueId` across restarts (docs/matterbridge-api-cheatsheet.md §3);
 * - the last scene seen on a Light Strip, so an off/on cycle can put it back.
 *
 * Storage errors are logged at debug and otherwise ignored. Losing this costs a
 * remembered name or a scene, never a device.
 */

import type { AnsiLogger } from "matterbridge/logger";

import type { SceneLightState } from "./elgato/types.ts";

const NAMES_KEY = "deviceNames";
const SCENES_KEY = "scenes";

/** The part of matterbridge's `NodeStorage` this plugin uses. */
export interface StorageContext {
  get<T>(key: string, defaultValue?: T): Promise<T>;
  set<T>(key: string, value: T): Promise<unknown>;
}

export class PluginStorage {
  readonly #log: AnsiLogger;
  /** Read lazily: matterbridge assigns `platform.context` after the constructor runs. */
  readonly #context: () => StorageContext | undefined;
  #names = new Map<string, string>();
  #scenes = new Map<string, SceneLightState>();

  constructor(log: AnsiLogger, context: () => StorageContext | undefined) {
    this.#log = log;
    this.#context = context;
  }

  /** Load both maps from disk. Call once, at the start of `onStart`. */
  async load(): Promise<void> {
    this.#names = await this.#read(NAMES_KEY);
    this.#scenes = await this.#read(SCENES_KEY);
  }

  nameOf(serial: string): string | undefined {
    return this.#names.get(serial);
  }

  async rememberName(serial: string, deviceName: string): Promise<void> {
    if (this.#names.get(serial) === deviceName) return;
    this.#names.set(serial, deviceName);
    await this.#write(NAMES_KEY, this.#names);
  }

  sceneOf(serial: string): SceneLightState | undefined {
    return this.#scenes.get(serial);
  }

  rememberScene(serial: string, scene: SceneLightState): void {
    this.#scenes.set(serial, scene);
    void this.#write(SCENES_KEY, this.#scenes);
  }

  async #read<T>(key: string): Promise<Map<string, T>> {
    try {
      const stored = await this.#context()?.get<Record<string, T>>(key, {});
      return new Map(Object.entries(stored ?? {}));
    } catch (error) {
      this.#log.debug(`Could not read ${key} from plugin storage: ${(error as Error).message}`);
      return new Map();
    }
  }

  async #write<T>(key: string, values: Map<string, T>): Promise<void> {
    try {
      await this.#context()?.set(key, Object.fromEntries(values));
    } catch (error) {
      this.#log.debug(`Could not save ${key} to plugin storage: ${(error as Error).message}`);
    }
  }
}
