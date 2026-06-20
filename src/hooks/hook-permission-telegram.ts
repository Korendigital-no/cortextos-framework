
/**
 * hook-permission-telegram.ts - Blocking PermissionRequest hook
 * Forwards permission prompts to Telegram with Approve/Deny inline buttons.
 * Polls for a response file written by fast-checker when the user taps a button.
 * Timeout: 300s (5 min, deny by default). Sized to one 5-min cron cycle so a
 * silent approval window cannot accumulate 6 injections and race the stale
 * detector's 45-min window into a false self-inflicted-stale restart.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  formatToolSummary,
  isClaudeDirOperation,
  sanitizeCodeBlock,
  buildPermissionKeyboard,
  cleanupResponseFile,
} from './index';
import { join } from 'path';
import { mkdirSync } from 'fs';

// Exported for unit tests and future config-override surface.
// Sized to 1 cron cycle (5 min): prevents a silent approval window from
// accumulating 6+ injections and racing the stale-detector's 45-min window.
export const PERMISSION_TIMEOUT_MS = 300 * 1000;

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // ExitPlanMode and AskUserQuestion are handled by other hooks
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    outputDecision('deny', 'No Telegram credentials configured for remote approval');
    return;
  }

  // Auto-approve .claude/ directory writes
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision('allow');
    return;
  }

  // Build human-readable summary
  const summary = formatToolSummary(tool_name, tool_input);

  // Generate unique ID
  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  // Register cleanup
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // Build message
  let message = `PERMISSION REQUEST\nAgent: ${env.agentName}\nTool: ${tool_name}\n\n\`\`\`\n${sanitizeCodeBlock(summary)}\n\`\`\``;

  // Truncate if over limit
  if (message.length > 3800) {
    message = message.slice(0, 3800) + '...(truncated)';
  }

  const keyboard = buildPermissionKeyboard(uniqueId);
  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, message, keyboard);
  } catch {
    outputDecision('deny', 'Failed to send permission request to Telegram');
    return;
  }

  // Poll for response (5 min timeout — 1 cron cycle, prevents stale-detector race)
  const TIMEOUT_MS = PERMISSION_TIMEOUT_MS;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || 'deny';
      if (decision === 'allow') {
        outputDecision('allow');
      } else {
        outputDecision('deny', 'Denied by user via Telegram');
      }
    } catch {
      outputDecision('deny', 'Invalid response file');
    }
  } else {
    // Timeout - deny and notify
    try {
      await api.sendMessage(
        env.chatId,
        `Permission request TIMED OUT (auto-denied): ${tool_name}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('deny', 'Timed out waiting for Telegram approval (5m)');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-permission-telegram error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
