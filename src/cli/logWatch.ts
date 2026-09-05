/**
 * Reading the pairing code out of Matterbridge's log.
 *
 * Deliberately separated from the process plumbing: the interesting logic is
 * "which line means what", and that is testable against captured log text.
 * Matterbridge prints (verified against 3.10.8):
 *
 *   [Commissioning] Matterbridge is uncommissioned passcode: … manual pairing code: 05671110155
 *   [Matterbridge] QR Code URL: https://project-chip.github.io/…?data=MT:Y.K90Q1212JLFX5DD00
 *   [Matterbridge] Manual pairing code 05671110155 discriminator 3840 …
 */

// Docker log output is ANSI-colored; matching ESC here is the whole point.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

const MANUAL_CODE_PATTERN = /manual pairing code:?\s*(\d{11,})/gi;
const QR_URL_PATTERN = /QR ?code URL:\s*(\S+)/gi;
const COMMISSIONED_PATTERN = /already commissioned/i;

export type PairingInfo = {
  manualPairingCode: string | undefined;
  qrUrl: string | undefined;
  commissioned: boolean;
};

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function lastMatch(pattern: RegExp, text: string): string | undefined {
  pattern.lastIndex = 0;
  let found: string | undefined;
  let match = pattern.exec(text);
  while (match) {
    if (match[1]) found = match[1];
    match = pattern.exec(text);
  }
  return found;
}

/** The most recent pairing details in a chunk of log text. */
export function scanLogs(text: string): PairingInfo {
  const clean = stripAnsi(text);
  return {
    manualPairingCode: lastMatch(MANUAL_CODE_PATTERN, clean),
    qrUrl: lastMatch(QR_URL_PATTERN, clean),
    commissioned: COMMISSIONED_PATTERN.test(clean),
  };
}

/** Nothing more will arrive: either it is paired already, or we have the code. */
export function isPairingComplete(info: PairingInfo): boolean {
  return info.commissioned || (info.manualPairingCode !== undefined && info.qrUrl !== undefined);
}

export type WaitOptions = {
  readLogs: () => string | Promise<string>;
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (attempt: number) => void;
};

export type WaitResult = { info: PairingInfo; timedOut: boolean; attempts: number };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Polls the log until the pairing code shows up or the deadline passes. Polling
 * rather than streaming keeps this a pure function of `readLogs`, which is what
 * makes it testable. `docker logs` is cheap enough to call every second.
 */
export async function waitForPairing(options: WaitOptions): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;

  let attempts = 0;
  let info: PairingInfo = { manualPairingCode: undefined, qrUrl: undefined, commissioned: false };

  for (;;) {
    attempts += 1;
    options.onPoll?.(attempts);
    info = scanLogs(await options.readLogs());
    if (isPairingComplete(info)) return { info, timedOut: false, attempts };
    if (now() >= deadline) return { info, timedOut: true, attempts };
    await sleep(options.pollMs);
  }
}
