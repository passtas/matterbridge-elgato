#!/usr/bin/env node
/**
 * The one-step install: `npx matterbridge-elgato@latest setup`.
 *
 * Kept to a thin shell around `runCli()` so that everything except
 * `process.exit` is testable. Node built-ins only: this runs on a machine that
 * has Node and Docker and nothing else.
 */

import { defaultDeps, runCli } from "./run.ts";

const code = await runCli(process.argv.slice(2), defaultDeps());
process.exitCode = code;
