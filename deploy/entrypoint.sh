#!/bin/sh
# Entrypoint for the matterbridge-elgato image.
#
# The plugin package is baked into the image, but Matterbridge keeps the list of
# *registered* plugins in its storage directory (/root/.matterbridge), which is a
# mounted volume. So registration cannot happen at build time: it has to happen
# once per data directory, on first start, before Matterbridge itself comes up.
#
# Everything else here is env -> CLI argument plumbing, so that a plain
# `docker run -e MDNS_INTERFACE=eth0` is a complete configuration.
#
#   MDNS_INTERFACE     -> --mdnsinterface <nic>   (strongly recommended on multi-NIC hosts)
#   FRONTEND_PORT      -> --frontend <port>       (default 8283)
#   MATTERBRIDGE_ARGS  -> appended verbatim, word-split (e.g. "--logger debug")
#   PLUGIN_NAME        -> plugin to auto-register (default matterbridge-elgato)
#
# Finally it hands over to the upstream entrypoint (banner + exec "$@") so the
# image behaves exactly like luligu/matterbridge:latest for anything else.
set -eu

PLUGIN_NAME="${PLUGIN_NAME:-matterbridge-elgato}"
UPSTREAM_ENTRYPOINT="${UPSTREAM_ENTRYPOINT:-/matterbridge/entrypoint.latest.sh}"

# `matterbridge --list` prints the registered plugins and exits; on an empty
# storage directory it creates the directory layout and reports "(0)".
if matterbridge --list 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -qE "(^|[[:space:]])${PLUGIN_NAME}([[:space:]:,]|$)"; then
  echo "$PLUGIN_NAME is already registered in this data directory."
else
  echo "$PLUGIN_NAME is not registered in this data directory, registering it now."
  matterbridge --add "$PLUGIN_NAME"
fi

# An explicit command (compose `command:`, `docker run ... <cmd>`) wins over the
# env-built one, so power users keep the upstream escape hatch.
if [ "$#" -eq 0 ]; then
  set -- matterbridge --docker
  if [ -n "${MDNS_INTERFACE:-}" ]; then
    set -- "$@" --mdnsinterface "$MDNS_INTERFACE"
  fi
  if [ -n "${FRONTEND_PORT:-}" ]; then
    set -- "$@" --frontend "$FRONTEND_PORT"
  fi
  if [ -n "${MATTERBRIDGE_ARGS:-}" ]; then
    # Intentionally unquoted: MATTERBRIDGE_ARGS is a whitespace-separated list.
    # shellcheck disable=SC2086
    set -- "$@" $MATTERBRIDGE_ARGS
  fi
fi

echo "Starting: $*"
exec "$UPSTREAM_ENTRYPOINT" "$@"
