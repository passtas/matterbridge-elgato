# Elgato local HTTP + mDNS protocol

Characterisation of the Elgato local-control protocol, for the
`elgato-matter-bridge` project.

**Every fact below is tagged with the date it was verified and the device it
was verified on.** Two tags are used:

- `[2026-09-04 · KLA]` – verified live on **Elgato Key Light Air**,
  fw `1.0.3` (build 222), `hardwareBoardType` 200, serial `CW33J1A00001`,
  at `192.168.1.50`.
- `[2026-09-04 · STRIP]` – verified live on **Elgato Light Strip**,
  fw `1.0.4` (build 233), `hardwareBoardType` 70, serial `EW52J1A00002`,
  at `192.168.1.51`.
- `[prior-art]` – not verified here; taken from public reverse-engineering
  (see Sources). Treat as unconfirmed until a device proves it.

Both devices were restored byte-identically to their pre-test state after
characterisation (verified by md5 of `GET /elgato/lights`).

---

## 1. Discovery – mDNS

Service type: **`_elg._tcp.local`**. `[2026-09-04 · KLA, STRIP]`

`avahi-browse -rtp _elg._tcp` output, verbatim:

```
=;eth0;IPv4;Elgato\032Key\032Light\032Air\0321A2B;_elg._tcp;local;elgato-key-light-air-1a2b.local;192.168.1.50;9123;"pv=1.0" "md=Elgato Key Light Air 20LAB9901" "id=3C:6A:9D:00:00:01" "dt=200" "mf=Elgato"
=;eth0;IPv4;Elgato\032Light\032Strip\0323C4D;_elg._tcp;local;elgato-light-strip-3c4d.local;192.168.1.51;9123;"pv=1.0" "md=Elgato Light Strip 20LAA9901" "id=01:C4:63:00:00:02" "dt=70" "mf=Elgato"
```

### Record shape

| Field         | Key Light Air                              | Light Strip                                |
| ------------- | ------------------------------------------ | ------------------------------------------ |
| instance name | `Elgato Key Light Air 1A2B`                | `Elgato Light Strip 3C4D`                  |
| hostname      | `elgato-key-light-air-1a2b.local`          | `elgato-light-strip-3c4d.local`            |
| port          | `9123`                                     | `9123`                                     |
| A             | `192.168.1.50`                             | `192.168.1.51`                             |
| AAAA          | `fe80::3e6a:9dff:fe00:1` (link-local only) | `fe80::3e6a:9dff:fe00:2` (link-local only) |

TXT keys – **all five present on both devices**, same order:

| Key  | KLA                              | STRIP                          | Meaning                            |
| ---- | -------------------------------- | ------------------------------ | ---------------------------------- |
| `pv` | `1.0`                            | `1.0`                          | protocol version                   |
| `md` | `Elgato Key Light Air 20LAB9901` | `Elgato Light Strip 20LAA9901` | model + SKU                        |
| `id` | `3C:6A:9D:00:00:01`              | `01:C4:63:00:00:02`            | see trap below                     |
| `dt` | `200`                            | `70`                           | device type == `hardwareBoardType` |
| `mf` | `Elgato`                         | `Elgato`                       | manufacturer                       |

### Trap: `txt.id` is NOT reliably the MAC address

`[2026-09-04 · KLA, STRIP]` On the Key Light Air, `txt.id` **equals**
`accessory-info.macAddress` (`3C:6A:9D:00:00:01`). On the Light Strip it does
**not**: `txt.id` = `01:C4:63:00:00:02` but `accessory-info.macAddress` =
`3C:6A:9D:00:00:02`. Only the last two octets coincide.

> **Design rule.** Do not key the device registry on `txt.id`. Key it on
> `accessory-info.serialNumber` (`CW33J1A00001` / `EW52J1A00002`) – stable,
> unique, and survives IP and hostname changes. Use `txt.id` only as a
> pre-HTTP dedupe hint.

### Reliability and timing

`[2026-09-04 · KLA, STRIP]` Three consecutive `avahi-browse -rtp _elg._tcp`
runs, one second apart, from the wired server across the Wi-Fi mesh: **3/3 runs
returned both devices**, on both the IPv4 and IPv6 browse sockets. Each run
took **1.01 s** wall clock – that is `-t`'s cache-exhaust timer, i.e. a floor,
not a measurement of how long the devices took to answer. Records were already
in the avahi cache; a cold browse in the bridge should allow ~2–3 s before
concluding a device is absent.

### `dt` / `hardwareBoardType` → model

| `dt`    | Product                     | Source                      |
| ------- | --------------------------- | --------------------------- |
| 53      | Elgato Key Light            | `[prior-art]`               |
| **70**  | **Elgato Light Strip**      | `[2026-09-04 · STRIP]`      |
| **200** | **Elgato Key Light Air**    | `[2026-09-04 · KLA]`        |
| 201     | Elgato Ring Light           | `[prior-art]`               |
| 202     | Elgato Key Light Mini       | `[prior-art]`               |
| 205     | Elgato Key Light MK.2       | `[prior-art]`               |
| 206     | Elgato Light Strip Pro      | `[prior-art]`               |
| 210     | Elgato Key Light Neo        | `[prior-art]`               |
| 214     | Elgato Key Light Air MK.2   | `[prior-art]`               |

The codes above other than 70 and 200 come from `BOARD_TYPES` in
frenck/python-elgato. There is no "Light Strip Neo"; the second strip is the
Light Strip Pro (206). The MK.2 Key Light Air (214) does not speak this HTTP
API at all; it wants mutual TLS on the same port, and the plugin skips it
(`src/elgato/unsupported.ts`).

> **Design rule.** Do not switch on `dt` alone; the table is a naming hint and a
> model that is missing from it still has to work. Probe capability instead:
> `GET /elgato/lights` and look for `hue`/`saturation` (color model → Matter
> ExtendedColorLight) vs `temperature` (CCT model → Matter
> ColorTemperatureLight). Use `dt` only to pick a nicer default name or icon.

---

## 2. Transport

`[2026-09-04 · KLA, STRIP]`

- Plain **HTTP/1.1** on TCP **9123**. No TLS, **no authentication of any kind**.
- Responses always `Content-Type: application/json; charset=utf-8` (even the
  404s, which have `Content-Length: 0`).
- `Connection: keep-alive` is advertised and honored – see latency below.
- The server answers an **HTTP/1.0** request line with an **HTTP/1.1**
  response:
  ```
  $ printf 'GET /elgato/lights HTTP/1.0\r\n\r\n' | nc 192.168.1.50 9123
  HTTP/1.1 200 OK
  Content-Type: application/json; charset=utf-8
  Content-Length: 74
  Connection: keep-alive
  ```
- **The server is effectively single-threaded.** Five concurrent
  `GET /elgato/lights` to the Key Light Air completed in 0.103 / 0.120 / 0.161
  / 0.193 / 0.222 s – a clean ~40 ms serialization ramp, not parallel service.
  `[2026-09-04 · KLA]`

> **Security note.** The unauthenticated surface includes (per `[prior-art]`)
> `POST /elgato/factory-reset`, `POST /elgato/restart`, firmware replacement,
> and an undocumented `POST /elgato/uart` that runs Realtek AT commands.
> Anything that can reach port 9123 owns the device. None of these were
> exercised here.

### Latency

`GET /elgato/lights`, 10 samples each. `[2026-09-04 · KLA, STRIP]`

|               | new TCP connection per request            | 10 requests over one keep-alive connection |
| ------------- | ----------------------------------------- | ------------------------------------------ |
| Key Light Air | min 25 ms · **median 27 ms** · max 125 ms | 15–27 ms total → **~1.5–2.7 ms/req**       |
| Light Strip   | min 49 ms · **median 56 ms** · max 122 ms | 34–52 ms total → **~3.4–5.2 ms/req**       |

> **Design rule.** Connection reuse is worth ~10×. The poll loop must use a
> keep-alive agent (Node: `new http.Agent({ keepAlive: true, maxSockets: 1 })`
> per device – `maxSockets: 1` also matches the device's serial behavior and
> avoids self-inflicted queueing). At a 2–5 s poll interval the cost is
> negligible either way, but command latency is what the user feels.

---

## 3. Endpoint surface

Verified by probing every path on both devices `[2026-09-04 · KLA, STRIP]`:

| Path                          | KLA                            | STRIP                  | Notes                                                                                                                                                                 |
| ----------------------------- | ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /elgato/lights`          | 200 (74 B)                     | 200 (688 B)            | light state                                                                                                                                                           |
| `PUT /elgato/lights`          | 200                            | 200                    | set state; returns full new state                                                                                                                                     |
| `GET /elgato/accessory-info`  | 200 (331 B)                    | 200 (326 B)            | identity + wifi                                                                                                                                                       |
| `PUT /elgato/accessory-info`  | not tested                     | not tested             | sets `displayName` `[prior-art]`                                                                                                                                      |
| `GET /elgato/lights/settings` | 200 (148 B)                    | 200 (166 B)            | power-on defaults                                                                                                                                                     |
| `PUT /elgato/lights/settings` | not tested                     | not tested             | `[prior-art]`                                                                                                                                                         |
| `GET /elgato/battery-info`    | **404**                        | **404**                | Key Light Mini only `[prior-art]`                                                                                                                                     |
| `GET /elgato/identify`        | 404                            | 404                    | POST-only endpoint `[prior-art]`; not exercised                                                                                                                       |
| `GET /elgato/wifi-info`       | 404                            | 404                    | write-only path; Wi-Fi is read via `accessory-info.wifi-info`                                                                                                         |
| `GET /elgato/scenes`          | 404                            | 404                    | does not exist                                                                                                                                                        |
| `GET /elgato/lights/scenes`   | 404                            | 404                    | does not exist                                                                                                                                                        |
| `GET /elgato/display-name`    | 404                            | 404                    | does not exist                                                                                                                                                        |
| `GET /`                       | **200, `text/html`, 86 698 B** | 200, JSON error object | KLA serves a full `<title>Elgato Key Light Setup</title>` HTML page; the Strip returns `{"errors":[{"message":"Request not support","code":-1}]}` **with status 200** |

Additional paths from `[prior-art]`, **not exercised here** (destructive or
irrelevant): `POST /elgato/identify`, `POST /elgato/restart`,
`POST /elgato/factory-reset`, `PUT /elgato/wifi-info` (AES-128-CBC body),
`PUT /elgato/firmware-update/prepare`, `PUT /elgato/firmware-update/data`,
`POST /elgato/firmware-update/execute`, `PUT /elgato/ble/pairing`,
`POST /elgato/uart`.

> **Quirk.** A 404 on this firmware carries `Content-Length: 0` – no error
> body. But a _bad request_ to a real endpoint returns a JSON error object.
> And the Light Strip's `GET /` returns an error object with **HTTP 200**.
> Do not infer success from the status code alone on non-`/elgato/lights`
> paths; parse the body and check for an `errors` key.

### `GET /elgato/accessory-info`

`[2026-09-04 · KLA]` (fixture `test/fixtures/key-light-air-accessory-info.json`):

```json
{
  "productName": "Elgato Key Light Air",
  "hardwareBoardType": 200,
  "hardwareRevision": "1",
  "macAddress": "3C:6A:9D:00:00:01",
  "firmwareBuildNumber": 222,
  "firmwareVersion": "1.0.3",
  "serialNumber": "CW33J1A00001",
  "displayName": "Elgato Key Light Air 1A2B",
  "features": ["lights"],
  "wifi-info": { "ssid": "Example Wi-Fi", "frequencyMHz": 2400, "rssi": -38 }
}
```

`[2026-09-04 · STRIP]` (fixture `test/fixtures/light-strip-accessory-info.json`):

```json
{
  "productName": "Elgato Light Strip",
  "hardwareBoardType": 70,
  "hardwareRevision": "1",
  "macAddress": "3C:6A:9D:00:00:02",
  "firmwareBuildNumber": 233,
  "firmwareVersion": "1.0.4",
  "serialNumber": "EW52J1A00002",
  "displayName": "Elgato Light Strip 3C4D",
  "features": ["lights"],
  "wifi-info": { "ssid": "Example Wi-Fi", "frequencyMHz": 2400, "rssi": -46 }
}
```

Notes:

- `hardwareRevision` came back as the **string** `"1"` on both, not a number.
  `[prior-art]` reports it as a number on other models. Parse loosely.
- `features` is `["lights"]` on both. `[prior-art]`: Key Light Neo reports
  `["lights","bt","hid"]`. Use `features` as the capability probe for
  battery/BT extras.
- `displayName` was non-empty on both here, but `[prior-art]` says it is often
  `""` – fall back to the mDNS instance name.
- **Never PUT to this endpoint from the bridge** unless the user explicitly
  renames a device; it rewrites the name the owner sees in Control Center.

### `GET /elgato/lights/settings`

`[2026-09-04 · KLA]`:

```json
{
  "powerOnBehavior": 1,
  "powerOnBrightness": 20,
  "powerOnTemperature": 213,
  "switchOnDurationMs": 100,
  "switchOffDurationMs": 300,
  "colorChangeDurationMs": 100
}
```

`[2026-09-04 · STRIP]` – note `powerOnHue`/`powerOnSaturation` replace
`powerOnTemperature`, confirming the CCT/color split:

```json
{
  "powerOnBehavior": 1,
  "powerOnHue": 40.0,
  "powerOnSaturation": 15.0,
  "powerOnBrightness": 40,
  "switchOnDurationMs": 150,
  "switchOffDurationMs": 400,
  "colorChangeDurationMs": 150
}
```

`powerOnBehavior`: `1` = restore last state, `2` = use the `powerOn*` defaults
`[prior-art]`. The `switch*DurationMs` / `colorChangeDurationMs` values are the
device-side fade times – they explain why a `PUT` is acknowledged before the
light has visibly finished changing.

---

## 4. `GET /elgato/lights` – state schemas

The envelope is always `{"numberOfLights": N, "lights": [ ... ]}`.
`numberOfLights` was `1` on both devices and is `1` on every shipping product
`[prior-art]`. Treat it as a formality: read `lights[0]`.

There are **three distinct light-object schemas**, and a device switches
between them at runtime.

### 4a. CCT schema (Key Light family)

`[2026-09-04 · KLA]` (fixture `test/fixtures/key-light-air-lights.json`):

```json
{ "numberOfLights": 1, "lights": [{ "on": 1, "brightness": 43, "temperature": 221 }] }
```

| Field         | Type | Range                      | Notes                                                                     |
| ------------- | ---- | -------------------------- | ------------------------------------------------------------------------- |
| `on`          | int  | `0` / `1`                  | integer, **not** a JSON boolean                                           |
| `brightness`  | int  | 0–100                      | device accepts 0; Control Center UI floors at 3                           |
| `temperature` | int  | **mireds**, useful 143–344 | 143 ≈ 7000 K, 344 ≈ 2900 K. **The device does not enforce this** – see §6 |

### 4b. HSV schema (Light Strip, color mode)

`[2026-09-04 · STRIP]` (fixture `test/fixtures/light-strip-lights-hsv.json`):

```json
{
  "numberOfLights": 1,
  "lights": [{ "on": 1, "hue": 200.0, "saturation": 100.0, "brightness": 50 }]
}
```

| Field        | Type  | Range     | Notes                                                                                 |
| ------------ | ----- | --------- | ------------------------------------------------------------------------------------- |
| `on`         | int   | `0` / `1` |                                                                                       |
| `hue`        | float | 0–360     | echoed as float (`200.0`); `360` is accepted and stored as `360.0`, not folded to `0` |
| `saturation` | float | 0–100     | echoed as float                                                                       |
| `brightness` | int   | 0–100     | echoed as the int you sent (`50`), but as a float (`98.0`) in scene mode              |

There is **no `temperature` key** in this schema. `[prior-art]` states
`temperature` must never be sent together with `hue`/`saturation`.

### 4c. Scene schema (Light Strip, scene running)

`[2026-09-04 · STRIP]` (fixture `test/fixtures/light-strip-lights-scene.json`)
– the built-in "Rainbow" scene, captured live. **This schema is not documented
in any public prior art**; `python-elgato` and the Homebridge plugins ignore
scenes entirely.

```json
{
  "numberOfLights": 1,
  "lights": [
    {
      "on": 1,
      "id": "com.corsair.cc.scene.rainbow",
      "name": "Rainbow",
      "brightness": 98.0,
      "numberOfSceneElements": 6,
      "scene": [
        {
          "hue": 0,
          "saturation": 100.0,
          "brightness": 100.0,
          "durationMs": 2000,
          "transitionMs": 10000
        },
        {
          "hue": 60.0,
          "saturation": 100.0,
          "brightness": 100.0,
          "durationMs": 2000,
          "transitionMs": 10000
        },
        {
          "hue": 120.0,
          "saturation": 100.0,
          "brightness": 100.0,
          "durationMs": 2000,
          "transitionMs": 10000
        },
        {
          "hue": 180.0,
          "saturation": 100.0,
          "brightness": 100.0,
          "durationMs": 2000,
          "transitionMs": 10000
        },
        {
          "hue": 240.0,
          "saturation": 100.0,
          "brightness": 100.0,
          "durationMs": 2000,
          "transitionMs": 10000
        },
        {
          "hue": 300.0,
          "saturation": 100.0,
          "brightness": 100.0,
          "durationMs": 2000,
          "transitionMs": 10000
        }
      ]
    }
  ]
}
```

| Field                   | Type   | Notes                                                                                                                       |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | string | reverse-DNS scene id, `com.corsair.cc.scene.*` (Corsair owns Elgato)                                                        |
| `name`                  | string | human label, e.g. `"Rainbow"`                                                                                               |
| `brightness`            | float  | **master** brightness for the whole scene (98.0), distinct from per-element brightness                                      |
| `numberOfSceneElements` | int    | must equal `scene.length`                                                                                                   |
| `scene[]`               | array  | ordered keyframes, looped                                                                                                   |
| `scene[].hue`           | float  | 0–360. Note the first element serialized as int `0`, the rest as floats – the device is inconsistent; always parse as float |
| `scene[].saturation`    | float  | 0–100                                                                                                                       |
| `scene[].brightness`    | float  | 0–100, relative within the scene                                                                                            |
| `scene[].durationMs`    | int    | hold time at this keyframe                                                                                                  |
| `scene[].transitionMs`  | int    | fade time _into_ this keyframe                                                                                              |

> **Detection rule.** `'scene' in lights[0]` → scene mode.
> `'hue' in lights[0]` → HSV mode. `'temperature' in lights[0]` → CCT mode.
> A Light Strip flips between 4b and 4c depending on what was last written,
> so the bridge must re-detect on **every** poll, not once at startup.

---

## 5. `PUT /elgato/lights` – write rules

### Partial bodies are supported and are the intended usage

`[2026-09-04 · KLA]` A body with **no `numberOfLights`** and **only one field**
is accepted; unnamed fields are preserved:

```
PUT /elgato/lights   {"lights":[{"on":0}]}
→ 200 {"numberOfLights":1,"lights":[{"on":0,"brightness":43,"temperature":221}]}

PUT /elgato/lights   {"lights":[{"on":1}]}
→ 200 {"numberOfLights":1,"lights":[{"on":1,"brightness":43,"temperature":221}]}
```

`[2026-09-04 · STRIP]` Same on the strip – `{"lights":[{"on":0}]}` then
`{"lights":[{"on":1}]}` round-tripped `hue`/`saturation`/`brightness` unchanged.

### PUT returns the full new state

`[2026-09-04 · KLA, STRIP]` Every successful `PUT` returns **exactly the body a
subsequent `GET` returns** – verified on every write in this session.

> **Design rule.** Do not `GET` after `PUT` to confirm. Feed the `PUT` response
> straight into the optimistic state update, and let the normal 2–5 s poll
> handle reconciliation with other writers (Control Center, Stream Deck). There
> is no ETag or version field, so concurrent writers race silently.

### Unknown fields are silently ignored

`[2026-09-04 · KLA]` Sending a color field to a CCT-only light does not fail;
the valid fields in the same body still apply:

```
PUT {"lights":[{"hue":200,"brightness":50}]}
→ 200 {"numberOfLights":1,"lights":[{"on":1,"brightness":50,"temperature":5000}]}
```

`hue` vanished; `brightness` took effect.

### Content-Type is not required

`[2026-09-04 · KLA]` The device parses the body regardless of the header:

| Request `Content-Type`      | Result       |
| --------------------------- | ------------ |
| `application/json`          | 200, applied |
| `text/plain`                | 200, applied |
| _(header omitted entirely)_ | 200, applied |

Send `application/json` anyway for hygiene, but no fallback logic is needed.

### Malformed JSON → 400

`[2026-09-04 · KLA]`

```
PUT {"lights":[{"brightness":
→ HTTP/1.1 400 Bad Request
  {"errors":[{"message":"Fail to parse JSON data","code":-1}]}
```

---

## 6. Range validation – **the two models disagree**

This is the single most important finding for the bridge. **The firmware's
range handling is inconsistent across models, and neither model clamps.**

### Key Light Air (fw 1.0.3) – silently ignores bad values, never clamps

`[2026-09-04 · KLA]`

| Written             | HTTP    | Stored    | Behavior                                                                      |
| ------------------- | ------- | --------- | ------------------------------------------------------------------------------ |
| `brightness: 0`     | 200     | **0**     | **accepted**; `on` stayed `1` – brightness 0 does **not** switch the light off |
| `brightness: 101`   | **200** | unchanged | **silently ignored** – no error, echoes the _previous_ value                   |
| `brightness: -1`    | **200** | unchanged | silently ignored                                                               |
| `temperature: 100`  | 200     | **100**   | **accepted verbatim** (below the 143 physical minimum)                         |
| `temperature: 400`  | 200     | **400**   | **accepted verbatim** (above the 344 physical maximum)                         |
| `temperature: 5000` | 200     | **5000**  | **accepted verbatim** – `temperature` is not validated _at all_                |

### Light Strip (fw 1.0.4) – rejects bad values with HTTP 400

`[2026-09-04 · STRIP]`

| Written                       | HTTP    | Body                                                           |
| ----------------------------- | ------- | -------------------------------------------------------------- |
| `hue: 400`                    | **400** | `{"errors":[{"message":"Fail to parse JSON data","code":-1}]}` |
| `saturation: 101`             | **400** | same                                                           |
| `brightness: 101`             | **400** | same                                                           |
| `hue: 360`, `saturation: 100` | 200     | accepted, stored as `360.0` / `100.0`                          |

> **Quirk.** The Strip reports an _out-of-range value_ with the same
> `"Fail to parse JSON data"` message it uses for _syntactically broken JSON_.
> A 400 from this device therefore means "bad request" generically – you cannot
> distinguish a range error from a parse error by the message.

### The clamps you asked about: there are none. Clamp client-side.

**There is no device-side clamping on either model.** The Key Light Air happily
stores `temperature: 5000`; the Light Strip 400s rather than clamping. So:

> **Design rule – non-negotiable.** The bridge must clamp _every_ value before
> it leaves the process:
>
> - `brightness` → clamp to **3–100** (0 is legal but leaves the light "on" at
>   zero output, which desynchronizes Matter OnOff; never emit 0)
> - `temperature` → clamp to **143–344** mireds
> - `hue` → clamp to **0–360**
> - `saturation` → clamp to **0–100**
>
> Clamping is what makes the two firmwares behave identically. Without it, a
> Matter controller that sends an out-of-range color temperature will either
> silently do nothing (Key Light Air) or throw a 400 (Strip).

---

## 7. On/off vs level – can Matter OnOff be independent of Level?

**Yes on both models.** `[2026-09-04 · KLA, STRIP]`

- `{"lights":[{"on":0}]}` → `{"on":0,"brightness":43,"temperature":221}`
- `{"lights":[{"on":1}]}` → `{"on":1,"brightness":43,"temperature":221}`

`brightness`, `temperature`, `hue` and `saturation` all survive an off→on
cycle. The device stores the level independently of the power state, exactly
as Matter's OnOff and LevelControl clusters expect.

**`brightness: 0` does NOT switch the light off.** `[2026-09-04 · KLA]` It is
accepted and stored, and `on` remains `1`. Map Matter OnOff to the `on` field
only, and never let a Level command emit `brightness: 0` – floor it at 3.

---

## 8. Light Strip scene behavior

`[2026-09-04 · STRIP]` All four transitions were exercised live.

**A color write destroys the running scene.** Starting from the Rainbow scene:

```
PUT {"lights":[{"on":1,"hue":200,"saturation":100,"brightness":50}]}
→ 200 {"numberOfLights":1,"lights":[{"on":1,"hue":200.0,"saturation":100.0,"brightness":50}]}
```

The response – and the subsequent `GET` – contain **no `scene`, `id`, `name`
or `numberOfSceneElements` keys at all**. The object does not merely gain HSV
fields; it switches wholesale from schema 4c to schema 4b.

**Turning the light off also destroys the scene.** Starting from Rainbow again:

```
PUT {"lights":[{"on":0}]}
→ 200 {"numberOfLights":1,"lights":[{"on":0,"hue":360.0,"saturation":100.0,"brightness":50}]}
```

The scene is gone and the device reverted to the _previous HSV_ state. So a
plain Matter Off command on a scene-running strip is destructive.

**Re-entering a scene: PUT the whole scene object back. `on` is not required.**

```
PUT {"numberOfLights":1,"lights":[{"id":"com.corsair.cc.scene.rainbow","name":"Rainbow",
     "brightness":98.0,"numberOfSceneElements":6,"scene":[ ...6 elements... ]}]}   ← no "on" key
→ 200 {"numberOfLights":1,"lights":[{"on":1,"id":"com.corsair.cc.scene.rainbow", ...}]}
```

The scene resumed and the device **set `on:1` itself**. Writing a scene
implicitly powers the light on. Including `on:1` explicitly also works (that
is how the final restore was performed).

There is no endpoint that lists available scenes (`/elgato/scenes` and
`/elgato/lights/scenes` are both 404). The only way to obtain a scene object is
to read one that is already running.

> **Design rule (v1 scope).** v1 exposes on/off, brightness and color, so it
> will inevitably clobber a running scene the first time the user touches the
> strip from Google Home – this is unavoidable, the firmware offers no
> "restore scene" primitive. Mitigation: on every poll, if schema 4c is seen,
> **cache the full scene object keyed by serial**. That gives a future v2 a
> "resume last scene" action (a Matter momentary switch, or a Matter scene) for
> free, and lets the bridge restore the pre-bridge state on shutdown.

---

## 9. Mapping to Matter

Device-type selection, by capability probe (see §1):

| Elgato                                                                    | Matter device type                   |
| ------------------------------------------------------------------------- | ------------------------------------ |
| Key Light, Key Light Air, Key Light Mini/Neo, Ring Light (CCT, schema 4a) | **ColorTemperatureLight** (`0x010C`) |
| Light Strip (color, schema 4b/4c)                                        | **ExtendedColorLight** (`0x010D`)    |

### OnOff cluster

`on: 1` ⇄ `OnOff = true`. Direct, no arithmetic. Never derive on/off from
brightness (§7).

### LevelControl – brightness 3–100 ⇄ CurrentLevel 1–254

Matter reserves `CurrentLevel = 0`, so the usable range is 1–254. Anchor it to
Elgato's _usable_ 3–100 (see §6 on why 0 is excluded).

```ts
// Elgato brightness (3..100 int) -> Matter CurrentLevel (1..254)
const toMatterLevel = (b: number): number =>
  clamp(Math.round(1 + ((clamp(b, 3, 100) - 3) * 253) / 97), 1, 254);

// Matter CurrentLevel (1..254) -> Elgato brightness (3..100 int)
const toElgatoBrightness = (lvl: number): number =>
  clamp(Math.round(3 + ((clamp(lvl, 1, 254) - 1) * 97) / 253), 3, 100);
```

Round-trip check: `3 → 1 → 3`; `100 → 254 → 100`; `50 → 124 → 50`;
`43 → 105 → 43`. **Verified exhaustively: all 98 values 3–100 round-trip
exactly** under `Math.round`. The reverse direction is necessarily lossy (254
Matter levels collapse into 98 device values), so always treat the device value
as authoritative when reconciling a poll against a pending optimistic update –
otherwise a Level command will appear to "snap".

### ColorControl – color temperature: mireds map 1:1

Elgato's `temperature` is already in **mireds**, the same unit as Matter's
`ColorTemperatureMireds`. No conversion – only clamping.

```ts
const toMatterMireds = (t: number) => clamp(Math.round(t), 143, 344);
const toElgatoTemp = (m: number) => clamp(Math.round(m), 143, 344);
```

Set the Matter attributes to advertise the real capability:

```
ColorTempPhysicalMinMireds = 143   // ≈ 7000 K
ColorTempPhysicalMaxMireds = 344   // ≈ 2900 K
```

> Kelvin is **not** exactly `1e6 / mired` on this hardware – 143 mireds is
> nominally 7000 K (6993 by the formula) and 344 is nominally 2900 K (2907),
> and prior art warns the device's internal curve is non-linear in between.
> Stay in mireds end to end and the discrepancy never arises. Google and Apple
> both clamp CT to the advertised physical range, so advertising 143–344
> honestly is what keeps their UI sliders sane.

### ColorControl – hue: 0–360 ⇄ CurrentHue 0–254

Matter encodes a full 360° turn in 0–254 (8-bit, 255 reserved).

```ts
// Elgato hue (0..360 float) -> Matter CurrentHue (0..254)
const toMatterHue = (h: number): number =>
  clamp(Math.round(((clamp(h, 0, 360) % 360) * 254) / 360), 0, 254);

// Matter CurrentHue (0..254) -> Elgato hue (0..360 float, 1 decimal)
const toElgatoHue = (h: number): number => round1((clamp(h, 0, 254) * 360) / 254);
```

Round-trip check: `200 → 141 → 199.8`; `0 → 0 → 0`; `360 → 0 → 0`.

> **Note the `% 360`.** The device stores `hue: 360.0` verbatim
> `[2026-09-04 · STRIP]` rather than folding it to 0, so a naive
> `360 * 254/360 = 254` would map red to the wrong end of the wheel. Fold
> before scaling. On the way back, prefer emitting `0` over `360`.
>
> Resolution loss is real: 254 Matter steps over 360° ≈ **1.42°/step**, giving
> a **maximum round-trip error of 0.7°** (verified over all integer degrees).
> A user who sets hue 200 in Control Center reads back 199.8 through the
> bridge. Acceptable – it is inherent to Matter's 8-bit hue encoding.

### ColorControl – saturation: 0–100 ⇄ CurrentSaturation 0–254

```ts
// Elgato saturation (0..100 float) -> Matter CurrentSaturation (0..254)
const toMatterSat = (s: number): number =>
  clamp(Math.round((clamp(s, 0, 100) * 254) / 100), 0, 254);

// Matter CurrentSaturation (0..254) -> Elgato saturation (0..100 float, 1 decimal)
const toElgatoSat = (s: number): number => round1((clamp(s, 0, 254) * 100) / 254);
```

Round-trip check: `100 → 254 → 100`; `0 → 0 → 0`; `15 → 38 → 15`;
`50 → 127 → 50`. Verified: every integer 0–100 round-trips within 0.5.

### Mode exclusivity

`[prior-art]`, consistent with the schemas observed here: **never send
`temperature` in the same body as `hue`/`saturation`.** On an
ExtendedColorLight, honor Matter's `ColorMode` attribute: when the controller
commands color temperature, emit only `temperature`; when it commands hue/sat,
emit only `hue` + `saturation`. (Observed corollary: the Light Strip has no
`temperature` field at all and its settings object carries
`powerOnHue`/`powerOnSaturation` instead of `powerOnTemperature`.)

### Shared helpers

```ts
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
```

---

## 10. Quirk summary (bridge checklist)

1. Key the registry on `accessory-info.serialNumber`, **not** mDNS `txt.id` –
   the Strip's `txt.id` is not its MAC. `[2026-09-04 · STRIP]`
2. Clamp every value client-side. Neither firmware clamps; the Key Light Air
   stores nonsense verbatim, the Strip 400s. `[2026-09-04 · KLA, STRIP]`
3. Never emit `brightness: 0` – it does not turn the light off, it just
   desyncs OnOff from reality. `[2026-09-04 · KLA]`
4. Use the `PUT` response as the new state; do not re-`GET`. `[2026-09-04 · KLA, STRIP]`
5. Use one keep-alive socket per device (`maxSockets: 1`) – ~10× faster and the
   device serializes concurrent requests anyway. `[2026-09-04 · KLA]`
6. Re-detect the light schema on every poll; a Strip flips between HSV and
   scene mode behind the bridge's back. `[2026-09-04 · STRIP]`
7. Cache any scene object seen, keyed by serial – the first bridge write
   destroys it and nothing can list scenes back. `[2026-09-04 · STRIP]`
8. `on` is the integer `0`/`1`, never a JSON boolean. `[2026-09-04 · KLA, STRIP]`
9. Parse numbers loosely: the same field arrives as `0` and `60.0` in one
   array; `brightness` is int in HSV mode and float in scene mode;
   `hardwareRevision` is a string. `[2026-09-04 · STRIP, KLA]`
10. Do not trust status codes outside `/elgato/lights`: the Strip returns an
    error object with HTTP 200 on `GET /`. `[2026-09-04 · STRIP]`
11. There is no push/event API – poll, and pair polling with optimistic
    updates from `PUT` responses.

---

## Fixtures

Captured live 2026-09-04, raw device output, in `test/fixtures/`:

| File                                 | Source                                            |
| ------------------------------------ | ------------------------------------------------- |
| `key-light-air-accessory-info.json`  | `GET /elgato/accessory-info` @ 192.168.1.50       |
| `key-light-air-lights.json`          | `GET /elgato/lights` (CCT schema 4a)              |
| `key-light-air-lights-settings.json` | `GET /elgato/lights/settings`                     |
| `light-strip-accessory-info.json`    | `GET /elgato/accessory-info` @ 192.168.1.51       |
| `light-strip-lights-scene.json`      | `GET /elgato/lights` (scene schema 4c, "Rainbow") |
| `light-strip-lights-hsv.json`        | `GET /elgato/lights` (HSV schema 4b)              |
| `light-strip-lights-settings.json`   | `GET /elgato/lights/settings`                     |
| `mdns-txt-records.json`              | `avahi-browse -rtp _elg._tcp` + `avahi-resolve`   |

---

## Sources for `[prior-art]` claims

- [frenck/python-elgato](https://github.com/frenck/python-elgato) – the Home
  Assistant client; most complete public model (no scene support).
- [schlarpc/elgato-key-light-mini-firmware-re](https://github.com/schlarpc/elgato-key-light-mini-firmware-re)
  – firmware reverse engineering, `docs/03-http-api.md`.
- [adamesch/elgato-key-light-api](https://github.com/adamesch/elgato-key-light-api)
- [zunderscore/elgato-light-control](https://github.com/zunderscore/elgato-light-control)
- [derjayjay/homebridge-keylights](https://github.com/derjayjay/homebridge-keylights)

---

## Addendum – findings during implementation (2026-09-04, evening)

Two behaviors discovered while building `matterbridge-elgato` against the same
two devices. Both were verified live and both changed the implementation.

### The Light Strip truncates fractional `hue` and `saturation`

`[2026-09-04 · STRIP]`

```
PUT {"lights":[{"hue":123.7,"saturation":50.5,"brightness":50}]}
→ 200 {"numberOfLights":1,"lights":[{"on":0,"hue":123.0,"saturation":50.0,"brightness":50}]}
```

The fraction is discarded, not rounded. §9's `round1` therefore *loses* a step:
Matter hue 141 → 199.8 → stored 199.0 → read back as Matter hue 140.

> **Revised design rule.** Emit **whole** degrees and percent, via `Math.round`.
>
> Note what this can and cannot buy. Matter's 8-bit encodings are coarser than the
> device's own units in one direction and finer in the other, so:
>
> - **Device → Matter → device is exact** for both quantities: every integer
>   saturation 0–100 and every integer degree 0–359 comes back unchanged.
> - **Matter → device → Matter cannot be exact for saturation**: 255 Matter steps
>   cannot survive a trip through 101 device values – 154 of the 255 come back
>   changed (the first is 1, which returns as 0). The error is bounded at
>   **one step**, measured exhaustively.
> - **Matter → device → Matter is exact for hue** on 0–253 (254 steps into 360
>   degrees is a widening), with the wrap at 254 the only exception. Round-trip
>   error on the degree side is **≤ 1°**.
>
> `toElgatoHue` also takes `% 360` so the wrap emits `0` rather than `360`, which
> the firmware would store verbatim.

### `on: 0` sent *in the same body* as a scene is honored and keeps the scene

`[2026-09-04 · STRIP]` §8 says a plain `{"lights":[{"on":0}]}` destroys a running
scene – still true. But the scene object itself accepts an explicit `on`:

```
PUT {"lights":[{"on":0,"id":"com.corsair.cc.scene.rainbow", ... 6 elements ...}]}
→ 200 {"numberOfLights":1,"lights":[{"on":0,"id":"com.corsair.cc.scene.rainbow", ...}]}
```

The device parks itself off **with the scene intact**, and a subsequent `GET`
still returns schema 4c. (A bare `{"on":1}` from that state does *not* resume it:
it reverts to the previous HSV object, as §8 describes for the off direction.)

> **Consequence.** A scene-preserving "off" is possible: re-PUT the cached scene
> with `on: 0`. `matterbridge-elgato` v0.1.0 does not do this – it sends the plain
> `{on: 0}` and replays the cached scene on the next `on`, which the user sees as
> the same thing – but it is what makes a byte-exact restore of a
> parked-in-a-scene strip possible, and `test/live.test.ts` relies on it.
