# Contributing

Reports are as welcome as code here. Half the open questions in this project are
"does it work with your light", and only somebody who owns that light can answer.
There is no CLA. The project is MIT, and a pull request means you are fine with
your contribution going out under it.

## Setup

```bash
git clone https://github.com/passtas/matterbridge-elgato
cd matterbridge-elgato
npm i -g matterbridge      # once per machine
npm ci
npm link matterbridge      # links the global install into node_modules
npm test
```

Matterbridge must never appear in this package's dependencies. The bridge that
loads the plugin at runtime is the one that provides it, so locally it is linked
from the global install instead. Node 20.19 or newer, in one of the ranges
Matterbridge supports: 20, 22, 24 or 26.

## Working without lights

```bash
npm run mock
```

starts a mock Key Light Air on port 9123 and a mock Light Strip on port 9124,
both advertised on `_elg._tcp`, both reproducing the firmware quirks the real
devices have: partial PUT bodies, the Key Light Air storing out-of-range values
instead of clamping them, the Light Strip answering 400, and scenes being
destroyed by any other write. `--mk2` adds a light the plugin is supposed to
skip. The test suite drives the same mock over real HTTP, so most changes need no
hardware at all.

## Live tests

```bash
ELGATO_LIVE=1 \
ELGATO_KEY_LIGHT_HOST=192.168.1.50 \
ELGATO_LIGHT_STRIP_HOST=192.168.1.51 \
npm run test:live
```

No addresses are hard-coded, and the suite skips itself if a variable is missing.
The rule for anything added here: read the light's full state first, and put it
back byte for byte at the end, whatever the test did or however it failed.
Somebody is working under those lights.

## Where the truth lives

`docs/elgato-protocol.md` is what the lights actually do, checked against real
hardware, and `docs/matterbridge-api-cheatsheet.md` is what the Matterbridge API
actually does, checked against the installed package. Where either of them and
your memory of how it should work disagree, they win. Code that looks strange
should cite the section that explains why.

## Commits and pull requests

Commit messages are [conventional
commits](https://www.conventionalcommits.org/en/v1.0.0/): `fix: clamp hue before
writing it`. Lefthook runs the typecheck, the linter and the formatter on staged
files before a commit, and commitlint checks the message. Pull request titles are
checked too, because squash merges become the changelog.

A pull request is ready when:

- `npm run typecheck && npm run lint && npm run format:check && npm test` is
  green,
- new behavior has a test, and a fixed bug has the test that would have caught
  it,
- the change is one thing, described in the body in terms of what a user notices,
- anything surprising in the code says why in a comment, ideally with a pointer
  to the protocol doc.

Open an issue first for anything bigger than a bug fix. A new feature, a new
device type or a change to how devices are identified is worth ten minutes of
agreement before it is worth an afternoon of work.
