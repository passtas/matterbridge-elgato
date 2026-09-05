/**
 * The Compose file the CLI writes. Rendered by hand rather than with a YAML
 * library: the shape is fixed, and the CLI takes no runtime dependencies.
 */

export const SERVICE_NAME = "matterbridge-elgato";

export type ComposeOptions = {
  image: string;
  interfaceName: string;
  frontendPort: number;
  timezone: string;
};

/** The three directories Matterbridge persists into, mounted from `./data`. */
export const DATA_DIRECTORIES = [".matterbridge", "Matterbridge", ".mattercert"] as const;

export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function renderCompose(options: ComposeOptions): string {
  return `# Written by \`npx matterbridge-elgato setup\`. Safe to edit and re-run.
services:
  ${SERVICE_NAME}:
    image: ${options.image}
    container_name: ${SERVICE_NAME}
    # Mandatory: Matter and mDNS both need the host network, and so does the
    # plugin's own _elg._tcp discovery of the Elgato lights.
    network_mode: host
    restart: unless-stopped
    stop_grace_period: 60s
    environment:
      # The LAN interface Matter advertises on. Docker hosts always have several
      # interfaces; naming the right one is what makes the bridge discoverable.
      MDNS_INTERFACE: ${options.interfaceName}
      FRONTEND_PORT: "${options.frontendPort}"
      TZ: ${options.timezone}
    volumes:
      - ./data/.matterbridge:/root/.matterbridge
      - ./data/Matterbridge:/root/Matterbridge
      - ./data/.mattercert:/root/.mattercert
`;
}
