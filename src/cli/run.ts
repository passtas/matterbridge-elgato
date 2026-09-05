/**
 * The `matterbridge-elgato` commands themselves.
 *
 * Everything the CLI touches from the outside world arrives as `CliDeps`: the
 * writer, the process runner, the platform string, the interface list, the
 * prompt, the clock. That way the whole flow can be exercised from tests
 * without mocking node built-ins.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  cliError,
  DEFAULT_WAIT_MS,
  HELP_TEXT,
  isCliError,
  parseArgs,
  type CliOptions,
} from "./args.ts";
import {
  DATA_DIRECTORIES,
  hostTimezone,
  renderCompose,
  SERVICE_NAME,
  type ComposeOptions,
} from "./compose.ts";
import {
  checkDocker,
  describeCompose,
  detectCompose,
  dockerRunArgs,
  isSupportedPlatform,
  logsArgs,
  NON_LINUX_MESSAGE,
  psArgs,
  spawnRunner,
  upArgs,
  type ComposeVariant,
  type Runner,
} from "./docker.ts";
import {
  chooseInterface,
  listAddressableInterfaces,
  listCandidates,
  parseDefaultRouteInterface,
  type InterfaceCandidate,
  type InterfacePick,
} from "./interfaces.ts";
import { scanLogs, waitForPairing, type PairingInfo } from "./logWatch.ts";
import { processWriter, type Writer } from "./output.ts";

/**
 * Read from package.json rather than duplicated here; the path works both from
 * `src/cli/` in the repo and from `dist/cli/` in the published package.
 */
export function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "..", "package.json"), "utf8");
    const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export type CliDeps = {
  writer: Writer;
  run: Runner;
  /** Runs a command with the parent's stdio, for `logs -f`. Returns the exit code. */
  runAttached: (command: string, args: readonly string[], cwd: string) => number;
  platform: string;
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Resolves to the user's answer; "" means "take the default". */
  prompt: (question: string) => Promise<string>;
  cwd: string;
  timezone: string;
  waitMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
};

async function promptOnTty(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function defaultDeps(): CliDeps {
  return {
    writer: processWriter,
    run: spawnRunner,
    runAttached: (command, args, cwd) =>
      spawnSync(command, [...args], { cwd, stdio: "inherit" }).status ?? 1,
    platform: process.platform,
    networkInterfaces,
    prompt: promptOnTty,
    cwd: process.cwd(),
    timezone: hostTimezone(),
    waitMs: DEFAULT_WAIT_MS,
    pollMs: 2000,
  };
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    deps.writer.err(isCliError(error) ? error.message : String(error));
    return 2;
  }

  try {
    switch (options.command) {
      case "help":
        deps.writer.out(HELP_TEXT);
        return 0;
      case "version":
        deps.writer.out(readVersion());
        return 0;
      case "setup":
        return await commandSetup(options, deps);
      case "status":
        return commandStatus(options, deps);
      case "logs":
        return commandLogs(options, deps);
    }
  } catch (error) {
    const message = isCliError(error) ? error.message : String(error);
    if (options.json) {
      deps.writer.out(
        JSON.stringify({ ok: false, command: options.command, error: message }, null, 2),
      );
    } else {
      deps.writer.err(`✗ ${message}`);
    }
    return isCliError(error) ? error.code : 1;
  }
}

/* ------------------------------------------------------------------ setup */

export type SetupSummary = {
  ok: boolean;
  command: "setup";
  directory: string;
  composeFile: string;
  image: string;
  interface: InterfacePick;
  compose: { kind: ComposeVariant["kind"]; description: string; upCommand: string };
  started: boolean;
  /** Why the stack was not started, or null when it was. */
  reason: string | null;
  frontendUrl: string;
  /** null rather than undefined so the keys always exist in --json output. */
  qrUrl: string | null;
  manualPairingCode: string | null;
  commissioned: boolean;
  nextSteps: string[];
};

export const NEXT_STEPS = [
  "Google Home: tap +, then Set up device, Works with Google Home, Matter device. Scan the QR or type the code.",
  "Apple Home: tap +, then Add Accessory, then More options (or My device is not shown). Type the code.",
  "Alexa: Devices, then +, then Add Device, then Other, then Matter. Type the code.",
  "All three can be added at once, because Matter allows multiple admins.",
];

async function commandSetup(options: CliOptions, deps: CliDeps): Promise<number> {
  const quiet = options.json;
  const say = (line: string): void => {
    if (!quiet) deps.writer.out(line);
  };

  const directory = resolveDir(options.dir, deps.cwd);

  say("matterbridge-elgato setup");
  say("");

  // 1. Host checks. Without Docker nothing can start, but when nothing is going
  //    to start, the files are still worth writing so they can be copied to a
  //    real host.
  //
  // On macOS and Windows the stack can be written but never usefully started:
  // host networking inside Docker Desktop's VM cannot reach the LAN, so a
  // container started here would never pair. --yes lets the files be written,
  // it does not make the platform work.
  let start = options.start;
  let reason: string | null = options.start ? null : "--no-start was given";
  if (!isSupportedPlatform(deps.platform)) {
    if (!options.yes) throw cliError(NON_LINUX_MESSAGE);
    say(`! ${NON_LINUX_MESSAGE}`);
    if (start) say("! Writing the files only. Copy them to a Linux host and start them there.");
    start = false;
    reason = `the host platform is ${deps.platform}, not linux`;
  }

  const docker = checkDocker(deps.run);
  if (docker.ok) {
    say(`✓ ${docker.message}`);
  } else if (start) {
    throw cliError(docker.message);
  } else {
    say(`! ${docker.message}`);
  }

  const variant = detectCompose(deps.run);
  const upCommand = [variant.command, ...variant.prefix, "up", "-d"].join(" ");
  say(`✓ Compose: ${describeCompose(variant)}`);

  // 2. The LAN interface.
  const pick = await pickInterface(options, deps, say);
  say(`✓ Network interface: ${pick.name} (${pick.address}), because ${pick.reason}`);

  // 3. Files.
  const composeOptions: ComposeOptions = {
    image: options.image,
    interfaceName: pick.name,
    frontendPort: options.frontendPort,
    timezone: deps.timezone,
  };
  const composeFile = join(directory, "docker-compose.yml");
  mkdirSync(directory, { recursive: true });
  for (const name of DATA_DIRECTORIES) {
    mkdirSync(join(directory, "data", name), { recursive: true });
  }
  writeFileSync(composeFile, renderCompose(composeOptions), "utf8");
  say(`✓ Wrote ${composeFile}`);
  say(`✓ Data directory ${join(directory, "data")}`);

  const frontendUrl = `http://${pick.address}:${options.frontendPort}`;
  let pairing: PairingInfo = {
    manualPairingCode: undefined,
    qrUrl: undefined,
    commissioned: false,
  };

  // 4. Start, then watch the log for the pairing code.
  if (start) {
    say("");
    say(`Starting ${SERVICE_NAME} (this pulls the image on first run)…`);
    startStack(variant, composeOptions, directory, deps);
    say(`Waiting up to ${Math.round(deps.waitMs / 1000)}s for the pairing code…`);
    const result = await waitForPairing({
      readLogs: () => readLogs(variant, directory, deps),
      timeoutMs: deps.waitMs,
      pollMs: deps.pollMs,
      sleep: deps.sleep,
    });
    pairing = result.info;
    if (result.timedOut) {
      say(
        "! Timed out waiting for the pairing code. The stack is running; check `matterbridge-elgato logs`.",
      );
    }
  }

  const summary: SetupSummary = {
    ok: true,
    command: "setup",
    directory,
    composeFile,
    image: options.image,
    interface: pick,
    compose: { kind: variant.kind, description: describeCompose(variant), upCommand },
    started: start,
    reason,
    frontendUrl,
    qrUrl: pairing.qrUrl ?? null,
    manualPairingCode: pairing.manualPairingCode ?? null,
    commissioned: pairing.commissioned,
    nextSteps: NEXT_STEPS,
  };

  if (quiet) {
    deps.writer.out(JSON.stringify(summary, null, 2));
    return 0;
  }

  say("");
  say(`Matterbridge frontend:  ${frontendUrl}`);
  say(`                        http://localhost:${options.frontendPort} (from this machine)`);
  if (pairing.commissioned) {
    say("This bridge is already commissioned. No pairing code needed.");
  } else {
    if (pairing.qrUrl) say(`QR code:                ${pairing.qrUrl}`);
    if (pairing.manualPairingCode) say(`Manual pairing code:    ${pairing.manualPairingCode}`);
  }
  if (!start) {
    say("");
    say(`Not started, because ${reason}. Start it with:  cd ${directory} && ${upCommand}`);
  }
  say("");
  say("Next steps:");
  for (const step of NEXT_STEPS) say(`  • ${step}`);
  return 0;
}

/* ----------------------------------------------------------------- status */

function commandStatus(options: CliOptions, deps: CliDeps): number {
  const directory = resolveDir(options.dir, deps.cwd);
  const variant = detectCompose(deps.run);
  const ps = deps.run(variant.command, psArgs(variant), { cwd: directory });
  const pairing = scanLogs(readLogs(variant, directory, deps));
  const running = ps.status === 0 && ps.stdout.includes(SERVICE_NAME);

  if (options.json) {
    deps.writer.out(
      JSON.stringify(
        {
          ok: ps.status === 0,
          command: "status",
          directory,
          running,
          manualPairingCode: pairing.manualPairingCode ?? null,
          qrUrl: pairing.qrUrl ?? null,
          commissioned: pairing.commissioned,
        },
        null,
        2,
      ),
    );
    return ps.status === 0 ? 0 : 1;
  }

  deps.writer.out(ps.stdout.trim() || ps.stderr.trim() || "(no containers)");
  if (pairing.commissioned) {
    deps.writer.out("Commissioned: yes");
  } else if (pairing.manualPairingCode) {
    deps.writer.out(`Manual pairing code: ${pairing.manualPairingCode}`);
    if (pairing.qrUrl) deps.writer.out(`QR code: ${pairing.qrUrl}`);
  }
  return ps.status === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------- logs */

function commandLogs(options: CliOptions, deps: CliDeps): number {
  const directory = resolveDir(options.dir, deps.cwd);
  const variant = detectCompose(deps.run);
  return deps.runAttached(variant.command, logsArgs(variant, options.passthrough), directory);
}

/* ----------------------------------------------------------------- shared */

export function resolveDir(dir: string, cwd: string): string {
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

async function pickInterface(
  options: CliOptions,
  deps: CliDeps,
  say: (line: string) => void,
): Promise<InterfacePick> {
  const interfaces = deps.networkInterfaces();

  if (options.interfaceName) {
    // Checked against every addressable interface, not just the candidates, so
    // an explicit docker bridge is allowed but a typo is not.
    const addressable = listAddressableInterfaces(interfaces);
    const named = addressable.find((entry) => entry.name === options.interfaceName);
    if (!named) {
      const known = addressable.map((entry) => `${entry.name} (${entry.address})`).join(", ");
      throw cliError(
        `This host has no interface named "${options.interfaceName}" with an IPv4 address. ` +
          (known === "" ? "It has none at all." : `It has: ${known}.`),
      );
    }
    return { name: named.name, address: named.address, reason: "you passed --interface" };
  }

  // `ip route show default` is Linux-only and may be absent; treat any failure
  // as "no default route known" rather than an error.
  const candidates = listCandidates(interfaces);
  const route = deps.run("ip", ["route", "show", "default"]);
  const defaultRoute = route.status === 0 ? parseDefaultRouteInterface(route.stdout) : undefined;
  const choice = chooseInterface(candidates, defaultRoute);

  if (choice.kind === "none") {
    throw cliError(
      "No LAN network interface found (only loopback, docker bridges and VPNs). Pass --interface <nic> explicitly.",
    );
  }
  if (choice.kind === "picked") return choice.pick;

  if (options.yes) {
    const first = choice.candidates[0] as InterfaceCandidate;
    return {
      name: first.name,
      address: first.address,
      reason:
        "you passed --yes and no interface holds the default route; this is the first candidate",
    };
  }

  say("Several interfaces could be the LAN one:");
  for (const [index, candidate] of choice.candidates.entries()) {
    say(`  ${index + 1}) ${candidate.name}  ${candidate.address}`);
  }
  const answer = (await deps.prompt("Which one faces your LAN? [1] ")).trim();
  const index = answer === "" ? 0 : Number(answer) - 1;
  const chosen = choice.candidates[index];
  if (!chosen) throw cliError(`"${answer}" is not one of the listed interfaces.`);
  return { name: chosen.name, address: chosen.address, reason: "you chose it from the list" };
}

function startStack(
  variant: ComposeVariant,
  composeOptions: ComposeOptions,
  directory: string,
  deps: CliDeps,
): void {
  const args =
    variant.kind === "none"
      ? dockerRunArgs({ ...composeOptions, dir: directory })
      : upArgs(variant);
  const result = deps.run(variant.command, args, { cwd: directory });
  if (result.status !== 0) {
    throw cliError(`Failed to start the stack:\n${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function readLogs(variant: ComposeVariant, directory: string, deps: CliDeps): string {
  const result = deps.run(variant.command, logsArgs(variant, ["--tail", "500"]), {
    cwd: directory,
  });
  return `${result.stdout}\n${result.stderr}`;
}
