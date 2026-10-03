# Configuration

Edit the config in the Matterbridge frontend (the plugin row's config button), or
by hand in `matterbridge-elgato.config.json` inside the Matterbridge data
directory. With the Docker stack that is
`./data/.matterbridge/matterbridge-elgato.config.json` in the directory the setup
command created; on a bare install it is
`~/.matterbridge/matterbridge-elgato.config.json`. Restart the plugin after a
hand edit.

| Key                    | Type         | Default               | What it does                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | string       | `matterbridge-elgato` | Plugin name. Set by Matterbridge, hidden in the frontend, do not change it.                                                                                                                                                                                                                                                                                 |
| `type`                 | string       | `DynamicPlatform`     | Plugin type. Set by Matterbridge, hidden in the frontend, do not change it.                                                                                                                                                                                                                                                                                 |
| `pollInterval`         | number (ms)  | `3000`                | How often each light is polled for state. The firmware has no push API. Minimum 1000.                                                                                                                                                                                                                                                                       |
| `colorDebounce`        | number (ms)  | `400`                 | Controllers send hue and saturation as two commands; they are merged into one write after this delay.                                                                                                                                                                                                                                                       |
| `enableMdns`           | boolean      | `true`                | Browse `_elg._tcp` for lights. Turn off to use only the manual list. A `.local` host in that list is still looked up over mDNS, which finds no other lights.                                                                                                                                                                                                |
| `preserveSceneOnOff`   | boolean      | `false`               | Light Strip only. Switch off a strip that is playing a scene without wiping the scene from the light. Off by default because it changes what is stored on your light. See [Light Strip scenes](#light-strip-scenes).                                                                                                                                        |
| `devices`              | array        | `[]`                  | Lights to add by address, for networks where mDNS does not work. Each entry is `{ "host": "…", "name": "…" }`; `host` may include a port, `name` is optional and overrides the name set in the Elgato app. `host` can be an IP address or the light's `.local` name, which also works in the Docker image. A light that is off is retried until it answers. |
| `whiteList`            | string array | `[]`                  | If not empty, only these devices are exposed. Matches a serial or a name.                                                                                                                                                                                                                                                                                   |
| `blackList`            | string array | `[]`                  | These devices are never exposed. Matches a serial or a name.                                                                                                                                                                                                                                                                                                |
| `debug`                | boolean      | `false`               | Verbose logging for this plugin.                                                                                                                                                                                                                                                                                                                            |
| `unregisterOnShutdown` | boolean      | `false`               | Remove every endpoint on shutdown. For testing only.                                                                                                                                                                                                                                                                                                        |

A config with one manual light:

```json
{
  "name": "matterbridge-elgato",
  "type": "DynamicPlatform",
  "pollInterval": 3000,
  "colorDebounce": 400,
  "enableMdns": true,
  "preserveSceneOnOff": false,
  "devices": [{ "host": "192.168.1.50", "name": "Desk Key Light" }],
  "whiteList": [],
  "blackList": [],
  "debug": false,
  "unregisterOnShutdown": false
}
```

## Light Strip scenes

A Light Strip playing a scene (Rainbow, say, set in the Elgato app) loses it the
moment it is switched off: the light falls back to the last plain color it had,
and it has no way to list its scenes back. The plugin remembers the last scene it
saw and plays it again on the next on, so from a controller the scene seems to
survive. In between, though, the light itself holds a plain color, and the Elgato
app or anything else that looks at it sees the scene as gone.

`preserveSceneOnOff` closes that gap. With it on, the plugin switches the strip
off by sending the remembered scene back with the light off, and the strip keeps
the scene while it is dark. The next on plays it again as before. An on also puts
the scene back on a strip that is off inside a scene for any other reason, such
as the Elgato app or a restart of the bridge.

If the light refuses the scene, the plugin follows up with a plain off and notes
the refusal in the debug log, so an off isn't lost because the light refused the
scene. If the light doesn't answer at all, the off is logged as a failed change
like any other, and the next poll catches up. While another change to the strip
is still on its way, the plugin sends the plain off instead of the scene.

It is off by default because it changes what is stored on your light, and it
earns a default only after a release of reports from real strips. It does nothing
on Key Lights, which have no scenes, or on a strip showing a plain color.

## Key Light Mini battery

A light that answers `GET /elgato/battery-info` (today only the Key Light Mini)
reports its battery to Matter on the PowerSource cluster, so the controller can
show the charge and raise a low-battery alert. Nothing needs configuring, and
nothing here is configurable yet:

- **Charge level.** Warning below 20 %, Critical below 10 %. Elgato's own
  energy-saving threshold defaults to 15 %, so with energy saving on the light
  dims or drops off Wi-Fi a little after the Warning.
- **How often.** The battery is read on every Nth poll, about every 30 seconds
  whatever `pollInterval` is, so unplugging or plugging the USB-C cable shows up
  within about 30 seconds rather than within one `pollInterval`.
- **Small wobbles are not reported.** The light's own readings jitter between
  reads, so the percentage is only re-reported after a move of 1 % or more (or
  when it crosses 20 % or 10 %, or reaches 0 % or 100 %), and the voltage after
  a move of 20 mV. Charging state and the low-battery level change at once.
- **What is never touched.** The plugin only reads the battery. Energy saving
  and battery bypass stay in Elgato's app.

Each light is asked once, when it is added, whether it has a battery; one that
answers 404 is never asked again. One that does not answer is retried like a
light that is off, and added once it does.

## Device names and identity

Matter identifies a bridged device by a hash of its name, serial number, vendor
and product name, and Matterbridge offers no way to supply that hash directly. So
the plugin pins the input instead: the first name it ever saw for a given serial
is stored in the plugin's own storage directory and keeps being used as the
Matter device name.

The effect is that renaming a light in the Elgato app does not disturb its Matter
identity, and controllers keep the device along with its room and its
automations. The label the controllers display does follow the rename, so the new
name shows up in Google Home and Apple Home on the next pass.

To choose the name yourself, add the light to `devices` with an explicit `name`.
That always wins, and it is what gets pinned, so removing it later keeps the
pinned name rather than reverting to the Elgato one. To start over, delete the
plugin's storage directory inside the Matterbridge storage directory
(`.matterbridge`) and restart Matterbridge. It is one record for every light, so
this also drops the remembered Light Strip scene, and the controllers treat the
lights as new devices.
