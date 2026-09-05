# Building the image from source

This directory builds the container from the working copy. It is the
contributor's path. If you only want to run the bridge, use the published image
and the instructions in the top-level README instead.

Both the standalone `docker-compose` binary and the `docker compose` plugin work.
The commands below use the plugin form.

```bash
# 1. build the plugin tarball from the repo root
npm run build && npm pack && mv matterbridge-elgato-*.tgz deploy/

# 2. build the image and start the stack
cd deploy
MDNS_INTERFACE=eth0 docker compose up -d --build

# 3. open http://<host-ip>:8283 and scan the pairing QR code
```

Run it from this directory rather than with `-f deploy/docker-compose.yml`, or
the override file below is skipped: Compose only picks that up automatically when
it finds the compose file itself in the working directory.

The plugin is baked into the image and the entrypoint registers it on first
start, so there is nothing to run inside the container afterwards.

`MDNS_INTERFACE` names the interface that faces your LAN, which matters as soon
as the host has more than one (docker bridges, VPN interfaces).
`matterbridge --loginterfaces` prints the names Matterbridge sees. `FRONTEND_PORT`
and `TZ` work the same way and both have defaults. Put them in a `.env` file next
to the compose file to avoid typing them every time.

State lives in `deploy/data/`, which is gitignored: `.matterbridge` holds the
Matter commissioning data and the plugin config, `Matterbridge` the plugin
directory, `.mattercert` the frontend TLS certificates. Back up `.matterbridge`
before any `--factoryreset`.

`docker-compose.override.example.yml` is only for replacing the command the
entrypoint builds, for example to add `--logger debug`. Copy it to
`docker-compose.override.yml`, which is gitignored and loaded automatically.
