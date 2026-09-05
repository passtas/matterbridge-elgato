<h1 align="center">matterbridge-elgato</h1>

<p align="center"><strong>Your Elgato lights in Google Home, Apple Home and Alexa. Local, no account, no cloud.</strong></p>

<p align="center"><a href="https://www.npmjs.com/package/matterbridge-elgato"><img src="https://img.shields.io/npm/v/matterbridge-elgato?logo=npm&color=cb3837" alt="npm"></a> <a href="https://github.com/passtas/matterbridge-elgato/releases"><img src="https://img.shields.io/github/v/release/passtas/matterbridge-elgato?logo=github" alt="release"></a> <a href="https://github.com/passtas/matterbridge-elgato/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/passtas/matterbridge-elgato/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI" alt="CI"></a> <a href="https://github.com/passtas/matterbridge-elgato/pkgs/container/matterbridge-elgato"><img src="https://img.shields.io/badge/ghcr.io-matterbridge--elgato-2496ed?logo=docker&logoColor=white" alt="container"></a> <a href="https://github.com/passtas/matterbridge-elgato/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a></p>

<p align="center"><img src="https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/docs/assets/google-home.png" width="200" alt="Two Elgato lights in a Google Home room, with the group brightness slider, the color temperature presets and a tile per light"> &nbsp; <img src="https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/docs/assets/matterbridge-frontend.png" width="400" alt="The Matterbridge frontend, showing the plugin row and the two bridged lights"></p>

<p align="center"><em>Left: both lights in a Google Home room. Right: the Matterbridge frontend, where the pairing code lives.</em></p>

**Before.** Control Center is an island: no rooms, no routines, no voice. Turning
the office off means walking back in, or waking the PC.<br>
**After.** "Hey Google, office off" and the Key Light goes dark with the rest of
the room. The Light Strip joins the movie-night routine.

## Sixty seconds to first light

**Two ways in, and the first one is four clicks.** The bridge runs inside
[Matterbridge](https://github.com/Luligu/matterbridge), an open source Matter
bridge. If you already run it, this is a plugin. If you have not, take the
bundle: one container with both already inside.

| Already running Matterbridge                                                                                                                                                                | Starting from nothing                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Open your frontend at `http://<host>:8283`<br>2. Go to **Install plugins**<br>3. Type `matterbridge-elgato`<br>4. Click **Install**, then restart<br>Needs Matterbridge 3.10.0 or newer. | 1. Run `npx matterbridge-elgato@latest setup`<br>2. It finds Docker and your LAN interface, writes a compose file and starts the stack<br>3. It prints the pairing code<br>4. Scan the QR<br>Needs a Linux host with Docker. |

**Left if Matterbridge is already on your network: the lights turn up under the
bridge you already paired, with no new pairing step. Right if this is all new.**

## What you get

**Ordinary lights in the home app that is already on your phone.**

- **Voice.** "Hey Google, office off" and the Key Light goes dark with the rest
  of the room. Same for Siri and Alexa.
- **Routines and schedules.** The lights join rooms and automations like any
  other bulb. A sunset routine warms the Key Light and turns the Strip amber with
  nothing in your hand.
- **The real controls.** On, off, brightness and color temperature on the Key
  Lights; on, off, brightness and color on the Light Strip. Move the slider and
  the light moves, not a cloud copy of it.
- **No cloud in the light path.** The lights speak HTTP on your LAN, the bridge
  speaks Matter on your LAN, and there is no Elgato account anywhere.
- **Google, Apple and Alexa at once**, on the same bridge, because Matter allows
  several admins. Your phone and somebody else's can be in different ecosystems.

## Installing in detail

**The plugin path has no requirements of its own; the bundle needs four things.**

- **An always-on Linux box with Docker** on the same LAN as the lights: a home
  server, a NAS, a Raspberry Pi. It only works while that box is on.
- **Host networking.** Matter and mDNS run on multicast, which does not cross a
  Docker bridge network.
- **Not Docker Desktop.** On macOS and Windows its host network is a VM's, so
  nothing is discovered and nothing pairs.
  [Why](docs/install.md#docker-desktop-on-macos-and-windows-will-not-do).
- **IPv6 on the LAN.** Matter speaks IPv6 locally. Your internet connection does
  not need it, your router does.

Plus a Matter controller, either way: a Nest hub or Nest Wifi point, a HomePod or
Apple TV, an Echo of the 4th generation or newer.

[Install notes](docs/install.md) has the flags, the compose file, a `docker run`
one-liner and per-NAS notes. [Configuration](docs/configuration.md) has the poll
interval, manual addresses, lists and device names.
[How it works](docs/how-it-works.md) has discovery, polling, clamping and the
limits, and [Troubleshooting](docs/troubleshooting.md) covers what to do when
nothing is found or pairing never completes.

## Pairing

**The code shows up in three places, and you can use it more than once.** `setup`
prints it when it finishes and `status` prints it again, the frontend shows it at
`http://<host-ip>:8283`, and the log has it as `Manual pairing code` and
`QR Code URL`.

- **Google Home**: `+`, Set up device, Works with Google Home, Matter device,
  then scan the QR code or type the manual code.
- **Apple Home**: `+`, Add Accessory, More options or "My device is not shown",
  then enter the code.
- **Alexa**: Devices, `+`, Add Device, Other, Matter, then enter the code.

Do it more than once. After the first controller has adopted the bridge, open the
frontend's _Paired fabrics_ panel and press the advertise button in its header,
tooltip "Send again the mDNS advertisement", then run the next controller. Each
controller gets its own fabric and they leave each other alone.

## Supported models

**The plugin decides what a light is from the light's own reply, not from a table
of model numbers**, so an unlisted model still stands a good chance of working.
Lights are found on their own over mDNS and filed by serial number, so a changed
DHCP address moves an entry rather than making a second one. This table is about
what has been confirmed.

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

"Verified" means the two lights this project was built against, tested live and
paired to Google Home. "Expected" means the model is known to speak the same
local HTTP API, but nobody has run this plugin against one. The Neo is separate:
owners of other mDNS-based tools report that Control Center finds it while
third-party clients do not, so add it by address rather than by discovery.

The model number column shows the form the light puts in its mDNS record and the
log, with the retail box number in brackets. A Key Light Air MK.2 is found and
then left alone on purpose: it speaks mutual TLS on port 9123 instead of the
plain HTTP API. If you own an unconfirmed model, a report fills in a row
([#4](https://github.com/passtas/matterbridge-elgato/issues/4) has the template).

## Footprint

**Two lights, 30 minutes: CPU about 0.02 %, resident memory about 195 MB steady,
heap about 70 MB and flat, no growth.** Read from the Matterbridge frontend's own
history, for the whole bridge process rather than the plugin alone.

| Piece      | What was tested                                                                          | Status                     |
| ---------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| Host       | Beelink EQR6 (Ryzen 7 6800H, 32 GB), Ubuntu 24.04 LTS, x86_64, Docker 29, wired Ethernet | Confirmed 2026-09-05       |
| Network    | Google Nest Wifi mesh, lights on 2.4 GHz, host wired on the same LAN                     | Confirmed 2026-09-05       |
| Controller | Google Home, Nest hub as the Matter controller                                           | Confirmed 2026-09-05       |
| Lights     | Key Light Air fw 1.0.3, Light Strip fw 1.0.4                                             | Confirmed 2026-09-05       |
| Apple Home | HomePod or Apple TV as the Matter controller                                             | Expected, nobody has tried |
| Alexa      | Echo 4th generation or newer                                                             | Expected, nobody has tried |
| arm64      | Raspberry Pi or an ARM NAS                                                               | Image builds in CI, unrun  |

Add yours in [#4](https://github.com/passtas/matterbridge-elgato/issues/4).

## Install with your AI assistant

**Hand the install to an agent already on the machine, or ask a web chat to walk
you through it.** Both start from [AGENTS.md](AGENTS.md), which makes the agent
ask two questions first: is Matterbridge already here, and does this machine
stay on.

[![Ask Claude](https://img.shields.io/badge/Ask%20Claude-d97757?logo=claude&logoColor=white)](https://claude.ai/new?q=Read%20https%3A%2F%2Fraw.githubusercontent.com%2Fpasstas%2Fmatterbridge-elgato%2Fmain%2FAGENTS.md%20and%20help%20me%20install%20matterbridge-elgato.%20Start%20with%20its%20two%20questions%3A%20is%20Matterbridge%20already%20running%20here%2C%20and%20is%20this%20an%20always-on%20Linux%20machine%20with%20Docker.) [![Ask ChatGPT](https://img.shields.io/badge/Ask%20ChatGPT-10a37f)](https://chatgpt.com/?q=Read%20https%3A%2F%2Fraw.githubusercontent.com%2Fpasstas%2Fmatterbridge-elgato%2Fmain%2FAGENTS.md%20and%20help%20me%20install%20matterbridge-elgato.%20Start%20with%20its%20two%20questions%3A%20is%20Matterbridge%20already%20running%20here%2C%20and%20is%20this%20an%20always-on%20Linux%20machine%20with%20Docker.) [![Ask Copilot](https://img.shields.io/badge/Ask%20Copilot-24292e?logo=githubcopilot&logoColor=white)](https://github.com/copilot?prompt=Read%20https%3A%2F%2Fraw.githubusercontent.com%2Fpasstas%2Fmatterbridge-elgato%2Fmain%2FAGENTS.md%20and%20help%20me%20install%20matterbridge-elgato.%20Start%20with%20its%20two%20questions%3A%20is%20Matterbridge%20already%20running%20here%2C%20and%20is%20this%20an%20always-on%20Linux%20machine%20with%20Docker.)

Those open a chat with the prompt filled in. A web chat guides you; it does not
run commands on your server, so you still type them yourself. Cursor takes the
same prompt as `cursor://anysphere.cursor-deeplink/prompt?text=` plus the encoded
text, but GitHub strips custom URL schemes, so there is no button for it above.

These do run it, on the machine you type them on, and they ask the two questions
before anything else:

```bash
claude "Read https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/AGENTS.md and install matterbridge-elgato on this machine"
codex "Read https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/AGENTS.md and install matterbridge-elgato on this machine"
```

Anywhere else, paste this:

```text
Read https://raw.githubusercontent.com/passtas/matterbridge-elgato/main/AGENTS.md
and help me install matterbridge-elgato. Start with its two questions: is
Matterbridge already running here, and is this an always-on Linux machine with
Docker.
```

## Updating, and where your data lives

**Bundle: `docker compose pull && docker compose up -d` in the directory `setup`
created.** On an existing Matterbridge, install the plugin again from the
frontend's Install plugins panel, then restart.

Everything persistent sits in `data/` next to the compose file. `.matterbridge`
is the one that matters: it holds the Matter commissioning data and the plugin
config, so back it up before any factory reset. Lose it and every controller has
to pair again.

## What this puts on your LAN

**Everything here stays on your network, and everything here is reachable by
anything else on your network.** The honest list:

- **The Matterbridge frontend on TCP 8283 is unauthenticated by default.** Anyone
  on your LAN who opens it can change the config and unpair your controllers.
  Matterbridge has a password setting in the frontend; set one.
- **Host networking also binds UDP 5540 (Matter) and UDP 5353 (mDNS).** An
  existing Matterbridge, or Home Assistant's Matter server, on the same host
  already holds those, and the two collide. Check with
  `ss -lnup | grep -E ':5540|:5353'` first.
- **The container runs as root**, because the upstream Matterbridge image does.
  Nothing here drops privileges on top of that.
- **The lights accept unauthenticated HTTP on port 9123** from anyone on the LAN.
  That is Elgato's design and predates this plugin, which is one more client of
  an API that was already open.
- **Nothing goes to any cloud from the plugin.** The bundle's only two outbound
  connections are Matterbridge checking npm for plugin updates and Docker pulling
  the image.
- **The plugin never sends an `Origin` header**, which is what the fix for
  CVE-2025-7202 rejects, so it works on patched and unpatched firmware alike.
- **Elgato's private keys will never be bundled here.** MK.2 support needs a
  client certificate, and the design in
  [#1](https://github.com/passtas/matterbridge-elgato/issues/1) points the plugin
  at PEMs you supply, nothing else.

## Contributing

**A confirmation that one more light model works is as useful here as code.**
[CONTRIBUTING.md](CONTRIBUTING.md) has the five commands that get you a working
checkout, the mock devices, the live tests and what a good pull request looks
like. The
[help wanted](https://github.com/passtas/matterbridge-elgato/labels/help%20wanted)
issues are the shortlist, starting with
[#1](https://github.com/passtas/matterbridge-elgato/issues/1) (Key Light Air
MK.2) and [#4](https://github.com/passtas/matterbridge-elgato/issues/4)
(confirmations wanted).

[docs/elgato-protocol.md](docs/elgato-protocol.md) is what the lights actually do,
checked against hardware, and
[docs/matterbridge-api-cheatsheet.md](docs/matterbridge-api-cheatsheet.md) is what
the plugin API actually does.

## Credits

**Matterbridge does the hard part.**
[Matterbridge](https://github.com/Luligu/matterbridge) by Luligu (Apache-2.0) is
the bridge, the frontend and the pairing flow, built on
[matter.js](https://github.com/project-chip/matter.js) by project-chip. This
plugin is a thin layer that turns Elgato lights into endpoints for it. The
protocol groundwork came from other people's work on the same lights:
[python-elgato](https://github.com/frenck/python-elgato) by frenck, where the
board type table comes from, and the Homebridge Elgato plugins that got there
first. [Lolgato issue #14](https://github.com/raine/Lolgato/issues/14) is where a
user reverse-engineered the MK.2 TLS transport and wrote it all down.

## License

MIT. See [LICENSE](LICENSE).
