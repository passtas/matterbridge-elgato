# matterbridge-elgato

**Your Elgato lights in Google Home, Apple Home and Alexa.**

[![npm](https://img.shields.io/npm/v/matterbridge-elgato?logo=npm&color=cb3837)](https://www.npmjs.com/package/matterbridge-elgato)
[![release](https://img.shields.io/github/v/release/passtas/matterbridge-elgato?logo=github)](https://github.com/passtas/matterbridge-elgato/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/passtas/matterbridge-elgato/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI)](https://github.com/passtas/matterbridge-elgato/actions/workflows/ci.yml)
[![container](https://img.shields.io/badge/ghcr.io-matterbridge--elgato-2496ed?logo=docker&logoColor=white)](https://github.com/passtas/matterbridge-elgato/pkgs/container/matterbridge-elgato)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Elgato's Key Lights live in Control Center, and Control Center is an island. They
cannot join a room, cannot be in a routine, cannot be on a schedule, and do not
answer to voice. Switching the office off at the end of the day means walking
back in or waking the PC. This makes them ordinary Matter lights, owned by the
home app that is already on the phone.

<p align="center"><img src="https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/docs/assets/google-home.png" width="260" alt="Two Elgato lights in a Google Home room, with the group brightness slider, the color temperature presets and a tile per light"> &nbsp; <img src="https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/docs/assets/matterbridge-frontend.png" width="560" alt="The Matterbridge frontend, showing the plugin row and the two bridged lights"></p>

Left: both lights in a Google Home room. Right: the Matterbridge frontend, where
the pairing code and the plugin config live.

## Two ways to install

### Already running Matterbridge

Open your frontend, go to Install plugins, type `matterbridge-elgato`, click
Install, restart. That is the whole install.

The lights turn up on their own, under the bridge you already paired. Same
bridge, same fabrics, same frontend, two more endpoints. Needs Matterbridge
3.10.0 or newer.

### Starting from nothing: take the bundle

One container, with Matterbridge and this plugin already inside it.

```bash
npx matterbridge-elgato@latest setup
```

- finds Docker, and the interface that faces your LAN, asking you only if more
  than one could be it,
- writes `./matterbridge-elgato/docker-compose.yml` and starts the stack,
- prints the frontend URL, the QR code link and the manual pairing code.

Or drive it yourself:

```bash
docker run -d --name matterbridge-elgato --network host --restart unless-stopped --stop-timeout 60 -e MDNS_INTERFACE=eth0 -e TZ=Europe/London -v "$PWD/data/.matterbridge:/root/.matterbridge" -v "$PWD/data/Matterbridge:/root/Matterbridge" -v "$PWD/data/.mattercert:/root/.mattercert" ghcr.io/passtas/matterbridge-elgato:latest
```

Swap `eth0` for the interface facing your LAN (`ip -br addr` lists them) and
`Europe/London` for your timezone. The plugin registers itself on first start.
Open `http://<host-ip>:8283` for the pairing code.

The compose file, the full flag reference and notes for Synology, QNAP, Unraid
and Raspberry Pi are in [docs/install.md](docs/install.md).

**What the bundle needs:**

- An always-on Linux box with Docker on the same LAN as the lights. A home
  server, a NAS, a Raspberry Pi. It only works while that box is on.
- Host networking. Matter and mDNS run on multicast, which does not cross a
  Docker bridge network.
- Not Docker Desktop. On macOS and Windows its host network is a VM's, so
  nothing is discovered and nothing pairs.
  [Why](docs/install.md#docker-desktop-on-macos-and-windows-will-not-do).
- IPv6 on the LAN. Matter speaks IPv6 locally. Your internet connection does not
  need it, your router does.

A Matter controller too, of course: a Nest hub or Nest Wifi point, a HomePod or
Apple TV, an Echo of the 4th generation or newer.

## Pairing

The code shows up in three places: printed by `setup` when it finishes and again
by `status`, in the frontend at `http://<host-ip>:8283`, and in the log as
`Manual pairing code` and `QR Code URL`.

- **Google Home**: `+`, Set up device, Works with Google Home, Matter device,
  then scan the QR code or type the manual code.
- **Apple Home**: `+`, Add Accessory, More options or "My device is not shown",
  then enter the code.
- **Alexa**: Devices, `+`, Add Device, Other, Matter, then enter the code.

Do it more than once. After the first controller has adopted the bridge, open the
frontend's _Paired fabrics_ panel, turn pairing mode back on, and run the next
one. Each controller gets its own fabric and they leave each other alone.

## What you get

- Say "Hey Google, office off" and the Key Light goes dark with the rest of the
  room. Same for Siri and Alexa.
- The lights join rooms, routines and schedules like any other bulb. A sunset
  routine can warm the Key Light and turn the Strip amber with nothing in your
  hand.
- On, off, brightness and color temperature on the Key Lights. On, off,
  brightness and color on the Light Strip. Move the slider and the real light
  moves, not a cloud copy of it.
- Nothing leaves the house. The lights speak HTTP on your LAN, the bridge speaks
  Matter on your LAN, and there is no Elgato account anywhere in the path.
- Google, Apple and Alexa at once, on the same bridge, because Matter allows
  several admins. Your phone and somebody else's can be in different ecosystems
  and still both work.

New lights are found by themselves over mDNS, filed by serial number so a new
DHCP address does not create a duplicate, and there is a manual address list for
networks that filter multicast.
[docs/how-it-works.md](docs/how-it-works.md) has the mechanics and the limits.

## Supported models

The plugin decides what a light is from the light's own reply, not from a table
of model numbers, so a model that is not listed here still stands a good chance
of working. The table is about what has been confirmed.

| Model              | Model number                          | Type code (`dt`) | Status                                                                               |
| ------------------ | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| Key Light Air      | 20LAB9901 (10LAB9901)                 | 200              | Verified                                                                             |
| Light Strip        | 20LAA9901 (10LAA9901)                 | 70               | Verified                                                                             |
| Key Light          | 20GAK9901 (10GAK9901)                 | 53               | Expected, please confirm                                                             |
| Key Light MK.2     | unknown (10GAK9901, same as the MK.I) | 205              | Expected, please confirm                                                             |
| Key Light Mini     | unknown (10LAD9901)                   | 202              | Expected, please confirm                                                             |
| Ring Light         | 20LAC9901 (10LAC9901)                 | 201              | Expected, please confirm                                                             |
| Light Strip Pro    | 20LAG9901 (10LAG9901)                 | 206              | Expected, please confirm                                                             |
| Key Light Neo      | unknown (10LAJ9901)                   | 210              | Uncertain discovery, use the manual address option                                   |
| Key Light Air MK.2 | 20LAM9901 (10LAM9901)                 | 214              | Not supported yet, see [#1](https://github.com/passtas/matterbridge-elgato/issues/1) |

"Verified" means the two lights this project was built against: a Key Light Air
and a Light Strip, tested live and paired to Google Home. "Expected" means the
model is known to speak the same local HTTP API, but nobody has run this plugin
against one. The Key Light Neo is separate: owners of other mDNS-based tools
report that Control Center finds the Neo while third-party clients do not, and
nobody has established why, so add it by address instead of relying on discovery.

The model number column shows the form that appears in the light's mDNS record
and in the plugin log, with the number printed on the retail box in brackets.
They differ only in the first digit.

If you own one of the unconfirmed models, a report fills in a row. There is a
template and a checklist in
[#4](https://github.com/passtas/matterbridge-elgato/issues/4).

A Key Light Air MK.2 is found and then left alone on purpose: that generation
speaks mutual TLS on port 9123 instead of the plain HTTP API. The plugin names it
in the log once and never probes it again. The protocol notes and the design are
in [#1](https://github.com/passtas/matterbridge-elgato/issues/1); somebody who
owns one has to build it.

## Updating, and where your data lives

Bundle: `docker compose pull && docker compose up -d` in the directory `setup`
created. Existing Matterbridge: install the plugin again from the frontend's
Install plugins panel, then restart.

Everything persistent sits in `data/` next to the compose file. `.matterbridge`
is the one that matters: it holds the Matter commissioning data and the plugin
config, so back it up before any factory reset. Lose it and every controller has
to pair again. More in [docs/install.md](docs/install.md).

## Install with your AI assistant

Running Claude Code, Codex or Cursor on the machine that will host the bridge?
Paste this and let it do the work.

```text
Install matterbridge-elgato on this machine so my Elgato lights show up in my
smart home app. Read
https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/AGENTS.md
first and follow the install procedure in it exactly, including the questions it
tells you to ask me before you run anything.
```

It checks whether Matterbridge is already here before it reaches for the bundle,
and it asks whether this machine stays on, because a bridge on a laptop is a
bridge that stops working when the lid closes.

## Footprint

Two lights connected, 30 minutes: process CPU about 0.02 %, resident memory about
195 MB steady, heap about 70 MB and flat, no growth.

Measured on a Beelink EQR6 mini PC (Ryzen 7 6800H, 32 GB) running Ubuntu 24.04
LTS on x86_64, Docker 29, alongside about twenty other containers, wired
Ethernet, a Google Nest Wifi mesh with the lights on 2.4 GHz, and a Nest hub as
the Matter controller. The lights were a Key Light Air on firmware 1.0.3 and a
Light Strip on firmware 1.0.4. The arm64 image is built in CI and has never been
run on hardware.

| Piece      | What was tested                                                                          | Status                     |
| ---------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| Host       | Beelink EQR6 (Ryzen 7 6800H, 32 GB), Ubuntu 24.04 LTS, x86_64, Docker 29, wired Ethernet | Confirmed 2026-09-05       |
| Network    | Google Nest Wifi mesh, lights on 2.4 GHz, host wired on the same LAN                     | Confirmed 2026-09-05       |
| Controller | Google Home, Nest hub as the Matter controller                                           | Confirmed 2026-09-05       |
| Lights     | Key Light Air fw 1.0.3, Light Strip fw 1.0.4                                             | Confirmed 2026-09-05       |
| Apple Home | HomePod or Apple TV as the Matter controller                                             | Expected, nobody has tried |
| Alexa      | Echo 4th generation or newer                                                             | Expected, nobody has tried |
| arm64      | Raspberry Pi or an ARM NAS                                                               | Image builds in CI, unrun  |

Add yours in [#4](https://github.com/passtas/matterbridge-elgato/issues/4) and it
goes in this table.

## Docs

- [Install notes](docs/install.md): flags, compose file, Synology, QNAP, Unraid,
  Raspberry Pi.
- [Configuration](docs/configuration.md): poll interval, manual addresses, white
  and black lists, how device names are pinned.
- [How it works](docs/how-it-works.md): discovery, polling, clamping, scenes, and
  what it cannot do.
- [Troubleshooting](docs/troubleshooting.md): nothing found, pairing that never
  completes, collecting a log.

## Contributing

Bug reports, device confirmations and pull requests are all welcome, and a
confirmation that one more light model works is as useful here as code.
[CONTRIBUTING.md](CONTRIBUTING.md) has the five commands that get you a working
checkout, the mock devices, the live tests, and what a good pull request looks
like. The open
[help wanted](https://github.com/passtas/matterbridge-elgato/labels/help%20wanted)
issues are the shortlist, starting with
[#1](https://github.com/passtas/matterbridge-elgato/issues/1) (Key Light Air
MK.2) and [#4](https://github.com/passtas/matterbridge-elgato/issues/4)
(confirmations wanted).

[docs/elgato-protocol.md](docs/elgato-protocol.md) is what the lights actually
do, checked against hardware, and
[docs/matterbridge-api-cheatsheet.md](docs/matterbridge-api-cheatsheet.md) is
what the plugin API actually does.

## Credits

[Matterbridge](https://github.com/Luligu/matterbridge) by Luligu (Apache-2.0)
does the hard part: it is the bridge, the frontend and the pairing flow, built on
[matter.js](https://github.com/project-chip/matter.js) by project-chip. This
plugin is a thin layer that turns Elgato lights into endpoints for it.

The protocol groundwork came from other people's work on the same lights:
[python-elgato](https://github.com/frenck/python-elgato) by frenck, which Home
Assistant uses and which is where the board type table comes from, and the
Homebridge Elgato plugins that got there first. The Key Light Air MK.2 protocol
is documented in [Lolgato issue
#14](https://github.com/raine/Lolgato/issues/14), where a user reverse-engineered
the whole TLS transport and wrote it down.

## License

MIT. See [LICENSE](LICENSE).
