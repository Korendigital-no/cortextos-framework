import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendDocumentSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument(...args: unknown[]) {
      return sendDocumentSpy(...args);
    }
  },
}));

vi.mock('../../../src/bus/crm-db.js', () => ({
  getCrmDb: () => ({}),
}));

vi.mock('../../../src/bus/crm-reports.js', () => ({
  generatePipelineReport: () => '<html><body>pipeline report</body></html>',
  generateMeetingSummaryHtml: () => '<html><body>meeting report</body></html>',
}));

import { busCommand } from '../../../src/cli/bus';

const ORG = 'testorg';
const AGENT = 'forge';
const OWNER = '6733625733';
const NON_OWNER = '999999';

let tempRoot: string;
let originalEnv: NodeJS.ProcessEnv;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf-8');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'crm-report-gate-'));
  originalEnv = { ...process.env };
  sendDocumentSpy.mockClear();

  const agentDir = join(tempRoot, 'orgs', ORG, 'agents', AGENT);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(tempRoot, 'orgs', ORG), { recursive: true });

  writeJson(join(tempRoot, 'orgs', ORG, 'context.json'), {
    action_gate_mode: 'enforce',
    action_gate_enforce: ['external-comms'],
    owner_telegram_chat_ids: [OWNER],
  });
  writeJson(join(agentDir, 'config.json'), {
    approval_rules: {
      always_ask: ['external-comms'],
      never_ask: [],
    },
  });

  process.env.CTX_ROOT = tempRoot;
  process.env.CTX_FRAMEWORK_ROOT = tempRoot;
  process.env.CTX_PROJECT_ROOT = tempRoot;
  process.env.CTX_AGENT_NAME = AGENT;
  process.env.CTX_ORG = ORG;
  process.env.CTX_AGENT_DIR = agentDir;
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_TELEGRAM_CHAT_ID = NON_OWNER;
  process.env.BOT_TOKEN = 'fake-token-for-test';

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.env = originalEnv;
  exitSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('bus crm-report --send action gate', () => {
  it('blocks a non-owner Telegram document send before TelegramAPI.sendDocument', async () => {
    await expect(
      busCommand.parseAsync(['crm-report', 'pipeline', '--send'], { from: 'user' }),
    ).rejects.toThrow('process.exit(3)');

    expect(sendDocumentSpy).not.toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls.map(call => call[0]).join(''))).toContain('external-comms requires approval');
  });
});
