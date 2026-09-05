# Matterbridge API cheat sheet

What a contributor (or a coding agent) needs to know about the Matterbridge
plugin API to work on this repo. Verified against Matterbridge 3.10.x while
building this plugin (2026-09-04). Where this file and your memory disagree,
this file wins; where it and the installed `.d.ts` disagree, the `.d.ts` wins.

## 1. Package contract

- **The package name must start with `matterbridge-`.** The frontend's plugin
  search filters an npm registry query by that prefix; the `matterbridge`
  keyword is conventional but is not what the filter uses.
- **Never declare `matterbridge` as a dependency, devDependency or
  peerDependency.** At runtime the plugin is loaded by the running Matterbridge
  instance. Locally, link the global install (§6).
- **Never import `@matter/*` or `@project-chip/*` directly.** That creates a
  second matter.js instance and produces errors like "The only instance is
  Endpoint". Import from `matterbridge`, `matterbridge/matter`,
  `matterbridge/matter/clusters`, `matterbridge/utils`, `matterbridge/logger`.
- ESM only, and `files` must include `<name>.config.json` and
  `<name>.schema.json` – both are read out of the published package root.
- `<name>.schema.json` drives the frontend config form: JSON-Schema plus RJSF-ish
  `ui:widget` hints and a Matterbridge extension `selectFrom` (`"name"` or
  `"serial"`), which turns a field into a dropdown built from whatever the
  platform passed to `setSelectDevice(serial, name)`.
- **Schema `default:` values are never applied to the config.** Config loading
  defaults only `debug` and `unregisterOnShutdown`, and force-overwrites `name`
  and `type`. Every other key must be shipped in `<name>.config.json` *and*
  defaulted in code (`this.config.pollInterval ?? 3000`).
- The live config is `~/.matterbridge/<name>.config.json`; on first run the one
  from the package is copied there.

## 2. Lifecycle

The default export is called by the plugin manager and must return the platform
– `default (matterbridge: PlatformMatterbridge, log: AnsiLogger, config:
PlatformConfig) => MatterbridgePlatform`. Without it the plugin fails to load
with "does not provide a default export".

The first argument is `PlatformMatterbridge`, a readonly data object – not the
Matterbridge class. Useful fields: `matterbridgeVersion` (guard your minimum in
the constructor and throw), `aggregatorVendorId` (pass to the bridged basic
information helper), `matterbridgeDirectory`, `bridgeMode`,
`systemInformation.{interfaceName, ipv4Address, hostname}`.
`MatterbridgeDynamicPlatform` adds only a constructor; everything real lives on
`MatterbridgePlatform`. Hooks:

| hook                  | do this                                                        |
| --------------------- | -------------------------------------------------------------- |
| `onStart(reason?)`    | discover devices, build endpoints, `registerDevice()` them      |
| `onConfigure()`       | seed attributes from a first read, **start timers here**        |
| `onShutdown(reason?)` | **clear every timer**, unregister if `unregisterOnShutdown`     |

The frontend enables/disables plugins repeatedly, so a timer started outside
`onConfigure` or not cleared in `onShutdown` is the classic plugin leak.
`onShutdown` also calls `destroy()`, which empties the platform's own device
registry – `getDevices()` is empty afterwards even though the endpoints are
still on the aggregator. Per-plugin persistent storage is `this.context`, used
here to pin device names across restarts.

## 3. Endpoints

Device types are exported from `matterbridge` itself:
`colorTemperatureLight` is `0x010c`, `extendedColorLight` `0x010d`,
`bridgedNode` `0x0013`, `powerSource` `0x0011`. The two light types have
**identical required clusters** (Identify, Groups, ScenesManagement, OnOff,
LevelControl, ColorControl); the only real difference is what the ColorControl
server advertises in `colorCapabilities`, so device type and ColorControl helper
must agree:

- CCT light (Key Light / Key Light Air): `[colorTemperatureLight, bridgedNode,
  powerSource]` + `createCtColorControlClusterServer(current, physMin, physMax)`.
  **Pass the range explicitly**: Elgato reaches 143 mireds, the helper's default
  `colorTempPhysicalMinMireds` is 147, and that silently clips the coolest part
  of the slider. This helper defaults `colorTemperatureMireds` to 250 while the
  other three ColorControl helpers default to 500.
- Color light (Light Strip): `[extendedColorLight, bridgedNode, powerSource]` +
  `createDefaultColorControlClusterServer()`. It enables XY, HS **and** CT, so
  the endpoint must handle `moveToColorTemperature` even on a device with no
  white channel – an unhandled mandatory command is a dead slider in Google and
  Apple.

The chain is fluent:

```ts
new MatterbridgeEndpoint([colorTemperatureLight, bridgedNode, powerSource], { id: serial }, debug)
  .createDefaultIdentifyClusterServer()
  .createDefaultBridgedDeviceBasicInformationClusterServer(
    deviceName, serial, this.matterbridge.aggregatorVendorId, vendorName, productName)
  .createDefaultOnOffClusterServer()
  .createDefaultLevelControlClusterServer()
  .createCtColorControlClusterServer(200, 143, 344)
  .createDefaultPowerSourceWiredClusterServer()
  .addRequiredClusterServers(); // always last
```

`addRequiredClusterServers()` fills in anything you did not create (servers
only; `addRequiredClusters()` also adds client clusters – not wanted here), and
a basic-information helper must run before `registerDevice()`. Then:

```ts
this.setSelectDevice(serial, deviceName);              // feeds the frontend dropdowns
if (this.validateDevice([deviceName, serial])) await this.registerDevice(endpoint);
```

`MatterbridgeEndpointOptions` is only `{ id, number, tagList, mode }` – there is
no way to supply `uniqueId`. Matterbridge computes it as
`md5(deviceName + serialNumber + vendorName + productName)`, so changing any of
the four makes controllers see a new device and lose its room and automations.
Keep them stable; `nodeLabel` is a plain attribute and is where renames belong.

## 4. Commands and attributes

`addCommandHandler(name, handler)` takes short names: `on`, `off`, `toggle`,
`identify`, `moveToLevel`, `moveToLevelWithOnOff`, `moveToColor`, `moveToHue`,
`moveToSaturation`, `moveToHueAndSaturation`, `moveToColorTemperature`,
`stepColorTemperature`, `stopMoveStep`, … The handler receives one object:
`{ command, request, cluster, attributes, endpoint, context }`, where `cluster`
is a camelCase behavior id string (`"onOff"`, `"levelControl"`,
`"colorControl"`), not a numeric id. Request fields are the Matter ones –
`request.level`, `request.colorTemperatureMireds`, `request.hue`,
`request.saturation`, `request.colorX`/`colorY`.

**Matterbridge applies the commanded attribute itself, after awaiting your
handler.** So a handler should push to the physical device and *not* re-set the
value it was handed. Two consequences: a slow device write stalls the Matter
response (keep timeouts short), and `colorMode`/`enhancedColorMode` is the one
thing not auto-synced – set it on the poll path with
`configureColorControlMode(...)`, never from a handler.

`getAttribute(cluster, attribute)` is **synchronous**. `setAttribute`,
`updateAttribute`, `setCluster` and `triggerEvent` are async.

- `setAttribute` writes unconditionally → use it to seed in `onConfigure`.
- `updateAttribute` deep-compares and returns `false` without writing when the
  value is unchanged → use it in the poll loop, otherwise every tick emits a
  subscription report to every paired fabric.

Scales: `currentLevel` 1–254, `currentHue` 0–254 (for 0–360°),
`currentSaturation` 0–254; `colorTemperatureMireds` is clamped to the physical
min/max you declared.

## 5. Testing

Attributes only work once the endpoint sits on a live server node, so a
hand-rolled Matterbridge mock is not enough. Use the harness Matterbridge ships:

Import `addMatterbridge`, `createServerNode`, `createTestEnvironment`,
`getMatterbridge`, `log`, `setupTest`, `startServerNode` and `stopServerNode`
from `matterbridge/test-utils/vitest`. Order:

`setupTest` → `createTestEnvironment` → `createServerNode(port)` →
`startServerNode()` in `beforeAll`, `stopServerNode()` in `afterAll`; construct
the platform with `getMatterbridge()` and `log`, then `addMatterbridge(platform)`
before `onStart`. Fire commands without a controller via
`endpoint.executeCommandHandler(name, request, cluster, attributes, endpoint)`.
Constraints this forces on `vitest.config.ts`:

`fileParallelism: false` (the harness shares Matterbridge/Matter process state
across files, and a node cannot be created and destroyed per test) and
`server.deps.inline: [/matterbridge/]` (the harness imports `vitest` at runtime
from the *global* Matterbridge install, which cannot resolve it). Pick a Matter
port other than 5540 so a real Matterbridge can keep running.

## 6. Dev workflow

```bash
npm i -g matterbridge      # once per machine, provides the global install
npm link matterbridge      # link it into node_modules (types + runtime)
npm run build
matterbridge -add .        # register this working copy (single dash or double, both work)
matterbridge -bridge       # run; -childbridge pairs each plugin separately
```

Data lives in `~/.matterbridge` (storage, plugin configs, certs), `~/Matterbridge`
(plugin directory) and `~/.mattercert`; `--profile X` nests each under
`profiles/X`, `--homedir` moves the base. Other lifecycle flags: `--remove`,
`--enable`, `--disable`, `--list`; resets (`--reset`, `--factoryreset`) require
Matterbridge to be shut down first. Useful flags: `--logger debug`,
`--mdnsinterface <nic>`, `--loginterfaces`, `--frontend <port>`, `--no-ansi`.
QR and manual pairing codes go to both the log and the frontend at
`http://<host>:8283`. To pair a second controller, use the frontend's
*Paired fabrics* panel → turn pairing mode back on.

## 7. Docker

- Official images are on Docker Hub only: `luligu/matterbridge` (amd64 + arm64).
  `latest` is Matterbridge from npm on a slim Node 24 base; **plugins are not
  baked in** and are reinstalled on first run. `dev` bundles the official
  plugins; `alpine` and `ubuntu` also exist.
- **`network_mode: host` is mandatory** – Matter and mDNS both need it, and so
  does this plugin's `_elg._tcp` discovery.
- Plugins get in via the mounted `~/Matterbridge` volume: install from the
  frontend, or `npm install -g <plugin>` + `matterbridge --add <plugin>` inside
  the container. Registration persists in `~/.matterbridge`.
- An overridden `command` must start with the docker flag, e.g.
  `["matterbridge", "--docker", "--mdnsinterface", "eth0"]`. Changing the
  frontend port or enabling HTTPS breaks the healthcheck – disable it.
- **IPv6 must be enabled on the LAN** (not on the WAN). On a host with several
  external interfaces, set the mDNS interface explicitly.
