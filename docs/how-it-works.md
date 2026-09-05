# How it works, and what it cannot do

Everything runs inside [Matterbridge](https://github.com/Luligu/matterbridge),
which presents one bridge to the controllers and gives you a web frontend for the
pairing code, the plugin config and the device list.

![The Matterbridge frontend, showing the plugin row and the two bridged lights](assets/matterbridge-frontend.png)

## How it works

- Lights announce themselves on mDNS as `_elg._tcp`, and the plugin browses for
  them continuously rather than once at startup.
- Each light is filed under the serial number from its own
  `/elgato/accessory-info`, so a changed IP address moves the entry rather than
  creating a second one.
- The Matter device type comes from the shape of the light's state: a light that
  reports a color temperature becomes a ColorTemperatureLight, one that reports
  hue and saturation becomes an ExtendedColorLight. Unknown models are handled by
  what they say, not by a lookup table.
- State is polled every 3 seconds by default, because the firmware has no push
  or subscription API. Commands from a controller are written straight away, not
  on the next tick.
- Every value is clamped before it is sent. The firmware does not clamp: a Key
  Light Air stores an out-of-range color temperature verbatim and desynchronizes,
  and a Light Strip answers HTTP 400 instead.
- The Light Strip loses its running scene the moment anything else is written and
  cannot list its scenes back, so the plugin remembers the last scene it saw and
  replays it when the light is switched back on.

## Limitations

- **Polling, not push.** This generation of firmware has no event API, so a
  change made in Control Center or from a Stream Deck shows up within one poll
  interval, 3 seconds by default.
- **No scene engine in v0.1.** Scenes cannot be listed, created or chosen from a
  controller, because the firmware exposes no endpoint for it. The plugin can
  only put back the scene it last saw. Touching color or brightness from a
  controller destroys the running scene, and that is the device's behavior, not
  the bridge's.
- **Color temperature on the Light Strip is synthesized.** Matter expects an
  ExtendedColorLight to offer the control, but the strip has no white LEDs, so a
  warm or cool request becomes the nearest point on the color wheel. It looks
  close, not calibrated, and the light reports itself back in hue and saturation
  mode a few seconds later.
- **Renaming.** A rename in the Elgato app changes the displayed label but not
  the pinned Matter identity, by design. See [Device names and
  identity](configuration.md#device-names-and-identity) for how to change the
  pinned name.
- **Key Light Air MK.2 is skipped**, along with anything else that answers with
  the TLS transport. See the section below.
- **No battery reporting** for the Key Light Mini yet, no Bluetooth, no firmware
  updates, no Wave audio gear.
- Two writers at once race silently. The device has no version field to detect it
  with.

## Key Light Air MK.2 and newer

The Key Light Air MK.2 (`dt=214`, shipped July 2026) dropped the plain HTTP API.
It still advertises itself on `_elg._tcp` and still listens on port 9123, but the
port now wants a mutual-TLS WebSocket carrying JSON-RPC, and the client has to
present a certificate that chains to Elgato's own root.

What the plugin does today: it spots the MK.2, either from the `tls` key in its
mDNS record or from an HTTP probe that gets connected to and then hung up on, logs
one line naming the light, and leaves it alone. It never hangs on it and never
repeats the line for the same address.

Supporting it properly needs somebody who owns one, because none of it can be
tested otherwise. The protocol notes and a design that keeps Elgato's private
keys out of this repo are in
[#1](https://github.com/passtas/matterbridge-elgato/issues/1). Expect the same
transport on the Elgato lights that follow.
