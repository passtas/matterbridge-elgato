/**
 * Argument parsing for `matterbridge-elgato`. Hand-rolled: the CLI must run from
 * `npx` on a machine that has nothing but Node and Docker, so it uses node
 * built-ins only and takes no runtime dependencies.
 */

export const DEFAULT_IMAGE = "ghcr.io/passtas/matterbridge-elgato:latest";
export const DEFAULT_DIR = "matterbridge-elgato";
export const DEFAULT_FRONTEND_PORT = 8283;
/** Matterbridge takes a while to come up, publish mDNS and print the QR. */
export const DEFAULT_WAIT_MS = 90_000;

export type Command = "setup" | "status" | "logs" | "help" | "version";

export type CliOptions = {
  command: Command;
  dir: string;
  interfaceName: string | undefined;
  image: string;
  frontendPort: number;
  yes: boolean;
  start: boolean;
  json: boolean;
  /** Extra arguments handed straight to `compose logs` / `docker logs`. */
  passthrough: string[];
};

/** `erasableSyntaxOnly` rules out class fields, so this is a tagged plain Error. */
export type CliError = Error & { name: "CliError"; code: number };

export function cliError(message: string, code = 1): CliError {
  const error = new Error(message) as CliError;
  error.name = "CliError";
  error.code = code;
  return error;
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof Error && error.name === "CliError";
}

const COMMANDS: readonly string[] = ["setup", "status", "logs", "help", "version"];

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("-")) {
    throw cliError(`${flag} needs a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    dir: DEFAULT_DIR,
    interfaceName: undefined,
    image: DEFAULT_IMAGE,
    frontendPort: DEFAULT_FRONTEND_PORT,
    yes: false,
    start: true,
    json: false,
    passthrough: [],
  };

  let commandSeen = false;
  const rest = [...argv];

  while (rest.length > 0) {
    const token = rest.shift() as string;

    // `--flag=value` is normalized to `--flag value` before dispatch.
    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 2) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    const take = (): string => requireValue(flag, inline ?? rest.shift());

    switch (flag) {
      case "-h":
      case "--help":
        options.command = "help";
        return options;
      case "-v":
      case "--version":
        options.command = "version";
        return options;
      case "--dir":
      case "-d":
        options.dir = take();
        break;
      case "--interface":
      case "-i":
        options.interfaceName = take();
        break;
      case "--image":
        options.image = take();
        break;
      case "--frontend-port": {
        const raw = take();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw cliError(`--frontend-port must be a port number, got "${raw}"`);
        }
        options.frontendPort = port;
        break;
      }
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--no-start":
        options.start = false;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (!commandSeen && COMMANDS.includes(token)) {
          options.command = token as Command;
          commandSeen = true;
          break;
        }
        // `logs` forwards anything it does not understand (-f, --tail 50, ...).
        if (options.command === "logs") {
          options.passthrough.push(token);
          break;
        }
        throw cliError(`Unknown argument "${token}". Run with --help.`);
    }
  }

  return options;
}

export const HELP_TEXT = `matterbridge-elgato: Elgato lights in Google Home, Apple Home and Alexa, over Matter.

Usage:
  npx matterbridge-elgato@latest setup [options]
  npx matterbridge-elgato@latest status [--dir <path>] [--json]
  npx matterbridge-elgato@latest logs   [--dir <path>] [<docker logs args>]

Commands:
  setup     Write a Docker Compose stack, start it and print the pairing code.
  status    Show whether the stack is running, plus the last pairing code.
  logs      Tail the container logs.

Options:
  -d, --dir <path>        Where to keep the stack and its data (default: ./${DEFAULT_DIR})
  -i, --interface <nic>   LAN network interface for mDNS (default: auto-detected)
      --image <ref>       Container image (default: ${DEFAULT_IMAGE})
      --frontend-port <n> Matterbridge web frontend port (default: ${DEFAULT_FRONTEND_PORT})
  -y, --yes               Never prompt; accept the auto-detected answers
      --no-start          Write the files but do not start the stack
      --json              Print a machine-readable summary (for scripts and agents)
  -h, --help              Show this help
  -v, --version           Show the version

Requirements:
  A Linux host with Docker. Matter and mDNS need host networking, which Docker
  Desktop on macOS and Windows cannot provide. Use a home server, a NAS or a
  Raspberry Pi.`;
