import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SYSTEM_TMPDIR = tmpdir();
const sendDocumentSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const editMessageTextSpy = vi.fn().mockResolvedValue({ ok: true });
const answerCallbackQuerySpy = vi.fn().mockResolvedValue({ ok: true });
const setMessageReactionSpy = vi.fn().mockResolvedValue({ ok: true });
const postActivitySpy = vi.fn().mockResolvedValue(true);
const registerTelegramCommandsSpy = vi.fn().mockResolvedValue({ status: 'ok', count: 1, commands: [] });
const submitCommunityItemSpy = vi.fn().mockReturnValue({ status: 'contributed', name: 'demo' });
const generatePipelineReportSpy = vi.fn(() => '<html><body>pipeline report</body></html>');
const generateMeetingSummaryHtmlSpy = vi.fn(() => '<html><body>meeting report</body></html>');

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument(...args: unknown[]) {
      return sendDocumentSpy(...args);
    }
    editMessageText(...args: unknown[]) {
      return editMessageTextSpy(...args);
    }
    answerCallbackQuery(...args: unknown[]) {
      return answerCallbackQuerySpy(...args);
    }
    setMessageReaction(...args: unknown[]) {
      return setMessageReactionSpy(...args);
    }
  },
}));

vi.mock('../../../src/bus/system.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/bus/system.js')>('../../../src/bus/system.js');
  return {
    ...actual,
    postActivity: (...args: unknown[]) => postActivitySpy(...args),
  };
});

vi.mock('../../../src/bus/metrics.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/bus/metrics.js')>('../../../src/bus/metrics.js');
  return {
    ...actual,
    registerTelegramCommands: (...args: unknown[]) => registerTelegramCommandsSpy(...args),
  };
});

vi.mock('../../../src/bus/catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/bus/catalog.js')>('../../../src/bus/catalog.js');
  return {
    ...actual,
    submitCommunityItem: (...args: unknown[]) => submitCommunityItemSpy(...args),
  };
});

vi.mock('../../../src/bus/crm-db.js', () => ({
  getCrmDb: () => ({}),
}));

vi.mock('../../../src/bus/crm-reports.js', () => ({
  generatePipelineReport: (...args: unknown[]) => generatePipelineReportSpy(...args),
  generateMeetingSummaryHtml: (...args: unknown[]) => generateMeetingSummaryHtmlSpy(...args),
}));

import { busCommand } from '../../../src/cli/bus';

const ORG = 'testorg';
const AGENT = 'forge';
const OWNER = '6733625733';
const NON_OWNER = '999999';

let tempRoot: string;
let tempTmpDir: string;
let originalEnv: NodeJS.ProcessEnv;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf-8');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(SYSTEM_TMPDIR, 'telegram-subcommand-gate-'));
  originalEnv = { ...process.env };

  for (const spy of [
    sendMessageSpy,
    sendDocumentSpy,
    editMessageTextSpy,
    answerCallbackQuerySpy,
    setMessageReactionSpy,
    postActivitySpy,
    registerTelegramCommandsSpy,
    submitCommunityItemSpy,
    generatePipelineReportSpy,
    generateMeetingSummaryHtmlSpy,
  ]) {
    spy.mockClear();
  }

  const agentDir = join(tempRoot, 'orgs', ORG, 'agents', AGENT);
  tempTmpDir = join(tempRoot, 'tmp');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(tempRoot, 'orgs', ORG), { recursive: true });
  mkdirSync(tempTmpDir, { recursive: true });

  writeJson(join(tempRoot, 'orgs', ORG, 'context.json'), {
    action_gate_mode: 'enforce',
    action_gate_enforce: ['external-comms', 'deployment'],
    owner_telegram_chat_ids: [OWNER],
  });
  writeJson(join(agentDir, 'config.json'), {
    approval_rules: {
      always_ask: ['external-comms', 'deployment'],
      never_ask: [],
    },
  });
  writeFileSync(join(agentDir, '.env'), `BOT_TOKEN=fake-token-for-test\nCHAT_ID=${NON_OWNER}\n`, 'utf-8');

  process.env.CTX_ROOT = tempRoot;
  process.env.CTX_FRAMEWORK_ROOT = tempRoot;
  process.env.CTX_PROJECT_ROOT = tempRoot;
  process.env.CTX_AGENT_NAME = AGENT;
  process.env.CTX_ORG = ORG;
  process.env.CTX_AGENT_DIR = agentDir;
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_TELEGRAM_CHAT_ID = NON_OWNER;
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.env.TMPDIR = tempTmpDir;

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

async function expectGateBlock(args: string[], category = 'external-comms'): Promise<void> {
  await expect(busCommand.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit(3)');
  expect(String(stderrSpy.mock.calls.map(call => call[0]).join(''))).toContain(`${category} requires approval`);
  stderrSpy.mockClear();
}

describe('Telegram-mutating bus subcommands action gate', () => {
  it('blocks crm-report --send before TelegramAPI.sendDocument', async () => {
    await expectGateBlock(['crm-report', 'pipeline', '--send']);
    expect(generatePipelineReportSpy).not.toHaveBeenCalled();
    expect(sendDocumentSpy).not.toHaveBeenCalled();
    expect(readdirSync(tempTmpDir).filter(name => name.endsWith('.html'))).toEqual([]);
  });

  it('blocks post-activity before activity-channel Telegram send', async () => {
    await expectGateBlock(['post-activity', 'external activity message']);
    expect(postActivitySpy.mock.calls.some(call => call[3] === 'external activity message')).toBe(false);
  });

  it('blocks edit-message before TelegramAPI.editMessageText', async () => {
    await expectGateBlock(['edit-message', NON_OWNER, '123', 'replacement text']);
    expect(editMessageTextSpy).not.toHaveBeenCalled();
  });

  it('blocks answer-callback before TelegramAPI.answerCallbackQuery', async () => {
    await expectGateBlock(['answer-callback', 'cb_123', 'external toast']);
    expect(answerCallbackQuerySpy).not.toHaveBeenCalled();
  });

  it('blocks react-telegram before TelegramAPI.setMessageReaction', async () => {
    await expectGateBlock(['react-telegram', NON_OWNER, '123', '👍']);
    expect(setMessageReactionSpy).not.toHaveBeenCalled();
  });

  it('blocks tui-stream --telegram before TelegramAPI.sendMessage loop', async () => {
    await expectGateBlock(['tui-stream', '--telegram', '--session', AGENT, '--interval', '500']);
    expect(sendMessageSpy.mock.calls.some(call => String(call[1]).startsWith(`[${AGENT}]`))).toBe(false);
  });

  it('blocks register-telegram-commands before Telegram setMyCommands', async () => {
    await expectGateBlock(['register-telegram-commands', 'caller-token', tempRoot]);
    expect(registerTelegramCommandsSpy).not.toHaveBeenCalled();
  });

  it('blocks submit-community-item --contribute before git/GitHub publish path', async () => {
    await expectGateBlock(['submit-community-item', 'demo', 'skill', 'demo description', '--contribute'], 'deployment');
    expect(submitCommunityItemSpy).not.toHaveBeenCalled();
  });
});
