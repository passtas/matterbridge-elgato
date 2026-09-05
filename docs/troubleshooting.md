# Troubleshooting

**No lights found.** The host and the lights have to be on the same LAN with
multicast allowed between them, which rules out a separate IoT VLAN unless the
router reflects mDNS. On a host with several interfaces, the wrong one is the
usual cause: check `MDNS_INTERFACE` against `ip -br addr`, and run
`docker exec matterbridge-elgato matterbridge --loginterfaces` (or plain
`matterbridge --loginterfaces` on a bare install) for the names Matterbridge
itself sees. If multicast is filtered on your network, skip discovery and list
the addresses directly under `devices` in the config.

**Pairing fails or the controller never finds the bridge.** IPv6 has to be
enabled on the LAN, the container has to be on the host network, and the
controller has to be on the same L2 network as the host. Docker Desktop on macOS
or Windows fails all of this at once, because its host network is a VM's.

**A light shows as unreachable.** The plugin reports a light unreachable after
three failed polls in a row and keeps its endpoint registered, so it comes back
on its own once the light answers again. Check that the light is powered and on
Wi-Fi. A Key Light Mini with energy saving configured to turn its Wi-Fi off
disappears from the network by design.

**Collecting logs.** `npx matterbridge-elgato@latest logs` (add `-f` to follow),
or `docker logs matterbridge-elgato` if you started the container yourself. Turn
on `debug` in the plugin config first if the plain log does not show the problem.
The log includes serial numbers and MAC addresses, so redact what you would
rather not publish before attaching it to an issue.
