/**
 * tests/unit/cli/bus-replyto-ack.test.ts
 *
 * REGRESSION: AGENTS.md has always documented that replying with reply_to
 * "auto-ACKs the original" — but no code implemented it (contract drift,
 * found during the 2026-06-07 dispatch-bug fix). The gap was masked by
 * the fast-checker ack-ing every message at injection time; with the
 * mark-after-deliver fix, the reply path MUST honour the documented
 * contract or every replied-to message redelivers after 5 minutes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = vi.fn().mockResolvedValue({ success: true, data: 'mocked' });
    isDaemonRunning = vi.fn().mockResolvedValue(true);
  }
  return { IPCClient: MockIPCClient };
});

import { busCommand } from '../../../src/cli/bus';

const TEST_AGENT = 'boris';

let tmpRoot: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const SAVED_ENV_KEYS = ['CTX_ROOT', 'CTX_AGENT_NAME', 'CTX_ORG', 'CTX_INSTANCE_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

function inflightDir(): string {
  return join(tmpRoot, 'inflight', TEST_AGENT);
}
function processedDir(): string {
  return join(tmpRoot, 'processed', TEST_AGENT);
}

/** Plant an original (delivered, un-ACK'd) message in MY inflight dir. */
function plantInflightMessage(id: string): string {
  mkdirSync(inflightDir(), { recursive: true });
  const filename = `2-1780000000000-from-mike-abcde.json`;
  writeFileSync(
    join(inflightDir(), filename),
    JSON.stringify({
      id,
      from: 'mike',
      to: TEST_AGENT,
      priority: 'normal',
      timestamp: '2026-06-07T12:00:00.000Z',
      text: 'original message',
      reply_to: null,
    }),
  );
  return filename;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-replyto-ack-'));
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_ORG = 'TestOrg';
  process.env.CTX_INSTANCE_ID = 'default';
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('bus send-message — reply_to auto-ACKs the original (AGENTS.md contract)', () => {
  it('positional reply-to: original moves from inflight/ to processed/', async () => {
    const filename = plantInflightMessage('1780000000000-mike-abcde');

    await busCommand.parseAsync([
      'node', 'bus', 'send-message', 'mike', 'normal', 'my reply', '1780000000000-mike-abcde',
    ]);

    expect(existsSync(join(inflightDir(), filename))).toBe(false);
    expect(existsSync(join(processedDir(), filename))).toBe(true);
    // And the reply itself landed in mike's inbox.
    expect(readdirSync(join(tmpRoot, 'inbox', 'mike'))).toHaveLength(1);
  });

  it('--reply-to flag form ACKs too', async () => {
    const filename = plantInflightMessage('1780000000001-mike-fghij');

    await busCommand.parseAsync([
      'node', 'bus', 'send-message', 'mike', 'normal', 'my reply', '--reply-to', '1780000000001-mike-fghij',
    ]);

    expect(existsSync(join(processedDir(), filename))).toBe(true);
  });

  it('no reply-to: nothing is ACK\'d (plain send unchanged)', async () => {
    const filename = plantInflightMessage('1780000000002-mike-klmno');

    await busCommand.parseAsync([
      'node', 'bus', 'send-message', 'mike', 'normal', 'not a reply',
    ]);

    expect(existsSync(join(inflightDir(), filename))).toBe(true);
    expect(existsSync(join(processedDir(), filename))).toBe(false);
  });

  it('reply-to an already-ACK\'d / unknown id is a silent no-op (send still succeeds)', async () => {
    await busCommand.parseAsync([
      'node', 'bus', 'send-message', 'mike', 'normal', 'reply to ghost', 'no-such-id',
    ]);

    // The reply still went out.
    expect(readdirSync(join(tmpRoot, 'inbox', 'mike'))).toHaveLength(1);
  });
});
