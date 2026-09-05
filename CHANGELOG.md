# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-05

Documentation only. No code changes, so an existing install has nothing to gain
from updating; npm shows the README of the published version, which is why this
release exists.

### Changed

- README rewritten around the two install paths, with a side-by-side quick start
  for an existing Matterbridge and for the container bundle, and one line saying
  which is for whom.
- Pairing a second controller now describes the frontend control that exists:
  the advertise button in the _Paired fabrics_ panel, tooltip "Send again the
  mDNS advertisement".
- "Install with your AI assistant" gained prefilled-chat links for Claude,
  ChatGPT and Copilot, and terminal one-liners for Claude Code and Codex that
  run the install rather than talk about it.

### Added

- README section "What this puts on your LAN": the unauthenticated frontend on
  8283, the UDP 5540 and 5353 binds that collide with another Matter server on
  the same host, the container running as root, the lights' own open HTTP API on
  9123, the two outbound connections, the missing `Origin` header
  (CVE-2025-7202), and the commitment never to bundle Elgato's private keys.
- Port collision documented in `docs/install.md` requirements and in
  `docs/troubleshooting.md`, with the `ss` commands to check.
- `docs/install.md` now carries the `docker run` one-liner that used to be in
  the README.

### Fixed

- Adversarial review findings that landed after the 0.1.0 publish and so never
  reached npm: the local-only claim is scoped to the light path, the MK.2 retry
  wording matches the code, the image tags and architectures are listed, the
  Windows and macOS answer is spelled out, and the pairing steps now agree
  across the README, `AGENTS.md` and the CLI.

## [0.1.0] - 2026-09-05

### Added

- mDNS discovery of `_elg._tcp` devices plus a manual device list for networks
  where multicast does not survive.
- Device registry keyed by `accessory-info.serialNumber`, so a DHCP address
  change updates the record in place instead of creating a second Matter device.
- Key Light / Key Light Air exposed as a Matter **ColorTemperatureLight** with
  the real 143–344 mired range.
- Light Strip exposed as a Matter **ExtendedColorLight** (on/off, brightness,
  hue/saturation).
- Client-side clamping of every value: brightness 3–100, mireds 143–344, hue
  folded mod 360, saturation 0–100. Neither firmware clamps.
- Per-device serialized write queue with coalescing, and a 400 ms debounce that
  merges the separate `moveToHue` / `moveToSaturation` commands controllers send
  into a single device write.
- Polling (3 s by default) with diffing attribute updates, and `reachable=false`
  after three consecutive failures without unregistering the endpoint.
- Light Strip scene preservation: the last scene seen is cached per serial, and
  an off→on cycle puts it back.
- Color temperature on the Light Strip, turned into a point on the color wheel.
  The control is mandatory on a Matter ExtendedColorLight and would otherwise be
  a dead slider in Google Home and Apple Home.
- Stable Matter identity: the first name seen for a serial is persisted and reused,
  so renaming a light in the Elgato app no longer orphans it in Google/Apple Home.
  The displayed label still follows the rename.
- Key Light Air MK.2 is detected and skipped with a clear message. That
  generation answers on the same mDNS service and port but speaks mutual TLS, so
  it is named in the log once and counted in the discovery summary. A light that
  advertises the TLS protocol is left alone; one that merely closed the
  connection is tried again ten minutes later.
- `matterbridge-elgato setup`, `status` and `logs`: a CLI that checks Docker,
  detects the compose variant, picks the LAN interface, writes a Compose file,
  starts the stack and prints the pairing code. `--json` for scripts and agents.
- A container image with Matterbridge and this plugin pre-installed, which
  registers itself in the mounted data directory on first start.
- `matterbridge-elgato.schema.json` config UI with white/black lists by serial.
- Mock device server (`npm run mock`) emulating both models, including the mDNS
  advertisement, for development without real lights. `--mk2` adds a mock of the
  unsupported generation.

## Planned

- `preserveSceneOnOff` flag (v0.2): re-PUT the cached scene with `on: 0` so the Light
  Strip parks itself off with the scene intact, falling back to a bare `{on: 0}` if the
  firmware rejects the body. Not in v0.1: a bare `{on: 1}` does not resume a scene
  anyway, and putting a large body on the critical `off` path risks a generic 400.
