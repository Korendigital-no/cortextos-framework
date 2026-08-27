/**
 * Regression test: node-pty must not leak /dev/ptmx master file descriptors.
 *
 * THE BUG (node-pty <= 1.1.0, macOS only)
 * ---------------------------------------
 * On Darwin, node-pty spawns through `pty_posix_spawn()` in src/unix/pty.cc.
 * Before spawning it opens throwaway ptys to push the real master fd above
 * STDERR_FILENO:
 *
 *     int low_fds[3];
 *     size_t count = 0;
 *     for (; count < 3; count++) {
 *       low_fds[count] = posix_openpt(O_RDWR);
 *       if (low_fds[count] >= STDERR_FILENO)
 *         break;                       // normal case: breaks with count == 0
 *     }
 *
 * and 1.1.0 released them with:
 *
 *     for (; count > 0; count--) {
 *       close(low_fds[count]);         // off-by-one: never closes low_fds[0]
 *     }
 *
 * Two defects compound. The loop indexes `low_fds[count]` instead of
 * `low_fds[count - 1]`, and in the common case (fds 0/1/2 already taken, so
 * the first posix_openpt returns >= 3) the opening loop breaks with count == 0,
 * making `count > 0` false and the cleanup a no-op. Result: exactly one
 * /dev/ptmx master fd leaks per spawn, for the lifetime of the process.
 *
 * This is invisible from JavaScript. The leaked fd is never assigned to
 * `term.fd`, so it is not the one `_socket`/`_writeStream` wrap — calling
 * `IPty.destroy()` (or `kill()`) does not reclaim it. Nothing in this repo
 * could have fixed it; only the upgrade does.
 *
 * WHY IT MATTERS
 * --------------
 * macOS caps concurrent ptys at `kern.tty.ptmx_max` (default 511). The daemon
 * spawns an agent pty per session, so the pool drains at roughly the agent
 * restart rate. Once exhausted, EVERY process on the machine fails to allocate
 * a terminal with ENXIO — editors included. Observed in the wild on
 * 2026-08-25: a daemon up 43 days held 506 of 511 ptys with 8 live children,
 * and VS Code could no longer open a terminal:
 *
 *     The terminal process failed to launch: A native exception occurred
 *     during launch (posix_openpt failed: Device not configured).
 *
 * Upstream fixed the cleanup in the 1.2.0 beta line:
 *
 *     for (size_t i = 0; i <= count; i++) {
 *       close(low_fds[i]);
 *     }
 *
 * FALSIFIABILITY
 * --------------
 * This test was watched to FAIL before it was committed. Against node-pty
 * 1.1.0 the delta grows one per spawn (1, 2, 3, 4, 5 ...); against
 * 1.2.0-beta.15 it stays flat at 0. If this test has never been seen red, it
 * proves nothing — pin node-pty back to 1.1.0 and confirm it fails.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

// The bug and the measurement are both POSIX-specific: `lsof` and /dev/ptmx
// have no Windows equivalent, and ConPTY does not use posix_openpt at all.
const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

function hasLsof(): boolean {
  try {
    execFileSync('which', ['lsof'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count /dev/ptmx master descriptors held by this test process.
 *
 * Uses execFileSync with an argument array (no shell) and filters in JS, so
 * nothing is interpolated into a command string. lsof exits non-zero when it
 * cannot stat every descriptor even though the listing is usable, so partial
 * output is recovered from the thrown error rather than discarded.
 */
function ptmxFdCount(): number {
  let out = '';
  try {
    out = execFileSync('lsof', ['-p', String(process.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    out = (err as { stdout?: string }).stdout ?? '';
  }
  return out.split('\n').filter((line) => line.includes('/dev/ptmx')).length;
}

describe.skipIf(!SUPPORTED || !hasLsof())('node-pty pty master fd lifecycle', () => {
  it('releases every /dev/ptmx fd after the child exits', async () => {
    // Loaded lazily and at runtime so the native addon is only required on
    // platforms where this suite actually runs.
    const pty = require('node-pty');

    const SPAWNS = 8;
    const before = ptmxFdCount();

    for (let i = 0; i < SPAWNS; i++) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`pty #${i + 1} never exited`)),
          5000,
        );
        const p = pty.spawn('/bin/echo', ['pty-fd-leak-probe'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
        });
        // Draining output is required, otherwise the pty can stall on a full
        // buffer and never reach exit.
        p.onData(() => {});
        p.onExit(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // node-pty tears the read socket down on a short internal timer
    // (DESTROY_SOCKET_TIMEOUT_MS = 200), so settle past it before measuring.
    await new Promise((r) => setTimeout(r, 600));

    const after = ptmxFdCount();

    // Tolerate a single descriptor still in flight; the leak this guards
    // against grows linearly (it would be +8 here), so 1 cannot mask it.
    expect(after - before).toBeLessThanOrEqual(1);
  }, 30000);
});
