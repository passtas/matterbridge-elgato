# Install notes

The two install paths are in the
[README](../README.md#two-ways-to-install). This page has the details that would
make it twice as long: the full requirements, the Docker Desktop caveat, the
compose file, the flag reference for the setup command, per-NAS notes, and how to
update.

## What the bundle needs, in full

- **An always-on Linux machine with Docker**, on the same LAN as the lights. A
  home server, a NAS that runs Docker (Synology, QNAP, Unraid), or a Raspberry
  Pi. The bridge only works while that machine is on.
- **Host networking for the container.** Matter and mDNS both work over
  multicast, which does not cross a Docker bridge network, so the container has
  to share the host's network stack.
- **IPv6 enabled on the LAN.** Matter talks IPv6 locally. Your internet
  connection does not need it, your router's LAN does.
- **A Matter controller**: a Nest hub or Nest Wifi point for Google Home, a
  HomePod or an Apple TV for Apple Home, an Echo (4th generation or newer) for
  Alexa.
- **The lights on the same LAN as the host.** A separate IoT VLAN needs mDNS
  reflection between the two, or the manual address list in
  [configuration.md](configuration.md).

Installing into a Matterbridge you already run has none of these constraints
beyond the last one: whatever that Matterbridge needed, it already has.

## Docker Desktop on macOS and Windows will not do

It runs Docker inside a VM, where `--network host` is the VM's network and not
your LAN, so discovery and pairing cannot work. Run this on a Linux host. The
setup command refuses to run there unless you pass `--yes`, and even then it
only writes the files, it never starts the stack.

## The setup command in full

```bash
npx matterbridge-elgato@latest setup
```

It does five things:

- checks that Docker is installed and running, and works out whether the host has
  the `docker compose` plugin or the standalone `docker-compose` binary,
- picks the network interface that faces your LAN, and asks you if more than one
  could be it,
- writes `./matterbridge-elgato/docker-compose.yml` and creates the three data
  directories beside it,
- starts the stack, pulling the image on the first run,
- watches the log for up to 90 seconds and prints the frontend URL, the QR code
  link and the manual pairing code.

Flags:

```
-d, --dir <path>        Where to keep the stack and its data (default: ./matterbridge-elgato)
-i, --interface <nic>   LAN network interface for mDNS (default: auto-detected)
    --image <ref>       Container image (default: ghcr.io/passtas/matterbridge-elgato:latest)
    --frontend-port <n> Matterbridge web frontend port (default: 8283)
-y, --yes               Never prompt; accept the auto-detected answers
    --no-start          Write the files but do not start the stack
    --json              Print a machine-readable summary (for scripts and agents)
-h, --help              Show this help
-v, --version           Show the version
```

Two more commands use the same `--dir`: `npx matterbridge-elgato@latest status`
prints whether the stack is running plus the last pairing code, and
`npx matterbridge-elgato@latest logs` tails the container log. Anything `logs`
does not recognize is passed straight through, so `logs -f` and `logs --tail 200`
work.

A successful run looks like this:

```
matterbridge-elgato setup

✓ Docker 29.1.3
✓ Compose: docker compose (CLI plugin)
✓ Network interface: eth0 (192.168.1.10), because it carries the host's default route
✓ Wrote /home/you/matterbridge-elgato/docker-compose.yml
✓ Data directory /home/you/matterbridge-elgato/data

Starting matterbridge-elgato (this pulls the image on first run)…
Waiting up to 90s for the pairing code…

Matterbridge frontend:  http://192.168.1.10:8283
                        http://localhost:8283 (from this machine)
QR code:                https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT:Y.K90Q1212JLFX5DD00
Manual pairing code:    05671110155

Next steps:
  • Google Home: tap +, then Set up device, Works with Google Home, Matter device. Scan the QR or type the code.
  • Apple Home: tap +, then Add Accessory, then More options (or My device is not shown). Type the code.
  • Alexa: Devices, then +, then Add Device, then Other, then Matter. Type the code.
  • All three can be added at once, because Matter allows multiple admins.
```

For scripts and for coding agents, `--json` prints the same summary as one JSON
object (directory, compose file, image, chosen interface, compose variant,
frontend URL, QR URL, manual pairing code, next steps) and suppresses the human
output. `--no-start` writes the files without starting the stack, which is how
you generate a stack on one machine and copy it to another. It still looks for
Docker, so it reports what the target host would need.

## The compose file

This is exactly what the setup command writes, so you can also skip the command
and write it yourself.

```yaml
# Written by `npx matterbridge-elgato setup`. Safe to edit and re-run.
services:
  matterbridge-elgato:
    image: ghcr.io/passtas/matterbridge-elgato:latest
    container_name: matterbridge-elgato
    # Mandatory: Matter and mDNS both need the host network, and so does the
    # plugin's own _elg._tcp discovery of the Elgato lights.
    network_mode: host
    restart: unless-stopped
    stop_grace_period: 60s
    environment:
      # The LAN interface Matter advertises on. Docker hosts always have several
      # interfaces; naming the right one is what makes the bridge discoverable.
      MDNS_INTERFACE: eth0
      FRONTEND_PORT: "8283"
      TZ: Europe/London
    volumes:
      - ./data/.matterbridge:/root/.matterbridge
      - ./data/Matterbridge:/root/Matterbridge
      - ./data/.mattercert:/root/.mattercert
```

`docker compose up -d`, then open `http://<host-ip>:8283`.

## Updating, and what to back up

In the directory the setup command created:

```bash
docker compose pull && docker compose up -d
```

Re-running `setup` in the same directory is safe, but it does not pull a newer
image on its own, so use the two commands above to update. A plugin installed
into an existing Matterbridge is updated from that frontend's Install plugins
panel instead, followed by a restart.

The three mounted directories under `data/` are everything the bridge remembers:

- `.matterbridge` holds the Matter commissioning data (the fabrics your
  controllers created) and the plugin config. This is the one to back up. Lose it
  and every controller has to pair again.
- `Matterbridge` is the plugin directory, including the pinned device names.
- `.mattercert` holds the frontend's TLS certificates.

Back up `.matterbridge` before any `--factoryreset`.

## NAS notes

The only thing that ever needs attention on a NAS is host networking. If the
container's network mode is bridge, the lights will not be found and the
controllers will not see the bridge.

**Synology (Container Manager).** Add the image
`ghcr.io/passtas/matterbridge-elgato:latest` from the registry, and in the
container's network settings choose the host network rather than the default
bridge. Put the data folder on a shared folder that is not backed by an eSATA or
USB volume, for example `/volume1/docker/matterbridge-elgato/data`, and mount its
three subfolders the way the compose file above does. `MDNS_INTERFACE`
goes in the environment section of the same dialog. Synology boxes usually have
several interfaces, so name the one with the LAN address.

**QNAP (Container Station).** Same shape: pull the image, and in the container's
network settings choose host. Keep the data under a share such as
`/share/Container/matterbridge-elgato/data`. Environment variables are set in the
same creation dialog. Container Station can also import the compose file above,
which is less clicking and easier to redo.

**Unraid.** There is no community template yet. Add the container by hand, set
the network type to host, and add `MDNS_INTERFACE` as a variable. Use
`/mnt/user/appdata/matterbridge-elgato/data` for the three mounts so it lands on
the array like every other appdata folder.

**Raspberry Pi OS (64-bit).** Install Docker Engine from
[docs.docker.com](https://docs.docker.com/engine/install/debian/), then run
`npx matterbridge-elgato@latest setup` and let it do the rest. The interface is
usually `eth0` when wired and `wlan0` on Wi-Fi. Wired is better: the bridge
relays multicast all day. The arm64 image is built in CI but nobody has confirmed
it on real hardware yet, so a report is welcome.
