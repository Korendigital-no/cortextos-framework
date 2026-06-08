import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDedup, KEYS, injectMessage } from '../../../src/pty/inject';

describe('MessageDedup', () => {
  it('detects duplicate content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('hello world')).toBe(false);
    expect(dedup.isDuplicate('hello world')).toBe(true);
  });

  it('allows different content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('message 1')).toBe(false);
    expect(dedup.isDuplicate('message 2')).toBe(false);
  });

  it('evicts old entries', () => {
    const dedup = new MessageDedup(3);
    dedup.isDuplicate('msg1');
    dedup.isDuplicate('msg2');
    dedup.isDuplicate('msg3');
    dedup.isDuplicate('msg4'); // evicts msg1
    expect(dedup.isDuplicate('msg1')).toBe(false); // no longer in cache
    expect(dedup.isDuplicate('msg4')).toBe(true); // still in cache
  });
});

describe('KEYS', () => {
  it('has correct escape sequences', () => {
    expect(KEYS.ENTER).toBe('\r');
    expect(KEYS.CTRL_C).toBe('\x03');
    expect(KEYS.DOWN).toBe('\x1b[B');
    expect(KEYS.UP).toBe('\x1b[A');
    expect(KEYS.SPACE).toBe(' ');
  });
});

describe('injectMessage — deferred Enter crash safety', () => {
  // Regression guard for the 2026-04-22 storm. worker-process.ts:93 passed
  // an unsafe `this.pty!.write` callback; when PTY was torn down during the
  // 300ms enterDelay window the setTimeout fired null.write → uncaught
  // TypeError → daemon crash. The fix wraps the deferred write in try/catch.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('swallows throw from the deferred Enter callback without crashing', async () => {
    const writes: string[] = [];
    // Caller's write is "safe" during the synchronous paste but starts
    // throwing by the time the deferred Enter fires — simulates PTY teardown.
    let ptyAlive = true;
    const write = (data: string) => {
      if (!ptyAlive) throw new TypeError("Cannot read properties of null (reading 'write')");
      writes.push(data);
    };

    // The paste happens synchronously; the promise resolves after the Enter
    // delay (injectMessage is async since the 2026-06-07 dispatch-bug fix).
    const pending = injectMessage(write, 'hello', 300);
    expect(writes.length).toBeGreaterThan(0);

    // PTY dies before the 300ms Enter delay elapses.
    ptyAlive = false;

    // Advancing the clock runs the delayed Enter. Must NOT reject.
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBeUndefined();

    // The warn path in inject.ts confirms the catch branch ran.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/deferred Enter failed/);
  });

  it('sends Enter normally when the PTY stays alive', async () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    const pending = injectMessage(write, 'hi', 300);
    const writesBeforeTimer = writes.length;
    await vi.advanceTimersByTimeAsync(300);
    await pending;

    // Exactly one new write — the ENTER keystroke — and no warn.
    expect(writes.length).toBe(writesBeforeTimer + 1);
    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves only AFTER the Enter has been written (delivery-ordering contract)', async () => {
    // DISPATCH-BUG REGRESSION GUARD (2026-06-07): callers serialize on this
    // promise; if it ever resolves before the Enter write again, concurrent
    // injections can interleave pastes inside each other's Enter windows and
    // silently mangle prompts (the post-sleep cron catch-up batch repro).
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    let resolved = false;
    const pending = injectMessage(write, 'ordering', 300).then(() => { resolved = true; });

    // Before the delay elapses: paste written, promise still pending.
    await vi.advanceTimersByTimeAsync(299);
    expect(resolved).toBe(false);
    expect(writes[writes.length - 1]).not.toBe(KEYS.ENTER);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
  });
});
