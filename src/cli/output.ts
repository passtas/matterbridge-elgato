/**
 * Every byte the CLI prints goes through here.
 *
 * `src/` bans `console` (the plugin logs through matterbridge's AnsiLogger), and
 * an injectable writer is what makes the command implementations testable
 * without capturing global stdout.
 */

export type Writer = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export const processWriter: Writer = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** Collects output in memory; used by the tests. */
export function bufferWriter(): Writer & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => {
      lines.push(line);
    },
    err: (line) => {
      errors.push(line);
    },
  };
}
