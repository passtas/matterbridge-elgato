# matterbridge-elgato

A Matterbridge plugin that puts Elgato lights (Key Light, Key Light Air, Light
Strip) on Matter, so Google Home, Apple Home and Alexa can drive them locally.
Read `AGENTS.md` too: it adds the install procedure to follow when a user asks
you to set the bridge up for them.

Commands that matter:

- `npm test` runs vitest against mock devices; `npm run mock` starts those mocks
  by hand on ports 9123 and 9124, and `--mk2` adds a light the plugin skips.
- `ELGATO_LIVE=1 ELGATO_KEY_LIGHT_HOST=192.168.1.50 ELGATO_LIGHT_STRIP_HOST=192.168.1.51 npm run test:live`
  drives real lights and puts their state back afterwards.
- `npm run link && npm run add && npm run dev` runs the plugin inside a real
  Matterbridge on this machine.

Two rules never worth breaking: never add `matterbridge` to any dependency list
(install it globally and `npm link` it, the running bridge is what loads this
plugin), and never import `@matter/*` or `@project-chip/*`, because a second
matter.js instance breaks everything. Import from `matterbridge`,
`matterbridge/matter*`, `matterbridge/utils` and `matterbridge/logger`.
TypeScript runs on Node without a build step, so imports keep their `.ts`
extension and the code avoids enums and parameter properties.

`docs/elgato-protocol.md` (the lights) and `docs/matterbridge-api-cheatsheet.md`
(the plugin API) were both checked against real hardware and the installed
package. Where they and your memory disagree, they win, and code that looks odd
should cite the section that explains it.

Done means `npm run typecheck && npm run lint && npm run format:check && npm test`,
all green.
