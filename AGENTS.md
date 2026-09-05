# AGENTS.md

matterbridge-elgato puts Elgato lights on Matter, so Google Home, Apple Home and
Alexa can control them locally, with no cloud account. Two audiences follow; pick
the one you are in.

## Working on the code

Start with `CLAUDE.md`, then `docs/elgato-protocol.md` for the lights and
`docs/matterbridge-api-cheatsheet.md` for the plugin API. Both were checked
against real hardware, so they outrank anything you remember. Never add
`matterbridge` to a dependency list, and never import `@matter/*` or
`@project-chip/*`. A change is done when
`npm run typecheck && npm run lint && npm run format:check && npm test` is green.

## Installing it for a user

Two questions decide everything else. Answer the first yourself, ask the user the
second, and do not run anything until you have both.

**1. Is Matterbridge already running here?** Check, do not guess. If it is, the
install is one click and none of the Docker work below applies.

```sh
docker ps --format '{{.Names}}' | grep -i matterbridge
curl -s -o /dev/null -w '%{http_code}' http://localhost:8283/
```

If a container named `matterbridge` is running, or port 8283 answers, tell the
user you found their Matterbridge and install the plugin there: open the frontend
at `http://<host>:8283`, go to Install plugins, search `matterbridge-elgato`,
install it, restart Matterbridge. It needs Matterbridge 3.10.0 or newer. The
lights appear under the bridge they already paired, so there is no new pairing
step. Skip to the troubleshooting notes at the bottom.

**2. Is this an always-on Linux machine with Docker?** Otherwise you are
installing the bundle, which is Matterbridge and this plugin in one container.
Put this to the user in your own words and wait for the answer:

> This runs best on an always-on Linux box with Docker: a home server, NAS, or
> Raspberry Pi. If you're installing on your laptop or desktop, I'd need to
> install Docker, and the bridge only works while this computer is on. Do you
> want to continue?

Then:

1. Run `npx matterbridge-elgato@latest setup`. It looks for Docker and Compose,
   picks the LAN interface, writes a compose file into `./matterbridge-elgato`,
   starts the stack, and prints the pairing QR code and the manual code. Use
   `--json` for output you can parse, `--no-start` to write the files without
   starting anything, and `-y` to accept every detected answer.

   The host has to be Linux. On macOS or Windows the command stops and explains
   why, and `-y` overrides that check, so do not pass `-y` there: the stack would
   start inside Docker Desktop's VM and never reach the LAN.

2. If Docker is missing, point the user at
   https://docs.docker.com/engine/install/ for their distribution. Do not pipe an
   install script into a shell.

   Host networking means the container binds TCP 8283, UDP 5540 and UDP 5353 on
   the host. `ss -lnup | grep -E ':5540|:5353'` and `ss -lntp | grep :8283`
   show whether something already holds them; if so, go back to question 1.

3. Pair the bridge with the printed code:
   - Google Home: +, Set up device, Works with Google Home, Matter device,
     then scan or type the code.
   - Apple Home: +, Add Accessory, More options (or "My device is not
     shown"), then scan or type the code.
   - Alexa: Devices, +, Add Device, Other, Matter, then scan or type the code.

   All three can be added at once, because Matter allows several admins.

4. Confirm with `npx matterbridge-elgato@latest status`. The lights show up in
   the app within a minute of pairing.

To update the bundle later: `docker compose pull && docker compose up -d` in the
directory `setup` created. Re-running `setup` there is safe but does not pull a
new image.

When something goes wrong:

- Nothing found: the lights and the host have to be on the same LAN, and the
  container needs host networking, which the setup command configures for you.
- A Key Light Air MK.2 is skipped on purpose. It speaks a protocol this plugin
  does not support yet, and the log names the light so you can tell the user.
- Anything else: run `npx matterbridge-elgato@latest logs`, and attach that
  output to an issue at https://github.com/passtas/matterbridge-elgato/issues.
