/** TTY-vs-piped readline lifecycle: wraps interactive and buffered-stdin modes. */
import { createInterface } from 'node:readline/promises';

/**
 * Opens the readline interface for the entire init session.
 *
 * TTY (interactive): returns a real readline/promises interface that reads
 * directly from stdin — normal behaviour.
 *
 * Non-TTY (pipe / file redirect): pre-reads ALL stdin lines into a buffer
 * BEFORE returning, then returns a mock interface that dispenses answers from
 * the buffer.  This is necessary because readline auto-closes itself when the
 * underlying pipe emits EOF, which happens during the async gap between the
 * "Continue?" confirmation and the first prompt question (the introspect() call).
 * A pre-read buffer is the only reliable way to survive that gap.
 *
 * The returned object exposes:
 *   .question(prompt) → Promise<string>   — compatible with readline/promises
 *   .close()          → void              — no-op or real close
 */
export async function openReadline() {
  if (process.stdin.isTTY) {
    return createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  }

  // Non-TTY: buffer all stdin lines before any async gaps.
  const lines = [];
  await new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin, terminal: false });
    reader.on('line', (line) => lines.push(line));
    reader.on('close', resolve);
  });

  let lineIdx = 0;
  return {
    question: async (prompt) => {
      process.stdout.write(prompt);
      const answer = lines[lineIdx++] ?? '';
      process.stdout.write(answer + '\n');
      return answer;
    },
    close: () => {},
  };
}

