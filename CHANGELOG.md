# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
