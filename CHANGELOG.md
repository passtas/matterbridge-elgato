# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `preserveSceneOnOff` config flag, off by default (#3). With it on, switching off
  a Light Strip that is playing a scene sends the cached scene back with `on: 0` in
  the same body, so the strip parks off with the scene still stored instead of
  reverting to its previous color. The next on replays the scene as before, since
  a bare `{on: 1}` does not resume a parked one, and with the flag on an On also
  resumes a strip that is off inside a scene for any other reason (another app, a
  bridge restart).
  - If the strip refuses the scene body (an HTTP error, or an error reply), one
    bare `{on: 0}` follows and the refusal is logged at debug, so an off is not
    lost because the light refused the scene. If the strip does not answer at
    all, or answers with a reply that does not parse, nothing more is sent and
    the next poll reconciles, as for any failed write.
  - The park is only tried from a settled state. With a write still queued or a
    color change waiting in the debounce, the plain off goes out instead.
  - Key Lights are untouched. With the flag unset, the bytes on the wire are the
    same as in 0.1.1 for any on/off sequence whose commands do not overlap; the
    one change for overlapping commands is under Fixed. It stays opt-in until a
    release of field reports, because it changes what is stored on the light.

- Key Light Mini battery on Matter (#2). A light that answers
  `GET /elgato/battery-info` gets the battery (Battery + Rechargeable) variant of
  the PowerSource cluster instead of the wired one, so Google Home, Apple Home
  and Alexa can show its charge and warn when it runs low:
  `batPercentRemaining` (half-percent units), `batChargeLevel` (Warning below
  20 %, Critical below 10 %), `batChargeState` (charging, full, not charging)
  and `batVoltage`. The battery is detected by asking that endpoint once per
  light at startup, not by model code; a 404 is final, so a Key Light Air or a
  Light Strip costs one request and no log line. Battery values are read on
  every Nth poll, about every 30 seconds, never on a timer of their own, and a
  failed battery read never marks the light unreachable. Jitter is not
  reported: the percentage follows a move of 1 % (or a threshold crossing, or
  0 % / 100 %), the voltage a move of 20 mV; charge state and level follow at
  once.
  - A Mini that was already paired keeps its endpoint, room and automations;
    see `docs/troubleshooting.md` if the controller does not show the battery
    after the upgrade.
  - A Mini that does not answer the battery probe is not added with a guess:
    it goes to the retry queue like a light that is off, and is added, battery
    included, once it answers.
  - `npm run mock -- --mini` adds a mock Key Light Mini on port 9126.

### Changed

- The Light Strip's remembered scene is written to storage only when the scene
  changes, instead of on every poll that sees one playing. A strip left in a scene
  no longer costs a disk write every poll interval.

### Fixed

- An off that arrives while the Light Strip's scene is being put back no longer
  makes the next on forget to put it back again.
- A light that announced itself on mDNS with its `.local` name but no address is
  no longer lost until the next restart. In the Docker image, which cannot resolve
  `.local` names, its probe failed with "fetch failed" and was never retried. The
  plugin now keeps the A records it hears on the socket it already browses on
  (the light sends its A record just before the announcement that lacks it), asks
  mDNS for the address itself when it has none, sending the query a second time a
  second later, and keeps the bare name only as a last resort.
- A light that does not answer its first probe, whether announced on mDNS or listed
  under `devices` and switched off when the bridge starts, is retried after 10 s,
  then at doubling intervals capped at 5 minutes, on a timer of its own, so the poll
  loop never waits on it. The first failure is still logged as an error, retries go
  to debug, and the eventual success is logged at info. A Key Light Air MK.2 and
  lights the white or black list rejects are never retried.
- A `.local` host in the manual `devices` list now works in the Docker image. When
  the system cannot resolve the name, the plugin asks mDNS for the address, at
  startup and before each retry, and does so even with `enableMdns` off, where it
  opens the mDNS socket for these lookups but browses nothing.
- A registered light that came back on a new DHCP lease is followed there: when it
  stops answering at its IP address, its `.local` name is looked up again, at the
  retry backoff. bonjour-service reports no address changes by itself.
- A light in the `devices` list that was off at startup and then announced itself
  on mDNS registers under its configured `name`, not its mDNS one, so the next
  restart does not turn it into a new device for the controllers.
- A failing mDNS socket (port taken, no permission) logs a warning and turns `.local`
  lookups off instead of crashing the bridge.
- A light registered after startup has its state read into Matter straight away,
  instead of at the first poll.
- An mDNS announcement on a port other than 9123 is probed on that port.

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
