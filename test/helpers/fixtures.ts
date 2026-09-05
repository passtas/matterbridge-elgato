import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LightsResponse, LightState } from "../../src/elgato/types.ts";

/** Load one of the live captures in test/fixtures. */
export const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url)), "utf8"),
  ) as T;

export const light = (name: string): LightState => {
  const state = fixture<LightsResponse>(name).lights[0];
  if (!state) throw new Error(`fixture ${name} has no lights[0]`);
  return state;
};
