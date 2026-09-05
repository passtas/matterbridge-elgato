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

Ask this first, before running anything, and wait for the answer:

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
3. Pair the bridge with the printed code:
   - Google Home: Devices, +, Matter device, then scan or type the code.
   - Apple Home: +, Add Accessory, More options, then scan or type the code.
   - Alexa: Devices, +, Add Device, Other, Matter, then scan or type the code.

   All three can be added at once, because Matter allows several admins.

4. Confirm with `npx matterbridge-elgato@latest status`. The lights show up in
   the app within a minute of pairing.

When something goes wrong:

- Nothing found: the lights and the host have to be on the same LAN, and the
  container needs host networking, which the setup command configures for you.
- A Key Light Air MK.2 is skipped on purpose. It speaks a protocol this plugin
  does not support yet, and the log names the light so you can tell the user.
- Anything else: run `npx matterbridge-elgato@latest logs`, and attach that
  output to an issue at https://github.com/passtas/matterbridge-elgato/issues.
