# Configuration

Edit the config in the Matterbridge frontend (the plugin row's config button), or
by hand in `matterbridge-elgato.config.json` inside the Matterbridge data
directory. With the Docker stack that is
`./data/.matterbridge/matterbridge-elgato.config.json` in the directory the setup
command created; on a bare install it is
`~/.matterbridge/matterbridge-elgato.config.json`. Restart the plugin after a
hand edit.

| Key                    | Type         | Default               | What it does                                                                                                                                                                                               |
| ---------------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | string       | `matterbridge-elgato` | Plugin name. Set by Matterbridge, hidden in the frontend, do not change it.                                                                                                                                |
| `type`                 | string       | `DynamicPlatform`     | Plugin type. Set by Matterbridge, hidden in the frontend, do not change it.                                                                                                                                |
| `pollInterval`         | number (ms)  | `3000`                | How often each light is polled for state. The firmware has no push API. Minimum 1000.                                                                                                                      |
| `colorDebounce`        | number (ms)  | `400`                 | Controllers send hue and saturation as two commands; they are merged into one write after this delay.                                                                                                      |
| `enableMdns`           | boolean      | `true`                | Browse `_elg._tcp` for lights. Turn off to use only the manual list.                                                                                                                                       |
| `devices`              | array        | `[]`                  | Lights to add by address, for networks where mDNS does not work. Each entry is `{ "host": "…", "name": "…" }`; `host` may include a port, `name` is optional and overrides the name set in the Elgato app. |
| `whiteList`            | string array | `[]`                  | If not empty, only these devices are exposed. Matches a serial or a name.                                                                                                                                  |
| `blackList`            | string array | `[]`                  | These devices are never exposed. Matches a serial or a name.                                                                                                                                               |
| `debug`                | boolean      | `false`               | Verbose logging for this plugin.                                                                                                                                                                           |
| `unregisterOnShutdown` | boolean      | `false`               | Remove every endpoint on shutdown. For testing only.                                                                                                                                                       |

A config with one manual light:

```json
{
  "name": "matterbridge-elgato",
  "type": "DynamicPlatform",
  "pollInterval": 3000,
  "colorDebounce": 400,
  "enableMdns": true,
  "devices": [{ "host": "192.168.1.50", "name": "Desk Key Light" }],
  "whiteList": [],
  "blackList": [],
  "debug": false,
  "unregisterOnShutdown": false
}
```

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
