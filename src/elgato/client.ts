/**
 * HTTP client for one Elgato light. Plain HTTP/1.1 on port 9123, no auth.
 * See docs/elgato-protocol.md §2 to §5.
 */

import type {
  AccessoryInfo,
  ElgatoErrorBody,
  LightPatch,
  LightsResponse,
  LightsSettings,
} from "./types.ts";

export const ELGATO_PORT = 9123;
export const DEFAULT_TIMEOUT_MS = 5000;

export interface ElgatoHttpErrorOptions {
  body?: string;
  /** See `ElgatoHttpError.emptyReply`. */
  emptyReply?: boolean;
}

export class ElgatoHttpError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  readonly body: string | undefined;
  /**
   * The connection opened and was then closed without an HTTP reply. That is how an
   * MK.2 light looks from here, because it wants a TLS handshake on this port
   * (src/elgato/unsupported.ts). An offline light times out or refuses instead.
   */
  readonly emptyReply: boolean;

  constructor(message: string, status: number, options: ElgatoHttpErrorOptions = {}) {
    super(message);
    this.name = "ElgatoHttpError";
    this.status = status;
    this.body = options.body;
    this.emptyReply = options.emptyReply === true;
  }
}

/**
 * Undici's code for "the other side closed before any HTTP response arrived". A light
 * that is merely offline times out or refuses the connection instead, which is why
 * only this one code counts as an empty reply.
 */
const EMPTY_REPLY_CODE = "UND_ERR_SOCKET";

const isEmptyReply = (error: unknown): boolean =>
  (error as { cause?: { code?: unknown } }).cause?.code === EMPTY_REPLY_CODE;

/** A response body carrying an `errors` array. */
const hasErrorBody = (body: unknown): body is ElgatoErrorBody =>
  typeof body === "object" && body !== null && Array.isArray((body as ElgatoErrorBody).errors);

/**
 * Split a `host`, `host:port`, `[v6]:port` or bare IPv6 literal into its parts.
 * Devices always answer on 9123; an explicit port is only useful behind a forward
 * (and is what the tests point at the mock server with).
 */
export const parseHost = (value: string): { host: string; port: number | undefined } => {
  const bracketed = /^\[(?<host>.+)\](?::(?<port>\d+))?$/u.exec(value);
  if (bracketed?.groups) {
    const { host, port } = bracketed.groups;
    return { host: host as string, port: port === undefined ? undefined : Number(port) };
  }
  const parts = value.split(":");
  if (parts.length === 2 && /^\d+$/u.test(parts[1] as string)) {
    return { host: parts[0] as string, port: Number(parts[1]) };
  }
  return { host: value, port: undefined };
};

export interface ElgatoClientOptions {
  port?: number;
  timeoutMs?: number;
}

export class ElgatoClient {
  #host: string;
  readonly port: number;
  readonly timeoutMs: number;

  constructor(host: string, options: ElgatoClientOptions = {}) {
    this.#host = host;
    this.port = options.port ?? ELGATO_PORT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get host(): string {
    return this.#host;
  }

  /** Devices change IP on DHCP renewal; the device record follows them in place. */
  set host(host: string) {
    this.#host = host;
  }

  get baseUrl(): string {
    // IPv6 literals need brackets in a URL authority.
    const authority =
      this.#host.includes(":") && !this.#host.startsWith("[") ? `[${this.#host}]` : this.#host;
    return `http://${authority}:${this.port}`;
  }

  async #request<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      // Never send an `Origin` header. Firmware 1.0.4.206 answers 403 to any request
      // carrying one, which is how Elgato fixed CVE-2025-7202 (a browser tab on the
      // same LAN driving the lights). Node's fetch adds none, so do not add one here.
      response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ElgatoHttpError(`${method} ${url} failed: ${(error as Error).message}`, 0, {
        emptyReply: isEmptyReply(error),
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ElgatoHttpError(`${method} ${url} returned ${response.status}`, response.status, {
        body: text,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ElgatoHttpError(`${method} ${url} returned a non-JSON body`, response.status, {
        body: text,
      });
    }

    // Status codes are not enough outside /elgato/lights: the Strip answers
    // `GET /` with an error object and HTTP 200 (docs/elgato-protocol.md §3).
    if (hasErrorBody(parsed)) {
      const message = parsed.errors.map((entry) => entry.message).join("; ");
      throw new ElgatoHttpError(
        `${method} ${url} returned an error body: ${message}`,
        response.status,
        { body: text },
      );
    }

    return parsed as T;
  }

  getAccessoryInfo(): Promise<AccessoryInfo> {
    return this.#request<AccessoryInfo>("GET", "/elgato/accessory-info");
  }

  getLights(): Promise<LightsResponse> {
    return this.#request<LightsResponse>("GET", "/elgato/lights");
  }

  getLightsSettings(): Promise<LightsSettings> {
    return this.#request<LightsSettings>("GET", "/elgato/lights/settings");
  }

  /**
   * Partial bodies are the intended usage: unnamed fields are preserved and the
   * response is exactly what a following GET would return, so never GET to confirm.
   */
  putLights(patch: LightPatch): Promise<LightsResponse> {
    return this.#request<LightsResponse>("PUT", "/elgato/lights", {
      numberOfLights: 1,
      lights: [patch],
    });
  }
}
