import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DIR,
  DEFAULT_FRONTEND_PORT,
  DEFAULT_IMAGE,
  isCliError,
  parseArgs,
} from "../src/cli/args.ts";
import { DATA_DIRECTORIES, hostTimezone, renderCompose } from "../src/cli/compose.ts";
import {
  checkDocker,
  describeCompose,
  detectCompose,
  dockerRunArgs,
  isSupportedPlatform,
  logsArgs,
  psArgs,
  spawnRunner,
  upArgs,
  type RunResult,
  type Runner,
} from "../src/cli/docker.ts";
import {
  chooseInterface,
  listCandidates,
  parseDefaultRouteInterface,
} from "../src/cli/interfaces.ts";
import { isPairingComplete, scanLogs, stripAnsi, waitForPairing } from "../src/cli/logWatch.ts";
import { bufferWriter, processWriter } from "../src/cli/output.ts";
import { defaultDeps, readVersion, resolveDir, runCli, type CliDeps } from "../src/cli/run.ts";

/* ------------------------------------------------------------------ fixtures */

const ESC = String.fromCharCode(27);

/** The shape of a real fresh-volume run (Matterbridge 3.10.8), with made-up values. */
const REAL_LOG = [
  `${ESC}[0m${ESC}[38;5;245m[11:09:12.932] ${ESC}[38;5;115m[Matterbridge]${ESC}[0m Matterbridge is starting...${ESC}[K`,
  "[11:09:15.179] [matterbridge-elgato] Registered Elgato Key Light Air (CW33J1A00001) at 192.168.1.50",
  "[11:09:15.977] [Commissioning] Matterbridge is uncommissioned passcode: 20202021 discriminator: 3840 manual pairing code: 05671110155",
  "  QR code URL: https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT:Y.K90Q1212JLFX5DD00",
  "[11:09:15.977] [Matterbridge] QR Code URL: https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT:Y.K90Q1212JLFX5DD00",
  "[11:09:15.977] [Matterbridge] Manual pairing code 05671110155 discriminator 3840 short discriminator 15 passcode 20202021",
].join("\n");

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): RunResult => ({ status: 1, stdout: "", stderr });

/** A Runner driven by a table of `"<command> <args…>"` prefixes. */
function stubRunner(
  table: Record<string, RunResult>,
  fallback: RunResult = fail("not stubbed"),
): {
  run: Runner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: Runner = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    for (const [prefix, result] of Object.entries(table)) {
      if (line.startsWith(prefix)) return result;
    }
    return fallback;
  };
  return { run, calls };
}

/** Default deps with an in-memory writer, so tests can assert on the output. */
function deps(
  overrides: Partial<Omit<CliDeps, "writer">> = {},
): CliDeps & { writer: ReturnType<typeof bufferWriter> } {
  return {
    run: stubRunner({}).run,
    runAttached: () => 0,
    platform: "linux",
    networkInterfaces: () => ({}),
    prompt: async () => "",
    cwd: process.cwd(),
    timezone: "Europe/London",
    waitMs: 0,
    pollMs: 0,
    sleep: async () => {},
    ...overrides,
    writer: bufferWriter(),
  };
}

const ipv4 = (address: string, name = "eth0"): NetworkInterfaceInfo =>
  ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: name === "lo",
    cidr: `${address}/24`,
  }) as NetworkInterfaceInfo;

const ipv6 = (): NetworkInterfaceInfo =>
  ({
    address: "fe80::1",
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: "fe80::1/64",
    scopeid: 2,
  }) as NetworkInterfaceInfo;

const temporaryDirectories: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mbe-cli-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------- args */

describe("parseArgs", () => {
  it("defaults to help with no arguments", () => {
    const options = parseArgs([]);
    expect(options.command).toBe("help");
    expect(options.dir).toBe(DEFAULT_DIR);
    expect(options.image).toBe(DEFAULT_IMAGE);
    expect(options.frontendPort).toBe(DEFAULT_FRONTEND_PORT);
    expect(options.start).toBe(true);
    expect(options.json).toBe(false);
  });

  it("parses the setup flags in both --flag value and --flag=value form", () => {
    const options = parseArgs([
      "setup",
      "--dir",
      "/srv/mb",
      "--interface=eth1",
      "--image",
      "local:dev",
      "--frontend-port=28283",
      "--yes",
      "--no-start",
      "--json",
    ]);
    expect(options).toMatchObject({
      command: "setup",
      dir: "/srv/mb",
      interfaceName: "eth1",
      image: "local:dev",
      frontendPort: 28283,
      yes: true,
      start: false,
      json: true,
    });
  });

  it("accepts the short flags", () => {
    expect(parseArgs(["setup", "-d", "x", "-i", "eth9", "-y"])).toMatchObject({
      dir: "x",
      interfaceName: "eth9",
      yes: true,
    });
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["setup", "--help"]).command).toBe("help");
    expect(parseArgs(["-v"]).command).toBe("version");
  });

  it("forwards unknown arguments to logs, and rejects them elsewhere", () => {
    expect(parseArgs(["logs", "-f", "--tail", "20"]).passthrough).toEqual(["-f", "--tail", "20"]);
    expect(() => parseArgs(["setup", "--wat"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["nonsense"])).toThrow(/Unknown argument/);
  });

  it("validates values", () => {
    expect(() => parseArgs(["setup", "--frontend-port", "0"])).toThrow(/port number/);
    expect(() => parseArgs(["setup", "--frontend-port", "abc"])).toThrow(/port number/);
    expect(() => parseArgs(["setup", "--dir"])).toThrow(/needs a value/);
    expect(() => parseArgs(["setup", "--dir", "--json"])).toThrow(/needs a value/);
  });

  it("tags its errors so the entry point can report them", () => {
    try {
      parseArgs(["setup", "--wat"]);
      expect.unreachable();
    } catch (error) {
      expect(isCliError(error)).toBe(true);
    }
    expect(isCliError(new Error("plain"))).toBe(false);
  });
});

/* ---------------------------------------------------------------- interfaces */

describe("interface picking", () => {
  it("keeps only non-internal IPv4 interfaces that are not virtual", () => {
    const candidates = listCandidates({
      lo: [ipv4("127.0.0.1", "lo")],
      docker0: [ipv4("172.17.0.1", "docker0")],
      "br-7d7a2f5d990d": [ipv4("172.20.0.1", "br-x")],
      veth1a2b3c: [ipv4("10.9.9.9", "veth")],
      tailscale0: [ipv4("100.100.100.100", "tailscale0")],
      virbr0: [ipv4("192.168.122.1", "virbr0")],
      wg0: [ipv4("10.8.0.1", "wg0")],
      zt5u4: [ipv4("10.147.17.1", "zt")],
      enp3s0: [ipv6()],
      enx001a2b3c4d5e: [ipv6(), ipv4("192.168.1.20", "enx001a2b3c4d5e")],
      wlan0: [ipv4("192.168.1.60", "wlan0")],
      empty: undefined,
    });
    expect(candidates.map((candidate) => candidate.name)).toEqual(["enx001a2b3c4d5e", "wlan0"]);
    expect(candidates[0]?.address).toBe("192.168.1.20");
  });

  it("reads the interface out of `ip route show default`", () => {
    expect(
      parseDefaultRouteInterface(
        "default via 192.168.1.1 dev enx001a2b3c4d5e proto static metric 50 \n" +
          "default via 10.0.0.1 dev wlan0 proto dhcp metric 600 \n",
      ),
    ).toBe("enx001a2b3c4d5e");
    expect(parseDefaultRouteInterface("")).toBeUndefined();
    expect(parseDefaultRouteInterface("192.168.1.0/24 dev eth0 scope link")).toBeUndefined();
  });

  it("prefers the interface holding the default route", () => {
    const candidates = [
      { name: "wlan0", address: "192.168.1.60", netmask: "255.255.255.0" },
      { name: "enx001a2b3c4d5e", address: "192.168.1.20", netmask: "255.255.255.0" },
    ];
    const choice = chooseInterface(candidates, "enx001a2b3c4d5e");
    expect(choice).toEqual({
      kind: "picked",
      pick: {
        name: "enx001a2b3c4d5e",
        address: "192.168.1.20",
        reason: "it carries the host's default route",
      },
    });
  });

  it("takes a lone candidate, asks about several, and reports none", () => {
    const one = [{ name: "eth0", address: "10.0.0.5", netmask: "255.0.0.0" }];
    expect(chooseInterface(one, undefined)).toMatchObject({ kind: "picked" });
    expect(
      chooseInterface(
        [...one, { name: "eth1", address: "10.0.1.5", netmask: "255.0.0.0" }],
        "ppp0",
      ),
    ).toMatchObject({ kind: "ambiguous" });
    expect(chooseInterface([], undefined)).toEqual({ kind: "none" });
  });
});

/* ------------------------------------------------------------------- compose */

describe("compose rendering", () => {
  it("renders a host-network stack with the interface in the environment", () => {
    const yaml = renderCompose({
      image: "ghcr.io/passtas/matterbridge-elgato:latest",
      interfaceName: "enx001a2b3c4d5e",
      frontendPort: 8283,
      timezone: "Europe/London",
    });
    expect(yaml).toContain("image: ghcr.io/passtas/matterbridge-elgato:latest");
    expect(yaml).toContain("container_name: matterbridge-elgato");
    expect(yaml).toContain("network_mode: host");
    expect(yaml).toContain("restart: unless-stopped");
    expect(yaml).toContain("MDNS_INTERFACE: enx001a2b3c4d5e");
    expect(yaml).toContain('FRONTEND_PORT: "8283"');
    expect(yaml).toContain("TZ: Europe/London");
    for (const name of DATA_DIRECTORIES) {
      expect(yaml).toContain(`./data/${name}:/root/${name}`);
    }
  });

  it("reports a host timezone", () => {
    expect(hostTimezone()).toMatch(/^[A-Za-z]+(\/[A-Za-z_+\-0-9]+)*$/);
  });
});

/* -------------------------------------------------------------------- docker */

describe("docker preflight", () => {
  it("detects the compose plugin, the standalone binary, or neither", () => {
    expect(detectCompose(stubRunner({ "docker compose version": ok("v2.39") }).run).kind).toBe(
      "plugin",
    );
    expect(detectCompose(stubRunner({ "docker-compose --version": ok("v5.0.1") }).run).kind).toBe(
      "standalone",
    );
    expect(detectCompose(stubRunner({}).run).kind).toBe("none");
  });

  it("describes each variant", () => {
    expect(describeCompose({ kind: "plugin", command: "docker", prefix: ["compose"] })).toMatch(
      /plugin/,
    );
    expect(describeCompose({ kind: "standalone", command: "docker-compose", prefix: [] })).toMatch(
      /standalone/,
    );
    expect(describeCompose({ kind: "none", command: "docker", prefix: [] })).toMatch(/docker run/);
  });

  it("separates 'docker missing' from 'daemon unreachable'", () => {
    expect(checkDocker(stubRunner({}).run).message).toMatch(/not installed/);
    expect(
      checkDocker(stubRunner({ "docker --version": ok("Docker version 29.1.3") }).run).message,
    ).toMatch(/daemon is not reachable/);
    const healthy = checkDocker(
      stubRunner({
        "docker --version": ok("Docker version 29.1.3"),
        "docker info": ok("29.1.3\n"),
      }).run,
    );
    expect(healthy).toEqual({ ok: true, message: "Docker 29.1.3" });
  });

  it("only supports linux hosts", () => {
    expect(isSupportedPlatform("linux")).toBe(true);
    expect(isSupportedPlatform("darwin")).toBe(false);
    expect(isSupportedPlatform("win32")).toBe(false);
  });

  it("builds the right sub-commands per variant", () => {
    const plugin = { kind: "plugin", command: "docker", prefix: ["compose"] } as const;
    const none = { kind: "none", command: "docker", prefix: [] } as const;
    expect(upArgs(plugin)).toEqual(["compose", "up", "-d"]);
    expect(upArgs(none)).toEqual([]);
    expect(psArgs(plugin)).toEqual(["compose", "ps"]);
    expect(psArgs(none)).toContain("--filter");
    expect(logsArgs(plugin, ["--tail", "500"])).toEqual(["compose", "logs", "--tail", "500"]);
    expect(logsArgs(none, ["-f"])).toEqual(["logs", "-f", "matterbridge-elgato"]);
  });

  it("mirrors the compose file in the docker run fallback", () => {
    const args = dockerRunArgs({
      image: "img:tag",
      interfaceName: "eth0",
      frontendPort: 8283,
      timezone: "UTC",
      dir: "/srv/mb",
    });
    expect(args.join(" ")).toContain("--network host");
    expect(args.join(" ")).toContain("--restart unless-stopped");
    expect(args).toContain("MDNS_INTERFACE=eth0");
    expect(args).toContain("/srv/mb/data/.matterbridge:/root/.matterbridge");
    expect(args.at(-1)).toBe("img:tag");
  });
});

/* ------------------------------------------------------------------ logWatch */

describe("pairing log watcher", () => {
  it("finds the pairing code and QR URL in real ANSI-colored output", () => {
    const info = scanLogs(REAL_LOG);
    expect(info.manualPairingCode).toBe("05671110155");
    expect(info.qrUrl).toBe(
      "https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT:Y.K90Q1212JLFX5DD00",
    );
    expect(info.commissioned).toBe(false);
    expect(isPairingComplete(info)).toBe(true);
  });

  it("strips ANSI escapes", () => {
    expect(stripAnsi(`${ESC}[38;5;115m[Matterbridge]${ESC}[0m hi${ESC}[K`)).toBe(
      "[Matterbridge] hi",
    );
  });

  it("keeps the most recent code after a restart", () => {
    const info = scanLogs(
      "Manual pairing code 11111111111 discriminator 1\nManual pairing code 22222222222 discriminator 2\n",
    );
    expect(info.manualPairingCode).toBe("22222222222");
  });

  it("treats an already-commissioned bridge as complete", () => {
    const info = scanLogs("[Matterbridge] Server node for Matterbridge is already commissioned");
    expect(info.commissioned).toBe(true);
    expect(isPairingComplete(info)).toBe(true);
  });

  it("is incomplete while only half the pairing details are out", () => {
    expect(isPairingComplete(scanLogs("Manual pairing code 05671110155 discriminator 3840"))).toBe(
      false,
    );
  });

  it("polls until the code appears", async () => {
    let poll = 0;
    const result = await waitForPairing({
      readLogs: () => (poll++ < 2 ? "Matterbridge is starting..." : REAL_LOG),
      timeoutMs: 60_000,
      pollMs: 1,
      sleep: async () => {},
    });
    expect(result.timedOut).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.info.manualPairingCode).toBe("05671110155");
  });

  it("gives up at the deadline", async () => {
    let clock = 0;
    const result = await waitForPairing({
      readLogs: () => "nothing useful",
      timeoutMs: 10,
      pollMs: 1,
      now: () => (clock += 4),
      sleep: async () => {},
    });
    expect(result.timedOut).toBe(true);
    expect(result.info.manualPairingCode).toBeUndefined();
  });
});

/* ----------------------------------------------------------------- commands */

const LINUX_DOCKER = {
  "docker --version": ok("Docker version 29.1.3"),
  "docker info": ok("29.1.3"),
  "docker-compose --version": ok("Docker Compose version v5.0.1"),
  "ip route show default": ok("default via 192.168.1.1 dev enx001a2b3c4d5e proto static metric 50"),
};

const HOST_INTERFACES = {
  lo: [ipv4("127.0.0.1", "lo")],
  docker0: [ipv4("172.17.0.1", "docker0")],
  enx001a2b3c4d5e: [ipv4("192.168.1.20", "enx001a2b3c4d5e")],
};

describe("runCli", () => {
  it("prints help and the version", async () => {
    const help = deps();
    expect(await runCli([], help)).toBe(0);
    expect(help.writer.lines.join("\n")).toContain("npx matterbridge-elgato@latest setup");

    const version = deps();
    expect(await runCli(["version"], version)).toBe(0);
    expect(version.writer.lines[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports bad arguments on stderr with exit code 2", async () => {
    const bad = deps();
    expect(await runCli(["setup", "--nope"], bad)).toBe(2);
    expect(bad.writer.errors.join("\n")).toMatch(/Unknown argument/);
  });

  it("writes the stack without starting it and prints JSON", async () => {
    const dir = temporaryDir();
    const target = join(dir, "stack");
    const d = deps({ run: stubRunner(LINUX_DOCKER).run, networkInterfaces: () => HOST_INTERFACES });

    expect(
      await runCli(
        [
          "setup",
          "--dir",
          target,
          "--interface",
          "enx001a2b3c4d5e",
          "--no-start",
          "--yes",
          "--json",
        ],
        d,
      ),
    ).toBe(0);

    const summary = JSON.parse(d.writer.lines.join("\n")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      ok: true,
      command: "setup",
      directory: target,
      composeFile: join(target, "docker-compose.yml"),
      started: false,
      image: DEFAULT_IMAGE,
    });
    expect(summary["interface"]).toMatchObject({
      name: "enx001a2b3c4d5e",
      address: "192.168.1.20",
      reason: "you passed --interface",
    });
    expect(summary["reason"]).toBe("--no-start was given");
    expect(summary["compose"]).toMatchObject({
      kind: "standalone",
      upCommand: "docker-compose up -d",
    });
    // Always present, so an agent can branch on them without key checks.
    expect(summary["qrUrl"]).toBeNull();
    expect(summary["manualPairingCode"]).toBeNull();
    expect(Array.isArray(summary["nextSteps"])).toBe(true);

    const yaml = readFileSync(join(target, "docker-compose.yml"), "utf8");
    expect(yaml).toContain("MDNS_INTERFACE: enx001a2b3c4d5e");
    for (const name of DATA_DIRECTORIES) {
      expect(statSync(join(target, "data", name)).isDirectory()).toBe(true);
    }
  });

  it("auto-detects the interface from the default route and says why", async () => {
    const dir = temporaryDir();
    const d = deps({ run: stubRunner(LINUX_DOCKER).run, networkInterfaces: () => HOST_INTERFACES });

    expect(await runCli(["setup", "--dir", dir, "--no-start"], d)).toBe(0);
    const output = d.writer.lines.join("\n");
    expect(output).toContain(
      "✓ Network interface: enx001a2b3c4d5e (192.168.1.20), because it carries the host's default route",
    );
    expect(output).toContain("Not started, because --no-start was given");
    expect(output).toContain("Google Home: tap +");
  });

  it("prompts when several interfaces qualify, and honors the answer", async () => {
    const dir = temporaryDir();
    const d = deps({
      run: stubRunner({ ...LINUX_DOCKER, "ip route show default": ok("") }).run,
      networkInterfaces: () => ({
        eth0: [ipv4("192.168.1.10", "eth0")],
        wlan0: [ipv4("192.168.1.11", "wlan0")],
      }),
      prompt: async () => "2",
    });
    expect(await runCli(["setup", "--dir", dir, "--no-start"], d)).toBe(0);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain(
      "MDNS_INTERFACE: wlan0",
    );
  });

  it("takes the first candidate with --yes, and rejects a bogus answer", async () => {
    const twoNics = {
      eth0: [ipv4("192.168.1.10", "eth0")],
      wlan0: [ipv4("192.168.1.11", "wlan0")],
    };
    const dir = temporaryDir();
    const yes = deps({
      run: stubRunner({ ...LINUX_DOCKER, "ip route show default": ok("") }).run,
      networkInterfaces: () => twoNics,
    });
    expect(await runCli(["setup", "--dir", dir, "--no-start", "--yes"], yes)).toBe(0);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("MDNS_INTERFACE: eth0");

    const bogus = deps({
      run: stubRunner({ ...LINUX_DOCKER, "ip route show default": ok("") }).run,
      networkInterfaces: () => twoNics,
      prompt: async () => "9",
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--no-start"], bogus)).toBe(1);
    expect(bogus.writer.errors.join("\n")).toMatch(/not one of the listed interfaces/);
  });

  it("rejects an --interface this host does not have, and allows a virtual one", async () => {
    const typo = deps({
      run: stubRunner(LINUX_DOCKER).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    expect(
      await runCli(["setup", "--dir", temporaryDir(), "--no-start", "-i", "eth99"], typo),
    ).toBe(1);
    const message = typo.writer.errors.join("\n");
    expect(message).toContain('no interface named "eth99"');
    expect(message).toContain("enx001a2b3c4d5e (192.168.1.20)");
    expect(message).toContain("docker0 (172.17.0.1)");

    // docker0 is skipped by auto-detection, but naming it is a deliberate choice.
    const dir = temporaryDir();
    const explicit = deps({
      run: stubRunner(LINUX_DOCKER).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    expect(await runCli(["setup", "--dir", dir, "--no-start", "-i", "docker0"], explicit)).toBe(0);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain(
      "MDNS_INTERFACE: docker0",
    );

    const bare = deps({ run: stubRunner(LINUX_DOCKER).run, networkInterfaces: () => ({}) });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--no-start", "-i", "eth0"], bare)).toBe(
      1,
    );
    expect(bare.writer.errors.join("\n")).toContain("It has none at all.");
  });

  it("fails when there is no LAN interface at all", async () => {
    const d = deps({
      run: stubRunner(LINUX_DOCKER).run,
      networkInterfaces: () => ({
        lo: [ipv4("127.0.0.1", "lo")],
        docker0: [ipv4("172.17.0.1", "docker0")],
      }),
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--no-start"], d)).toBe(1);
    expect(d.writer.errors.join("\n")).toMatch(/No LAN network interface found/);
  });

  it("refuses to start without a reachable Docker daemon, but still writes files with --no-start", async () => {
    const starting = deps({ run: stubRunner({}).run, networkInterfaces: () => HOST_INTERFACES });
    expect(await runCli(["setup", "--dir", temporaryDir()], starting)).toBe(1);
    expect(starting.writer.errors.join("\n")).toMatch(/Docker is not installed/);

    const dir = temporaryDir();
    const offline = deps({ run: stubRunner({}).run, networkInterfaces: () => HOST_INTERFACES });
    expect(
      await runCli(
        ["setup", "--dir", dir, "--no-start", "--interface", "enx001a2b3c4d5e"],
        offline,
      ),
    ).toBe(0);
    expect(offline.writer.lines.join("\n")).toMatch(/! Docker is not installed/);
  });

  it("never starts the stack on macOS or Windows, even with --yes", async () => {
    const d = deps({
      platform: "darwin",
      run: stubRunner({ ...LINUX_DOCKER, "docker-compose up -d": ok("") }).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    // No --no-start here: --yes alone must not start a stack that cannot pair.
    expect(await runCli(["setup", "--dir", temporaryDir(), "--yes", "--json"], d)).toBe(0);
    expect(JSON.parse(d.writer.lines.join("\n"))).toMatchObject({
      started: false,
      reason: "the host platform is darwin, not linux",
    });

    const human = deps({
      platform: "darwin",
      run: stubRunner({ ...LINUX_DOCKER, "docker-compose up -d": ok("") }).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--yes"], human)).toBe(0);
    const text = human.writer.lines.join("\n");
    expect(text).toContain("Writing the files only");
    expect(text).toContain("Not started, because the host platform is darwin, not linux");
  });

  it("stops on macOS and Windows unless --yes is given", async () => {
    const mac = deps({
      platform: "darwin",
      run: stubRunner(LINUX_DOCKER).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--no-start"], mac)).toBe(1);
    expect(mac.writer.errors.join("\n")).toMatch(/needs a Linux Docker host/);

    const forced = deps({
      platform: "win32",
      run: stubRunner(LINUX_DOCKER).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--no-start", "--yes"], forced)).toBe(0);
    expect(forced.writer.lines.join("\n")).toMatch(/needs a Linux Docker host/);
  });

  it("reports a failed start as JSON when --json is set", async () => {
    const d = deps({
      run: stubRunner({ ...LINUX_DOCKER, "docker-compose up -d": fail("no such image") }).run,
      networkInterfaces: () => HOST_INTERFACES,
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--json"], d)).toBe(1);
    expect(JSON.parse(d.writer.lines.join("\n"))).toMatchObject({ ok: false, command: "setup" });
    expect(d.writer.lines.join("\n")).toContain("no such image");
  });

  it("starts the stack and surfaces the pairing code", async () => {
    const d = deps({
      run: stubRunner({
        ...LINUX_DOCKER,
        "docker-compose up -d": ok(""),
        "docker-compose logs": ok(REAL_LOG),
      }).run,
      networkInterfaces: () => HOST_INTERFACES,
      waitMs: 1000,
    });
    expect(await runCli(["setup", "--dir", temporaryDir(), "--json"], d)).toBe(0);
    expect(JSON.parse(d.writer.lines.join("\n"))).toMatchObject({
      started: true,
      manualPairingCode: "05671110155",
      frontendUrl: "http://192.168.1.20:8283",
    });
  });

  it("prints the pairing code in human form too, and notes a timeout", async () => {
    const started = deps({
      run: stubRunner({
        ...LINUX_DOCKER,
        "docker-compose up -d": ok(""),
        "docker-compose logs": ok(REAL_LOG),
      }).run,
      networkInterfaces: () => HOST_INTERFACES,
      waitMs: 1000,
    });
    expect(
      await runCli(["setup", "--dir", temporaryDir(), "--frontend-port", "28283"], started),
    ).toBe(0);
    const text = started.writer.lines.join("\n");
    expect(text).toContain("Manual pairing code:    05671110155");
    expect(text).toContain("http://192.168.1.20:28283");

    const slow = deps({
      run: stubRunner({
        ...LINUX_DOCKER,
        "docker-compose up -d": ok(""),
        "docker-compose logs": ok("starting"),
      }).run,
      networkInterfaces: () => HOST_INTERFACES,
      waitMs: 0,
    });
    expect(await runCli(["setup", "--dir", temporaryDir()], slow)).toBe(0);
    expect(slow.writer.lines.join("\n")).toMatch(/Timed out waiting for the pairing code/);
  });

  it("says so when the bridge is already commissioned", async () => {
    const d = deps({
      run: stubRunner({
        ...LINUX_DOCKER,
        "docker-compose up -d": ok(""),
        "docker-compose logs": ok("Server node for Matterbridge is already commissioned"),
      }).run,
      networkInterfaces: () => HOST_INTERFACES,
      waitMs: 1000,
    });
    expect(await runCli(["setup", "--dir", temporaryDir()], d)).toBe(0);
    expect(d.writer.lines.join("\n")).toContain("already commissioned");
  });

  it("falls back to docker run when no compose binary exists", async () => {
    const { run, calls } = stubRunner({
      "docker --version": ok("Docker version 29.1.3"),
      "docker info": ok("29.1.3"),
      "ip route show default": ok("default via 192.168.1.1 dev enx001a2b3c4d5e"),
      "docker run": ok("cid"),
      "docker logs": ok(REAL_LOG),
    });
    const dir = temporaryDir();
    const d = deps({ run, networkInterfaces: () => HOST_INTERFACES, waitMs: 1000 });
    expect(await runCli(["setup", "--dir", dir, "--json"], d)).toBe(0);
    expect(calls.some((call) => call.startsWith("docker run -d --name matterbridge-elgato"))).toBe(
      true,
    );
    expect(JSON.parse(d.writer.lines.join("\n"))).toMatchObject({ compose: { kind: "none" } });
  });

  it("reports status in both human and JSON form", async () => {
    const table = {
      ...LINUX_DOCKER,
      "docker-compose ps": ok("NAME                 STATUS\nmatterbridge-elgato  Up 2 minutes"),
      "docker-compose logs": ok(REAL_LOG),
    };
    const human = deps({ run: stubRunner(table).run });
    expect(await runCli(["status", "--dir", "/srv/mb"], human)).toBe(0);
    expect(human.writer.lines.join("\n")).toContain("Manual pairing code: 05671110155");

    const json = deps({ run: stubRunner(table).run });
    expect(await runCli(["status", "--dir", "/srv/mb", "--json"], json)).toBe(0);
    expect(JSON.parse(json.writer.lines.join("\n"))).toMatchObject({
      running: true,
      commissioned: false,
      manualPairingCode: "05671110155",
    });
  });

  it("reports a stopped stack", async () => {
    const table = { ...LINUX_DOCKER, "docker-compose ps": fail("no configuration file provided") };
    const d = deps({ run: stubRunner(table).run });
    expect(await runCli(["status"], d)).toBe(1);
    expect(d.writer.lines.join("\n")).toContain("no configuration file provided");

    const commissioned = deps({
      run: stubRunner({
        ...LINUX_DOCKER,
        "docker-compose ps": ok("matterbridge-elgato Up"),
        "docker-compose logs": ok("is already commissioned"),
      }).run,
    });
    expect(await runCli(["status"], commissioned)).toBe(0);
    expect(commissioned.writer.lines.join("\n")).toContain("Commissioned: yes");
  });

  it("passes logs arguments straight through", async () => {
    let seen: string[] = [];
    const d = deps({
      run: stubRunner(LINUX_DOCKER).run,
      runAttached: (command, args, cwd) => {
        seen = [command, ...args, cwd];
        return 0;
      },
    });
    expect(await runCli(["logs", "--dir", "/srv/mb", "-f", "--tail", "20"], d)).toBe(0);
    expect(seen).toEqual(["docker-compose", "logs", "-f", "--tail", "20", "/srv/mb"]);
  });

  it("resolves relative directories against the working directory", () => {
    expect(resolveDir("stack", "/srv")).toBe("/srv/stack");
    expect(resolveDir("/abs/stack", "/srv")).toBe("/abs/stack");
  });
});

/* ------------------------------------------------------------- real wiring */

describe("default wiring", () => {
  it("builds deps from the real process", () => {
    const real = defaultDeps();
    expect(real.platform).toBe(process.platform);
    expect(real.cwd).toBe(process.cwd());
    expect(real.waitMs).toBeGreaterThan(0);
    expect(Object.keys(real.networkInterfaces()).length).toBeGreaterThan(0);
  });

  it("writes through process.stdout and process.stderr", () => {
    const captured: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      captured.push(`out:${chunk}`);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      captured.push(`err:${chunk}`);
      return true;
    }) as typeof process.stderr.write;
    try {
      processWriter.out("hello");
      processWriter.err("nope");
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    expect(captured).toEqual(["out:hello\n", "err:nope\n"]);
  });

  it("really shells out through the spawn runner", () => {
    expect(spawnRunner("node", ["-e", "process.stdout.write('hi')"]).stdout).toBe("hi");
    expect(spawnRunner("this-command-does-not-exist", []).status).toBe(127);
  });

  it("sleeps for real when no clock is injected", async () => {
    const result = await waitForPairing({
      readLogs: () => REAL_LOG,
      timeoutMs: 1000,
      pollMs: 1,
    });
    expect(result.attempts).toBe(1);
    const slow = await waitForPairing({ readLogs: () => "", timeoutMs: 5, pollMs: 1 });
    expect(slow.timedOut).toBe(true);
  });

  it("reports the package version", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
