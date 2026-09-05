# Matterbridge with matterbridge-elgato pre-installed and self-registering.
#
# The official image ships no plugins ("they will be reinstalled on first run"),
# so ours is baked in from a tarball built by `npm pack`. Registration lives in
# the mounted storage volume, so it is done by entrypoint.sh on first start.
# See deploy/entrypoint.sh.
#
# The build context is `deploy/`, so the tarball has to be moved in first:
#
#   npm run build && npm pack && mv matterbridge-elgato-*.tgz deploy/
#   docker build -t matterbridge-elgato:dev \
#     --build-arg PLUGIN_TARBALL=matterbridge-elgato-0.1.0.tgz deploy
#
# ...which is exactly what deploy/docker-compose.yml and the publish workflow do.
#
FROM luligu/matterbridge:latest

ARG PLUGIN_TARBALL=matterbridge-elgato-0.1.0.tgz
ARG PLUGIN_VERSION=0.1.0

LABEL org.opencontainers.image.title="matterbridge-elgato" \
      org.opencontainers.image.description="Matterbridge with the Elgato light plugin pre-installed: Elgato Key Light, Key Light Air and Light Strip in Google Home, Apple Home and Alexa over Matter" \
      org.opencontainers.image.source="https://github.com/passtas/matterbridge-elgato" \
      org.opencontainers.image.url="https://github.com/passtas/matterbridge-elgato" \
      org.opencontainers.image.documentation="https://github.com/passtas/matterbridge-elgato#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${PLUGIN_VERSION}"

COPY ${PLUGIN_TARBALL} /tmp/plugin.tgz
RUN npm install -g /tmp/plugin.tgz --omit=dev --no-fund --no-audit \
    && rm -f /tmp/plugin.tgz \
    && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/elgato-entrypoint.sh
RUN chmod +x /usr/local/bin/elgato-entrypoint.sh

# The base image's healthcheck hardcodes port 8283; honor FRONTEND_PORT too.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=5 \
    CMD mb_health "http://localhost:${FRONTEND_PORT:-8283}/health"

# Setting ENTRYPOINT resets the inherited CMD to empty (Dockerfile semantics);
# entrypoint.sh builds `matterbridge --docker ...` itself when no command is
# given, and defers to an explicit one when there is.
ENTRYPOINT ["/usr/local/bin/elgato-entrypoint.sh"]
CMD []
