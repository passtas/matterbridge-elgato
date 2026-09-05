/**
 * End-to-end check of `matterbridge-elgato setup` against the real image.
 *
 * Opt-in (`ELGATO_DOCKER_E2E=1 npm test`): it needs Docker, a compose binary and
 * a locally built `matterbridge-elgato:dev`, so CI skips it.
 *
 * The generated stack asks for `network_mode: host`, which is mandatory in
 * production but would collide with any Matterbridge already on the host. So the
 * test does what the brief prescribes: run `setup --no-start`, rewrite the one
 * line that makes it host-networked into a published port, start it itself, and
 * assert that the CLI's own log watcher finds the pairing code in the real logs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectCompose, logsArgs, spawnRunner } from "../src/cli/docker.ts";
import { isPairingComplete, stripAnsi, waitForPairing } from "../src/cli/logWatch.ts";
import { bufferWriter } from "../src/cli/output.ts";
import { defaultDeps, runCli } from "../src/cli/run.ts";

const IMAGE = "matterbridge-elgato:dev";
const FRONTEND_PORT = 28283;
const ENABLED = process.env["ELGATO_DOCKER_E2E"] === "1";

const suite = ENABLED ? describe : describe.skip;

suite("setup against the real image", () => {
  let directory = "";
  const variant = ENABLED
    ? detectCompose(spawnRunner)
    : ({ kind: "none", command: "docker", prefix: [] } as const);

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "mbe-e2e-"));
  });

  afterAll(() => {
    if (!directory) return;
    spawnRunner(variant.command, [...variant.prefix, "down", "-v", "-t", "5"], { cwd: directory });
    // Matterbridge runs as root in the container, so ./data ends up root-owned;
    // delete it from inside a throwaway container rather than needing sudo here.
    spawnRunner("docker", [
      "run",
      "--rm",
      "-v",
      `${directory}:/target`,
      "--entrypoint",
      "/bin/sh",
      IMAGE,
      "-c",
      "rm -rf /target/data",
    ]);
    rmSync(directory, { recursive: true, force: true });
  });

  it("writes a stack, starts it, and the log watcher finds the pairing code", async () => {
    // 1. The CLI writes the files (and nothing else) with --no-start.
    const deps = { ...defaultDeps(), writer: bufferWriter() };
    const code = await runCli(
      [
        "setup",
        "--dir",
        directory,
        "--image",
        IMAGE,
        "--frontend-port",
        String(FRONTEND_PORT),
        "--no-start",
        "--yes",
      ],
      deps,
    );
    expect(code).toBe(0);

    const composeFile = join(directory, "docker-compose.yml");
    const generated = readFileSync(composeFile, "utf8");
    expect(generated).toContain("network_mode: host");
    expect(generated).toContain(`image: ${IMAGE}`);

    // 2. Seed the plugin config so the run needs no LAN discovery at all.
    writeFileSync(
      join(directory, "data", ".matterbridge", "matterbridge-elgato.config.json"),
      JSON.stringify(
        {
          name: "matterbridge-elgato",
          type: "DynamicPlatform",
          enableMdns: false,
          devices: [],
          whiteList: [],
          blackList: [],
          debug: false,
          unregisterOnShutdown: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    // 3. Swap host networking for a published port so nothing on the host moves,
    //    and with it the interface name, which is eth0 inside a bridged container.
    writeFileSync(
      composeFile,
      generated
        .replace(
          "    network_mode: host\n",
          `    ports:\n      - "${FRONTEND_PORT}:${FRONTEND_PORT}"\n`,
        )
        .replace(/MDNS_INTERFACE: .*/, "MDNS_INTERFACE: eth0"),
      "utf8",
    );

    // 4. Start it ourselves.
    execFileSync(variant.command, [...variant.prefix, "up", "-d"], {
      cwd: directory,
      encoding: "utf8",
    });

    // 5. The production code path: poll the real logs until the code shows up.
    const result = await waitForPairing({
      readLogs: () => {
        const logs = spawnRunner(variant.command, logsArgs(variant, ["--tail", "500"]), {
          cwd: directory,
        });
        return `${logs.stdout}\n${logs.stderr}`;
      },
      timeoutMs: 120_000,
      pollMs: 2000,
    });

    expect(result.timedOut).toBe(false);
    expect(isPairingComplete(result.info)).toBe(true);
    expect(result.info.manualPairingCode).toMatch(/^\d{11}$/);
    expect(result.info.qrUrl).toMatch(/qrcode\.html\?data=MT:/);

    // 6. The entrypoint auto-registered the plugin on this fresh data directory.
    const logs = spawnRunner(variant.command, logsArgs(variant, ["--tail", "1000"]), {
      cwd: directory,
    });
    // These are Matterbridge's own lines, so the assertions do not depend on the
    // exact wording of the entrypoint script.
    const text = stripAnsi(logs.stdout + logs.stderr);
    expect(text).toContain("Added plugin matterbridge-elgato");
    expect(text).toContain("Using mdnsinterface eth0");
    expect(text).toContain(`:${FRONTEND_PORT}`);

    // 7. `status` sees the same thing.
    const statusDeps = { ...defaultDeps(), writer: bufferWriter() };
    expect(await runCli(["status", "--dir", directory, "--json"], statusDeps)).toBe(0);
    expect(JSON.parse(statusDeps.writer.lines.join("\n"))).toMatchObject({
      running: true,
      manualPairingCode: result.info.manualPairingCode,
    });
  }, 240_000);
});
