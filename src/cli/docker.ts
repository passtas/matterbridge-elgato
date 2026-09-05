/**
 * Docker preflight and the compose-variant dance.
 *
 * Hosts in the wild have either the `docker compose` plugin (v2+) or the
 * standalone `docker-compose` binary, and occasionally neither. So the CLI
 * probes for all three and falls back to plain `docker run`.
 */

import { spawnSync } from "node:child_process";

import { SERVICE_NAME } from "./compose.ts";

export type RunResult = { status: number; stdout: string; stderr: string };

export type Runner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
) => RunResult;

export const spawnRunner: Runner = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options?.cwd,
    encoding: "utf8",
    // Compose logs of a busy bridge can be large; 32 MB is plenty and bounded.
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
};

export type ComposeVariant =
  /** `docker compose ...` */
  | { kind: "plugin"; command: "docker"; prefix: readonly string[] }
  /** `docker-compose ...` */
  | { kind: "standalone"; command: "docker-compose"; prefix: readonly string[] }
  /** Neither is installed; the CLI drives `docker run` directly. */
  | { kind: "none"; command: "docker"; prefix: readonly string[] };

export function detectCompose(run: Runner): ComposeVariant {
  if (run("docker", ["compose", "version"]).status === 0) {
    return { kind: "plugin", command: "docker", prefix: ["compose"] };
  }
  if (run("docker-compose", ["--version"]).status === 0) {
    return { kind: "standalone", command: "docker-compose", prefix: [] };
  }
  return { kind: "none", command: "docker", prefix: [] };
}

export function describeCompose(variant: ComposeVariant): string {
  switch (variant.kind) {
    case "plugin":
      return "docker compose (CLI plugin)";
    case "standalone":
      return "docker-compose (standalone binary)";
    case "none":
      return "none, falling back to plain docker run";
  }
}

export type DockerCheck = { ok: boolean; message: string };

export function checkDocker(run: Runner): DockerCheck {
  const version = run("docker", ["--version"]);
  if (version.status !== 0) {
    return {
      ok: false,
      message:
        "Docker is not installed (or not on PATH). Install Docker Engine: https://docs.docker.com/engine/install/",
    };
  }
  const info = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) {
    return {
      ok: false,
      message:
        "Docker is installed but the daemon is not reachable. Start it (`sudo systemctl start docker`) or add your user to the `docker` group.",
    };
  }
  return { ok: true, message: `Docker ${info.stdout.trim() || "(unknown version)"}` };
}

/**
 * macOS and Windows run Docker inside a VM, so `network_mode: host` does not
 * reach the LAN and Matter commissioning cannot work. There is no workaround
 * worth shipping. The honest answer is "run this on a Linux box".
 */
export const NON_LINUX_MESSAGE =
  "Matter and mDNS need host networking, which Docker Desktop on macOS and Windows does not provide.\n" +
  "This needs a Linux Docker host (home server, NAS, Raspberry Pi). Re-run there, or pass --yes to write the\n" +
  "files here and copy them over. --yes never starts the stack on macOS or Windows, because it could not pair.";

export function isSupportedPlatform(platform: string): boolean {
  return platform === "linux";
}

/** `compose up -d`, or the equivalent `docker run` when there is no compose. */
export function upArgs(variant: ComposeVariant): string[] {
  if (variant.kind === "none") return [];
  return [...variant.prefix, "up", "-d"];
}

export function psArgs(variant: ComposeVariant): string[] {
  if (variant.kind === "none") {
    return ["ps", "--filter", `name=^/${SERVICE_NAME}$`];
  }
  return [...variant.prefix, "ps"];
}

export function logsArgs(variant: ComposeVariant, extra: readonly string[] = []): string[] {
  if (variant.kind === "none") return ["logs", ...extra, SERVICE_NAME];
  return [...variant.prefix, "logs", ...extra];
}

/**
 * The `docker run` that stands in for the compose file when no compose binary
 * exists. Kept equivalent to `renderCompose()` on purpose.
 */
export function dockerRunArgs(options: {
  image: string;
  interfaceName: string;
  frontendPort: number;
  timezone: string;
  dir: string;
}): string[] {
  return [
    "run",
    "-d",
    "--name",
    SERVICE_NAME,
    "--network",
    "host",
    "--restart",
    "unless-stopped",
    "--stop-timeout",
    "60",
    "-e",
    `MDNS_INTERFACE=${options.interfaceName}`,
    "-e",
    `FRONTEND_PORT=${options.frontendPort}`,
    "-e",
    `TZ=${options.timezone}`,
    "-v",
    `${options.dir}/data/.matterbridge:/root/.matterbridge`,
    "-v",
    `${options.dir}/data/Matterbridge:/root/Matterbridge`,
    "-v",
    `${options.dir}/data/.mattercert:/root/.mattercert`,
    options.image,
  ];
}
