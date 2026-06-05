import { Command } from 'commander';
import { spawnSync, execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sendMessage, checkInbox, ackInbox } from '../bus/message.js';
import { validateAgentName } from '../utils/validate.js';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, checkStaleTasks, archiveTasks, checkHumanTasks } from '../bus/task.js';
import type { MeasurementOutcome } from '../bus/measurement.js';
import { saveOutput } from '../bus/save-output.js';
import { logEvent } from '../bus/event.js';
import { updateHeartbeat, readAllHeartbeats } from '../bus/heartbeat.js';
import { selfRestart, hardRestart, autoCommit, checkGoalStaleness, postActivity } from '../bus/system.js';
import { createExperiment, runExperiment, evaluateExperiment, listExperiments, gatherContext, manageCycle, loadExperimentConfig } from '../bus/experiment.js';
import { browseCatalog, installCommunityItem, prepareSubmission, submitCommunityItem } from '../bus/catalog.js';
import { collectMetrics, parseUsageOutput, storeUsageData, checkUpstream, collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { createApproval, updateApproval } from '../bus/approval.js';
import { createReminder, listReminders, ackReminder, pruneReminders } from '../bus/reminders.js';
import { updateCronFire, parseDurationMs, readCronState } from '../bus/cron-state.js';
import { addCron, removeCron, readCrons, updateCron as updateCronDef, getCronByName, getExecutionLog } from '../bus/crons.js';
import { nextFireFromCron } from '../daemon/cron-scheduler.js';
import { queryKnowledgeBase, ingestKnowledgeBase, ensureKBDirs } from '../bus/knowledge-base.js';
import { checkUsageApi, refreshOAuthToken, rotateOAuth, loadAccounts, ALERT_5H, ALERT_7D } from '../bus/oauth.js';
import { getCrmDb } from '../bus/crm-db.js';
import * as crm from '../bus/crm.js';
import { processWebhookQueue } from '../bus/crm-webhook-processor.js';
import { generatePipelineReport, generateMeetingSummaryHtml } from '../bus/crm-reports.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { TelegramAPI } from '../telegram/api.js';
import { logOutboundMessage, cacheLastSent } from '../telegram/logging.js';
import type { Priority, Task, TaskStatus, EventCategory, EventSeverity, ApprovalCategory, ApprovalStatus, OrgContext, CronDefinition } from '../types/index.js';

/**
 * Check if the org requires deliverables and the task has none attached.
 * Returns an error message if the transition should be blocked, or null if allowed.
 */
function checkDeliverableRequirement(taskId: string, frameworkRoot: string, org: string, taskDir: string): string | null {
  // Read org context to check require_deliverables setting
  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) return null;

  let ctx: OrgContext;
  try {
    ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
  } catch {
    return null; // cannot read config — allow the transition
  }

  if (!ctx.require_deliverables) return null;

  // Check if the task has outputs
  const taskFile = join(taskDir, `${taskId}.json`);
  if (!existsSync(taskFile)) return null;

  let task: Task;
  try {
    task = JSON.parse(readFileSync(taskFile, 'utf-8'));
  } catch {
    return null;
  }

  if (!task.outputs || task.outputs.length === 0) {
    return `Cannot submit task ${taskId}: require_deliverables is enabled but this task has no file deliverables attached. Use "cortextos bus save-output ${taskId} <file>" to attach a deliverable first.`;
  }

  return null;
}

export const busCommand = new Command('bus')
  .description('Bus commands for agent messaging, tasks, and events');

busCommand
  .command('send-message')
  .argument('<to>', 'Target agent')
  .argument('<priority>', 'Message priority (urgent, high, normal, low)')
  .argument('<text>', 'Message text')
  .argument('[reply-to]', 'Reply to message ID (optional positional form)')
  .option('--reply-to <id>', 'Reply to message ID')
  .action((to: string, priority: string, text: string, replyToArg: string | undefined, opts: { replyTo?: string }) => {
    // Accept reply-to as either positional arg or --reply-to flag (P2 fix #9)
    const effectiveReplyTo = opts.replyTo ?? replyToArg;
    const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
    if (!validPriorities.includes(priority as Priority)) {
      console.error(`Invalid priority '${priority}'. Must be one of: ${validPriorities.join(', ')}`);
      process.exit(1);
    }
    // Security (H9): Validate agent name before any filesystem access.
    try {
      validateAgentName(to);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Warn if target agent doesn't exist (check project dir)
    const { existsSync } = require('fs');
    const { join } = require('path');
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const orgsDir = join(projectRoot, 'orgs');
    let agentExists = false;
    if (existsSync(orgsDir)) {
      const { readdirSync } = require('fs');
      try {
        for (const org of readdirSync(orgsDir)) {
          if (existsSync(join(orgsDir, org, 'agents', to))) {
            agentExists = true;
            break;
          }
        }
      } catch { /* skip */ }
    }
    if (!agentExists) {
      console.error(`Warning: agent '${to}' not found in project. Message will be queued but may never be read.`);
    }

    const msgId = sendMessage(paths, env.agentName, to, priority as Priority, text, effectiveReplyTo);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'agent_message_sent', 'info', JSON.stringify({ to, priority, msg_id: msgId, reply_to: effectiveReplyTo ?? null }));
    } catch { /* non-fatal */ }
    console.log(msgId);
  });

busCommand
  .command('check-inbox')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const messages = checkInbox(paths);
    console.log(JSON.stringify(messages));
  });

busCommand
  .command('ack-inbox')
  .argument('<id>', 'Message ID to acknowledge')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    ackInbox(paths, id);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'inbox_ack', 'info', JSON.stringify({ msg_id: id }));
    } catch { /* non-fatal */ }
    console.log(`ACK'd ${id}`);
  });

busCommand
  .command('create-task')
  .argument('<title>', 'Task title')
  .option('--desc <description>', 'Task description')
  .option('--assignee <agent>', 'Assigned agent')
  .option('--priority <p>', 'Priority (urgent, high, normal, low)', 'normal')
  .option('--project <name>', 'Project name')
  .option('--needs-approval', 'Require human approval before execution')
  .option('--blocked-by <ids>', 'Comma-separated task IDs that must complete before this task can progress')
  .option('--blocks <ids>', 'Comma-separated task IDs that this new task will block (symmetric reverse edge)')
  .option('--client <orgnr>', 'Måle-garanti: client org number — marks this as a guarantee-measured client task (auto-emits measurement on complete)')
  .option('--task-type <type>', 'Måle-garanti: task type (booking|doc_review|nav_oppgjor|...) — required with --client')
  .option('--baseline-seconds <n>', 'Måle-garanti: signed uke-0 baseline seconds per task (optional; filled later if omitted)')
  .option('--confidence <c>', 'Måle-garanti baseline confidence: high | medium | low')
  .action((title: string, opts: { desc?: string; assignee?: string; priority: string; project?: string; needsApproval?: boolean; blockedBy?: string; blocks?: string; client?: string; taskType?: string; baselineSeconds?: string; confidence?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const parseList = (raw?: string) => (raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []);
    // Måle-garanti: a task is guarantee-measured iff --client is given. Validate
    // the measurement flags at create-time (like log-measurement) so a typo can
    // never bake malformed context into a task that later emits wrong/dropped
    // guarantee data (codex P2).
    let measurement: { client_id: string; task_type: string; baseline_seconds?: number; baseline_confidence?: 'high' | 'medium' | 'low' } | undefined;
    if (opts.client) {
      if (!opts.taskType) {
        console.error('ERROR: --task-type is required when --client is set (måle-garanti measurement context)');
        process.exit(1);
      }
      let baselineSeconds: number | undefined;
      if (opts.baselineSeconds !== undefined) {
        baselineSeconds = Number(opts.baselineSeconds);
        if (!Number.isFinite(baselineSeconds) || baselineSeconds < 0) {
          console.error('ERROR: --baseline-seconds must be a non-negative number');
          process.exit(1);
        }
      }
      if (opts.confidence !== undefined && !['high', 'medium', 'low'].includes(opts.confidence)) {
        console.error('ERROR: --confidence must be one of: high | medium | low');
        process.exit(1);
      }
      measurement = {
        client_id: opts.client,
        task_type: opts.taskType,
        ...(baselineSeconds !== undefined ? { baseline_seconds: baselineSeconds } : {}),
        ...(opts.confidence ? { baseline_confidence: opts.confidence as 'high' | 'medium' | 'low' } : {}),
      };
    }
    const taskId = createTask(paths, env.agentName, env.org, title, {
      description: opts.desc,
      assignee: opts.assignee,
      priority: opts.priority as Priority,
      project: opts.project,
      needsApproval: opts.needsApproval ?? false,
      blockedBy: parseList(opts.blockedBy),
      blocks: parseList(opts.blocks),
      measurement,
    });
    console.log(taskId);
    // Auto-notify assignee so the task is visible immediately (issue #78)
    if (opts.assignee && opts.assignee !== env.agentName) {
      const assigneePaths = resolvePaths(opts.assignee, env.instanceId, env.org, env.ctxRoot);
      const desc = opts.desc ? ` — ${opts.desc.slice(0, 120)}` : '';
      sendMessage(assigneePaths, env.agentName, opts.assignee, 'normal',
        `Task assigned: [${opts.priority}] ${title}${desc} (id: ${taskId})`);
    }
  });

busCommand
  .command('update-task')
  .argument('<id>', 'Task ID')
  .argument('<status>', 'New status (pending, in_progress, completed, blocked, cancelled)')
  .action((id: string, status: string) => {
    const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'];
    if (!validStatuses.includes(status as TaskStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Guard: block review/completion when deliverables are required but missing.
    // Checks both ready_for_review (approval workflow) and completed (vanilla upstream)
    // so the validator works regardless of which status set is installed.
    if ((status === 'ready_for_review' || status === 'completed') && env.org) {
      const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
      if (err) {
        console.error(err);
        process.exit(1);
      }
    }

    updateTask(paths, id, status as TaskStatus);
    console.log(`Updated ${id} -> ${status}`);
  });

busCommand
  .command('compact-tasks')
  .description('Archive completed tasks older than N days into a per-month archive-YYYY-MM.jsonl and remove them from the active list — preserves audit logs, skips tasks still needed as blockers')
  .option('--older-than <days>', 'Cutoff in days (default: 30)', '30')
  .option('--dry-run', 'Report what would be compacted without modifying anything')
  .action((opts: { olderThan: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const olderThanDays = parseInt(opts.olderThan, 10);
    if (isNaN(olderThanDays) || olderThanDays < 0) {
      console.error('--older-than must be a non-negative integer');
      process.exit(1);
    }
    const report = compactTasks(paths, { olderThanDays, dryRun: opts.dryRun });
    const verb = report.dry_run ? 'would compact' : 'compacted';
    console.log(`${verb} ${report.archived.length} task${report.archived.length === 1 ? '' : 's'}, skipped ${report.skipped.length}`);
    for (const a of report.archived) console.log(`  ✓ ${a.id}  ->  ${a.archive_file}`);
    if (report.skipped.length > 0) {
      console.log(`\nSkipped (common reasons: within cutoff, still needed as blocker):`);
      for (const s of report.skipped) console.log(`  - ${s.id}  (${s.reason})`);
    }
  });

busCommand
  .command('check-deps')
  .description('Show open dependencies blocking a task — lists blocked_by entries that are not yet completed')
  .argument('<id>', 'Task ID')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const open = checkTaskDependencies(paths, id);
    if (open.length === 0) {
      console.log(`${id}: no open dependencies — ready to work`);
      return;
    }
    console.log(`${id} blocked by ${open.length} dependency${open.length === 1 ? '' : 's'}:`);
    for (const d of open) console.log(`  ${d.id}  [${d.status}]`);
  });

busCommand
  .command('task-history')
  .description("Show a task's append-only audit log (every status change, claim, and completion)")
  .argument('<id>', 'Task ID')
  .option('--json', 'Emit raw JSONL instead of formatted text')
  .action((id: string, opts: { json?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const entries = readTaskAudit(paths, id);
    if (entries.length === 0) {
      console.log(`No audit log for task ${id}`);
      return;
    }
    if (opts.json) {
      for (const e of entries) console.log(JSON.stringify(e));
      return;
    }
    console.log(`Audit log for ${id} (${entries.length} entries):`);
    for (const e of entries) {
      const transition = e.from && e.to ? `${e.from} -> ${e.to}` : e.to || '';
      const note = e.note ? ` | ${e.note}` : '';
      console.log(`  ${e.ts}  ${e.event.padEnd(8)}  ${e.agent.padEnd(16)}  ${transition}${note}`);
    }
  });

busCommand
  .command('claim-task')
  .description('Atomically claim a pending task — marks in_progress + sets assignee in one shot, rejecting if another agent already owns it')
  .argument('<id>', 'Task ID')
  .option('--agent <name>', 'Agent claiming the task (defaults to CTX_AGENT_NAME)')
  .action((id: string, opts: { agent?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const agent = opts.agent || env.agentName;
    if (!agent) {
      console.error('ERROR: --agent or CTX_AGENT_NAME required');
      process.exit(1);
    }
    try {
      const task = claimTask(paths, id, agent);
      console.log(`Claimed ${id} -> in_progress (assigned to ${agent})`);
      console.log(`  Title: ${task.title}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('complete-task')
  .argument('<id>', 'Task ID')
  .argument('[result]', 'Completion result (optional positional form)')
  .option('--result <text>', 'Completion result')
  .option('--human-touch-seconds <n>', 'Måle-garanti: residual human seconds on this task (only emitted if the task carries measurement context)')
  .option('--outcome <o>', 'Måle-garanti outcome: completed | escalated_to_human | failed (default: completed)')
  .action((id: string, resultArg: string | undefined, opts: { result?: string; humanTouchSeconds?: string; outcome?: string }) => {
    // Accept result as either positional arg or --result flag (P1 fix #8)
    const effectiveResult = opts.result ?? resultArg;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Guard: block completion when deliverables are required but missing
    if (env.org) {
      const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
      if (err) {
        console.error(err);
        process.exit(1);
      }
    }

    // Måle-garanti completion facts — only consumed when the task carries a
    // measurement block (client work); harmless otherwise. Validate up front so
    // a typo (bad number / unknown outcome) fails loudly here instead of being
    // silently swallowed by the best-effort auto-emit, which would mark the task
    // done while dropping its guarantee event (codex P2).
    let humanTouchSeconds: number | undefined;
    if (opts.humanTouchSeconds !== undefined) {
      humanTouchSeconds = Number(opts.humanTouchSeconds);
      if (!Number.isFinite(humanTouchSeconds) || humanTouchSeconds < 0) {
        console.error('ERROR: --human-touch-seconds must be a non-negative number');
        process.exit(1);
      }
    }
    if (opts.outcome !== undefined && !['completed', 'escalated_to_human', 'failed'].includes(opts.outcome)) {
      console.error('ERROR: --outcome must be one of: completed | escalated_to_human | failed');
      process.exit(1);
    }
    const measurementOpts = (humanTouchSeconds !== undefined || opts.outcome !== undefined)
      ? {
          ...(humanTouchSeconds !== undefined ? { human_touch_seconds: humanTouchSeconds } : {}),
          ...(opts.outcome !== undefined ? { outcome: opts.outcome as MeasurementOutcome } : {}),
        }
      : undefined;

    completeTask(paths, id, effectiveResult, measurementOpts);
    console.log(`Completed ${id}`);
  });

busCommand
  .command('save-output')
  .description('Copy a file into the per-task deliverables tree and link it to the task as a file output')
  .argument('<task-id>', 'Target task ID')
  .argument('<source>', 'Source file to save (absolute or relative to cwd)')
  .option('--label <label>', 'Human-readable label for the linked output (defaults to filename)')
  .option('--move', 'Delete the source file after a successful copy')
  .option('--no-link', 'Save file without linking to task.outputs[]')
  .action((taskId: string, source: string, opts: { label?: string; move?: boolean; link?: boolean }) => {
    const noLink = opts.link === false;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    try {
      const result = saveOutput(paths, {
        taskId,
        sourcePath: source,
        label: opts.label,
        move: opts.move ?? false,
        noLink,
      });
      console.log(result.targetPath);
      if (result.linked) {
        console.log(`Linked to ${taskId} as [snapshot] ${opts.label ?? result.storedPath}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

busCommand
  .command('list-tasks')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .option('--respect-deps', 'Sort DAG-aware: unblocked tasks first, blocked tasks last')
  .action((opts: { agent?: string; status?: string; format?: string; respectDeps?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const tasks = listTasks(paths, {
      agent: opts.agent,
      status: opts.status as TaskStatus,
      respectDeps: opts.respectDeps ?? false,
    });

    if (opts.format === 'json') {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    // Text table format
    if (tasks.length === 0) {
      console.log('  No tasks found.');
      return;
    }

    const PRIORITY_ICON: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '🔵', low: '⚪' };
    const STATUS_ICON: Record<string, string> = { pending: '○', in_progress: '●', blocked: '◑', completed: '✓', done: '✓', cancelled: '✗' };

    console.log(`\n  Tasks (${tasks.length})\n`);
    const header = '  Status  Pri  ID                        Assignee         Title';
    const separator = '  ' + '-'.repeat(header.length - 2);
    console.log(header);
    console.log(separator);

    for (const t of tasks) {
      const statusIcon = (STATUS_ICON[t.status] || '?').padEnd(8);
      const priIcon = (PRIORITY_ICON[t.priority] || '·').padEnd(5);
      const id = t.id.substring(0, 26).padEnd(26);
      const assignee = (t.assigned_to || '-').substring(0, 16).padEnd(17);
      const title = t.title.substring(0, 50);
      console.log(`  ${statusIcon}${priIcon}${id}${assignee}${title}`);
    }
    console.log('');
  });

busCommand
  .command('log-event')
  .argument('<category>', 'Event category')
  .argument('<event>', 'Event name')
  .argument('<severity>', 'Severity (info, warning, error, critical)')
  .option('--meta <json>', 'Metadata JSON string', '{}')
  .action((category: string, event: string, severity: string, opts: { meta: string }) => {
    const validCategories: EventCategory[] = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval', 'measurement'];
    if (!validCategories.includes(category as EventCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const validSeverities: EventSeverity[] = ['info', 'warning', 'error', 'critical'];
    if (!validSeverities.includes(severity as EventSeverity)) {
      console.error(`Invalid severity '${severity}'. Must be one of: ${validSeverities.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    logEvent(paths, env.agentName, env.org, category as EventCategory, event, severity as EventSeverity, opts.meta);
    console.log(`Logged ${category}/${event} (${severity})`);
  });

busCommand
  .command('update-heartbeat')
  .argument('<status>', 'Heartbeat status message')
  .option('--task <task>', 'Current task description')
  .option('--timezone <tz>', 'Timezone for day/night mode detection')
  .option('--interval <i>', 'Loop interval from cron config')
  .action((status: string, opts: { task?: string; timezone?: string; interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // Read display name from IDENTITY.md so agents self-report their user-facing name
    let displayName: string | undefined;
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
    if (frameworkRoot) {
      const identityPaths = [
        join(frameworkRoot, 'orgs', env.org, 'agents', env.agentName, 'IDENTITY.md'),
        join(frameworkRoot, 'agents', env.agentName, 'IDENTITY.md'),
      ];
      for (const idPath of identityPaths) {
        if (existsSync(idPath)) {
          try {
            const lines = readFileSync(idPath, 'utf-8').split('\n');
            // "## Name" section takes priority (user-configured display name)
            const nameIdx = lines.findIndex(l => l.trim() === '## Name');
            if (nameIdx >= 0) {
              for (let i = nameIdx + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('<!--')) continue;
                if (line.startsWith('#')) break;
                displayName = line;
                break;
              }
            }
            // Fallback: first non-empty, non-comment top-level heading value
            if (!displayName) {
              const h1 = lines.find(l => l.startsWith('# ') && !l.startsWith('## '));
              if (h1) displayName = h1.replace(/^#\s+/, '').trim();
            }
          } catch {
            // Skip
          }
          break;
        }
      }
    }

    updateHeartbeat(paths, env.agentName, status, {
      org: env.org,
      timezone: opts.timezone,
      loopInterval: opts.interval,
      currentTask: opts.task,
      displayName,
    });
    // Auto-emit a heartbeat event so the activity feed surfaces any live agent
    // even if the agent itself forgets to call log-event. This makes the
    // dashboard "agents" list derive from heartbeats, not just explicit events.
    try {
      logEvent(paths, env.agentName, env.org, 'heartbeat', 'heartbeat', 'info', JSON.stringify({ status, task: opts.task ?? '' }));
    } catch {
      // Non-fatal: heartbeat write already succeeded
    }
    console.log(`Heartbeat updated: ${env.agentName}`);
  });

busCommand
  .command('read-all-heartbeats')
  .description('Read heartbeat files for all agents in the system')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .action((opts: { format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const heartbeats = readAllHeartbeats(paths);

    if (opts.format === 'json') {
      console.log(JSON.stringify(heartbeats, null, 2));
      return;
    }

    if (heartbeats.length === 0) {
      console.log('No agents found.');
      return;
    }

    for (const hb of heartbeats) {
      const stale = new Date(hb.last_heartbeat) < new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleFlag = stale ? ' [STALE]' : '';
      const label = hb.display_name ? `${hb.display_name} (${hb.agent})` : hb.agent;
      console.log(`${label} (${hb.org}) — ${hb.status}${staleFlag} — last seen ${hb.last_heartbeat}`);
      if (hb.current_task) console.log(`  task: ${hb.current_task}`);
    }
  });

busCommand
  .command('recall-facts')
  .description('Recall recent session facts extracted at compaction time (cross-session memory)')
  .option('--days <n>', 'How many days back to scan', '3')
  .option('--format <fmt>', 'Output format: text or json', 'text')
  .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
  .action((opts: { days: string; format: string; agent?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const daysBack = Math.max(1, Math.min(30, parseInt(opts.days, 10) || 3));
    const factsDir = join(env.ctxRoot, 'state', agentName, 'memory', 'facts');

    const entries: Array<{ ts: string; session_id: string; summary: string; keywords: string[] }> = [];

    for (let d = 0; d < daysBack; d++) {
      const date = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const factsFile = join(factsDir, `${dateStr}.jsonl`);
      if (!existsSync(factsFile)) continue;
      try {
        const lines = readFileSync(factsFile, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch { /* skip corrupt lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log('No session facts found. Facts are written automatically at context compaction.');
      return;
    }

    console.log(`\n  Session Memory — last ${daysBack} day(s) — ${entries.length} entries\n`);
    for (const e of entries.slice(-10)) { // Show last 10 entries
      const ts = e.ts.replace('T', ' ').replace('Z', ' UTC').slice(0, 19);
      console.log(`  [${ts}]`);
      // Print first 400 chars of summary
      const preview = e.summary.slice(0, 400).replace(/\n/g, ' ');
      console.log(`  ${preview}${e.summary.length > 400 ? '...' : ''}`);
      if (e.keywords && e.keywords.length > 0) {
        console.log(`  Keywords: ${e.keywords.slice(0, 8).join(', ')}`);
      }
      console.log();
    }
  });

busCommand
  .command('check-stale-tasks')
  .description('Find stale tasks (in_progress >2h, pending >24h, overdue)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const report = checkStaleTasks(paths);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('archive-tasks')
  .description('Archive completed tasks older than 7 days')
  .option('--dry-run', 'Show what would be archived without modifying files')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const report = archiveTasks(paths, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-human-tasks')
  .description('Find stale human-assigned tasks (>24h)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const tasks = checkHumanTasks(paths);
    console.log(JSON.stringify(tasks));
  });

busCommand
  .command('self-restart')
  .description('Immediately restart this agent via daemon IPC (same as soft-restart but targets self)')
  .option('--reason <why>', 'Reason for restart')
  .action(async (opts: { reason?: string }) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const reason = opts.reason || 'self-restart requested';

    // Write .user-restart marker (same as soft-restart)
    const ctxRoot = env.ctxRoot;
    const stateDir = join(ctxRoot, 'state', env.agentName);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);

    // Also write to restarts.log
    selfRestart(paths, env.agentName, reason);

    // Send IPC restart-agent signal for self — makes restart immediate
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus self-restart' });
      if (resp.success) {
        console.log(`Restarting ${env.agentName} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('hard-restart')
  .description('Plan a hard restart (fresh session, no --continue)')
  .option('--reason <why>', 'Reason for restart')
  .option('--handoff-doc <path>', 'Path to handoff document to inject into next session boot prompt')
  .action(async (opts: { reason?: string; handoffDoc?: string }) => {
    const { writeFileSync: fsWrite, existsSync: fsExists, mkdirSync: fsMkdir } = require('fs');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    hardRestart(paths, env.agentName, opts.reason);
    if (opts.handoffDoc && fsExists(opts.handoffDoc)) {
      fsMkdir(paths.stateDir, { recursive: true });
      fsWrite(join(paths.stateDir, '.handoff-doc-path'), opts.handoffDoc + '\n', 'utf-8');
    }
    // Send IPC restart-agent so the daemon terminates and restarts this session
    // immediately. Without this the session keeps running — .force-fresh is only
    // consumed on the NEXT restart, which never comes unless the daemon is notified.
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus hard-restart' });
      if (resp.success) {
        console.log(`Hard restart triggered for ${env.agentName} — fresh session incoming`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.log('Hard restart planned (daemon not running — will take effect on next start)');
    }
  });

busCommand
  .command('auto-commit')
  .description('Stage safe files for commit (never pushes)')
  .option('--dry-run', 'Show what would be staged without modifying git')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const projectDir = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = autoCommit(projectDir, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-goal-staleness')
  .description('Detect agents with stale GOALS.md')
  .option('--threshold <days>', 'Staleness threshold in days', '7')
  .action((opts: { threshold: string }) => {
    const env = resolveEnv();
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = checkGoalStaleness(projectRoot, parseInt(opts.threshold, 10));
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('post-activity')
  .description('Post a message to the org Telegram activity channel')
  .argument('<message>', 'Message to post')
  .action(async (message: string) => {
    const env = resolveEnv();
    const orgDir = env.agentDir ? env.agentDir.replace(/\/agents\/.*$/, '') : '';
    const success = await postActivity(orgDir, env.ctxRoot, env.org, message);
    if (success) {
      console.log('Activity posted');
    } else {
      console.error('Failed to post activity. Check that ACTIVITY_CHAT_ID is set in your org secrets.env or .env file.');
    }
  });

busCommand
  .command('create-experiment')
  .description('Create a new experiment proposal')
  .argument('<metric>', 'Metric to measure')
  .argument('<hypothesis>', 'Hypothesis to test')
  .option('--surface <path>', 'Surface file path')
  .option('--direction <dir>', 'Direction: higher or lower', 'higher')
  .option('--window <dur>', 'Measurement window', '24h')
  .action(async (metric: string, hypothesis: string, opts: { surface?: string; direction?: string; window?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const id = createExperiment(agentDir, env.agentName, metric, hypothesis, {
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
    });
    console.log(id);

    // If approval_required is configured, auto-create an approval
    const config = loadExperimentConfig(agentDir);
    if (config.approval_required) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
      const approvalId = await createApproval(
        paths,
        env.agentName,
        env.org,
        `Run experiment: ${metric} — ${hypothesis.slice(0, 80)}`,
        'other',
        `Experiment ID: ${id}\nMetric: ${metric}\nHypothesis: ${hypothesis}`,
        env.frameworkRoot,
        env.agentDir,
      );
      console.log(`approval_required: ${approvalId}`);
    }
  });

busCommand
  .command('run-experiment')
  .description('Start running a proposed experiment')
  .argument('<id>', 'Experiment ID')
  .argument('[description]', 'Description of changes')
  .action((id: string, description?: string) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const experiment = runExperiment(agentDir, id, description);
    console.log(JSON.stringify(experiment, null, 2));
  });

busCommand
  .command('evaluate-experiment')
  .description('Evaluate a running experiment with a measured value')
  .argument('<id>', 'Experiment ID')
  .argument('<value>', 'Measured value')
  .option('--score <n>', 'Score 1-10')
  .option('--justification <text>', 'Justification text')
  .action((id: string, value: string, opts: { score?: string; justification?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const experiment = evaluateExperiment(agentDir, id, parseFloat(value), {
      score: opts.score ? parseInt(opts.score, 10) : undefined,
      justification: opts.justification,
    });
    console.log(JSON.stringify(experiment, null, 2));
  });

busCommand
  .command('list-experiments')
  .description('List experiments with optional filters')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--metric <m>', 'Filter by metric')
  .option('--json', 'Output as JSON')
  .action((opts: { agent?: string; status?: string; metric?: string; json?: boolean }) => {
    const env = resolveEnv();
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const experiments = listExperiments(agentDir, {
      agent: opts.agent,
      status: opts.status,
      metric: opts.metric,
    });
    console.log(JSON.stringify(experiments, null, 2));
  });

busCommand
  .command('gather-context')
  .description('Gather experiment context for an agent')
  .option('--agent <name>', 'Agent name')
  .option('--format <fmt>', 'Output format: json or markdown', 'json')
  .action((opts: { agent?: string; format?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const context = gatherContext(agentDir, agentName, { format: opts.format as 'json' | 'markdown' });
    console.log(JSON.stringify(context, null, 2));
  });

busCommand
  .command('manage-cycle')
  .description('Manage experiment cycles')
  .argument('<action>', 'Action: create, modify, remove, list')
  .argument('<agent>', 'Agent name')
  .option('--metric <name>', 'Metric name')
  .option('--metric-type <type>', 'Metric type: quantitative or qualitative')
  .option('--surface <path>', 'Surface path (file to experiment on)')
  .option('--direction <dir>', 'Direction: higher or lower')
  .option('--window <dur>', 'Measurement window (how long before evaluating)')
  .option('--measurement <method>', 'How to measure the metric')
  .option('--loop-interval <dur>', 'Cron frequency for the experiment loop')
  .option('--enabled <bool>', 'Enable or pause the cycle (true/false)')
  .option('--cycle <name>', 'Cycle name')
  .action((action: string, agent: string, opts: { metric?: string; metricType?: string; surface?: string; direction?: string; window?: string; measurement?: string; loopInterval?: string; enabled?: string; cycle?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    if (opts.direction && opts.direction !== 'higher' && opts.direction !== 'lower') {
      console.error(`Invalid --direction '${opts.direction}'. Must be 'higher' or 'lower'`);
      process.exit(1);
    }
    if (opts.metricType && opts.metricType !== 'quantitative' && opts.metricType !== 'qualitative') {
      console.error(`Invalid --metric-type '${opts.metricType}'. Must be 'quantitative' or 'qualitative'`);
      process.exit(1);
    }
    const cycles = manageCycle(agentDir, action as 'create' | 'modify' | 'remove' | 'list', {
      agent,
      name: opts.cycle,
      metric: opts.metric,
      metric_type: opts.metricType as 'quantitative' | 'qualitative' | undefined,
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
      measurement: opts.measurement,
      loop_interval: opts.loopInterval,
      enabled: opts.enabled !== undefined ? opts.enabled === 'true' : undefined,
    });
    console.log(JSON.stringify(cycles, null, 2));
  });

busCommand
  .command('browse-catalog')
  .description('Browse community catalog for items')
  .option('--type <type>', 'Filter by type (skill, agent, org)')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Search by name or description')
  .action((opts: { type?: string; tag?: string; search?: string }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = browseCatalog(frameworkRoot, env.ctxRoot, {
      type: opts.type,
      tag: opts.tag,
      search: opts.search,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('install-community-item')
  .description('Install a community catalog item')
  .argument('<name>', 'Item name to install')
  .option('--dry-run', 'Show what would be installed without modifying files')
  .action((name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = installCommunityItem(frameworkRoot, env.ctxRoot, name, {
      dryRun: opts.dryRun,
      agentDir: env.agentDir,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('prepare-submission')
  .description('Prepare a skill/agent/org for community submission with PII scanning')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<source-path>', 'Source directory path')
  .argument('<name>', 'Item name')
  .option('--dry-run', 'Scan without keeping staged files')
  .action((type: string, sourcePath: string, name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const result = prepareSubmission(env.ctxRoot, type, sourcePath, name, {
      dryRun: opts.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('submit-community-item')
  .description('Submit a prepared item to the community catalog')
  .argument('<name>', 'Item name')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<description>', 'Item description')
  .option('--dry-run', 'Show what would be submitted')
  .option('--author <author>', 'Author name or handle for attribution')
  .option('--contribute', 'Create branch, push to origin, and open a PR against upstream')
  .action((name: string, type: string, description: string, opts: { dryRun?: boolean; author?: string; contribute?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = submitCommunityItem(frameworkRoot, env.ctxRoot, name, type, description, {
      dryRun: opts.dryRun,
      author: opts.author,
      contribute: opts.contribute,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('collect-metrics')
  .description('Collect and aggregate system metrics across all agents')
  .action(() => {
    const env = resolveEnv();
    const report = collectMetrics(env.ctxRoot, env.org || undefined);
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('scrape-usage')
  .description('Parse Claude Code /usage output and store usage data')
  .argument('<agent>', 'Agent name')
  .argument('<output>', 'Usage output text to parse')
  .action((agent: string, output: string) => {
    const env = resolveEnv();
    const data = parseUsageOutput(output, agent);
    storeUsageData(env.ctxRoot, data);
    console.log(JSON.stringify(data, null, 2));
  });

busCommand
  .command('check-upstream')
  .description('Check canonical repo for framework updates')
  .option('--apply', 'Merge upstream changes (requires user approval)')
  .action((opts: { apply?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = checkUpstream(frameworkRoot, { apply: opts.apply });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('register-telegram-commands')
  .description('Register skills as Telegram bot commands')
  .argument('<bot-token>', 'Telegram bot token')
  .argument('<scan-dirs...>', 'Directories to scan for skills')
  .action(async (botToken: string, scanDirs: string[]) => {
    const commands = collectTelegramCommands(scanDirs);
    const result = await registerTelegramCommands(botToken, commands);
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('send-telegram')
  .description('Send a message to a Telegram chat')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message>', 'Message text (supports Telegram Markdown unless --plain-text is set)')
  .option('--image <path>', 'Send a photo with caption')
  .option('--file <path>', 'Send a document/file with caption (any file type)')
  .option('--plain-text', 'Skip Telegram Markdown parsing entirely. Use this when the message contains unescaped _, *, backtick, or [ that would otherwise trip the Markdown parser. Without this flag, sendMessage still retries once with parse_mode disabled on a parse-entity error — so it is purely an opt-in to save the retry roundtrip.', false)
  .action(async (chatId: string, message: string, opts: { image?: string; file?: string; plainText?: boolean }) => {
    // Codex agents emit literal '\n'/'\t' inside single-quoted bash where bash
    // does not expand escapes, so they arrive at argv as 2-char literals and
    // Telegram renders them as visible text. Normalize before send + log.
    message = message.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    // Resolve bot token: agent .env first, then process.env
    const env = resolveEnv();
    let botToken = '';

    // 1. Check agent .env (most specific)
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const content = readFileSync(agentEnv, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }

    // 2. Fall back to process env
    if (!botToken) {
      botToken = process.env.BOT_TOKEN || '';
    }

    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      let sentMessageId = 0;
      if (opts.image) {
        const result = await api.sendPhoto(chatId, opts.image, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else if (opts.file) {
        const result = await api.sendDocument(chatId, opts.file, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else {
        const result = await api.sendMessage(chatId, message, undefined, {
          parseMode: opts.plainText ? null : 'HTML',
        });
        sentMessageId = result?.result?.message_id ?? 0;
      }

      // Log outbound and cache last-sent for context injection
      const env = resolveEnv();
      if (env.agentName && env.ctxRoot) {
        logOutboundMessage(env.ctxRoot, env.agentName, chatId, message, sentMessageId, {
          parseMode: opts.plainText ? 'none' : 'html',
        });
        cacheLastSent(env.ctxRoot, env.agentName, chatId, message);
        // Auto-emit activity event so dashboard sees every Telegram send,
        // even from agents that never call log-event directly.
        try {
          const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
          const preview = message.length > 120 ? message.slice(0, 120) + '…' : message;
          logEvent(paths, env.agentName, env.org, 'message', 'telegram_sent', 'info', JSON.stringify({ chat_id: chatId, message_id: sentMessageId, preview }));
        } catch { /* non-fatal */ }
      }

      console.log('Message sent');
    } catch (err: any) {
      console.error(`Failed to send: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('react-telegram')
  .description("Set the bot's reaction on a Telegram message (single emoji ack)")
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'ID of the message to react to')
  .argument('[emoji]', 'Reaction emoji (default: 👍). Pass an empty string to clear.', '👍')
  .action(async (chatId: string, messageIdRaw: string, emoji: string) => {
    const messageId = Number(messageIdRaw);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      console.error(`Invalid message-id '${messageIdRaw}'. Must be a positive integer.`);
      process.exit(1);
    }

    // Resolve bot token: agent .env first, then process.env (same flow as
    // send-telegram so the agent identity / personality of the reaction
    // matches the agent that owns the conversation).
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const content = readFileSync(agentEnv, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      // Empty string clears the reaction; otherwise send a single-emoji array.
      // Telegram limits bots to one reaction per message; we treat that as the
      // primitive here. Multi-emoji is a future feature if/when needed.
      const emojis = emoji === '' ? [] : [emoji];
      await api.setMessageReaction(chatId, messageId, emojis);
      console.log(emojis.length > 0 ? `Reacted ${emoji}` : 'Reaction cleared');
    } catch (err: any) {
      console.error(`Failed to react: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('create-approval')
  .description('Request human approval for a high-stakes action')
  .argument('<title>', 'What you are requesting approval for')
  .argument('<category>', 'Category: external-comms, financial, deployment, data-deletion, other')
  .argument('[context]', 'Additional context')
  .action(async (title: string, category: string, context?: string) => {
    const validCategories: ApprovalCategory[] = ['external-comms', 'financial', 'deployment', 'data-deletion', 'other'];
    if (!validCategories.includes(category as ApprovalCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    // await — createApproval fan-out posts to the activity channel, which
    // must complete before the CLI process exits or the post silently
    // never sends. env.frameworkRoot is passed so the activity-channel
    // orgDir resolves to where activity-channel.env actually lives (the
    // framework repo path, NOT the runtime state path — see
    // src/bus/approval.ts:postApprovalToActivityChannel for the history).
    const id = await createApproval(paths, env.agentName, env.org, title, category as ApprovalCategory, context || '', env.frameworkRoot, env.agentDir);
    console.log(id);
  });

busCommand
  .command('update-approval')
  .description('Resolve an approval request')
  .argument('<id>', 'Approval ID')
  .argument('<status>', 'Resolution: approved or denied')
  .argument('[note]', 'Resolution note')
  .action((id: string, status: string, note?: string) => {
    const validStatuses: ApprovalStatus[] = ['approved', 'rejected'];
    if (!validStatuses.includes(status as ApprovalStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: approved, rejected`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    updateApproval(paths, id, status as ApprovalStatus, note);
    console.log(`Approval ${id} -> ${status}`);
  });

// ---------------------------------------------------------------------------
// Knowledge Base commands
// ---------------------------------------------------------------------------

busCommand
  .command('kb-query')
  .description('Query the knowledge base (RAG search)')
  .argument('<question>', 'Question or search query')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared, private, or all', 'all')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--threshold <f>', 'Minimum similarity score (0-1)', '0.5')
  .option('--json', 'Output raw JSON')
  .action((question: string, opts: { org?: string; agent?: string; scope?: string; topK?: string; threshold?: string; json?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const result = queryKnowledgeBase(
      resolvePaths(env.agentName, env.instanceId, org, env.ctxRoot),
      question,
      {
        org,
        agent: opts.agent || env.agentName,
        scope: (opts.scope as 'shared' | 'private' | 'all') || 'all',
        topK: parseInt(opts.topK || '5', 10),
        threshold: parseFloat(opts.threshold || '0.5'),
        frameworkRoot: env.frameworkRoot || process.cwd(),
        instanceId: env.instanceId,
      },
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.results.length === 0) {
      console.log(`No results found for: "${question}"`);
      return;
    }

    console.log(`\n  Knowledge Base Results (${result.results.length}/${result.total})\n`);
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  [${i + 1}] Score: ${r.score.toFixed(3)} | ${r.source_file}`);
      console.log(`      ${r.content.substring(0, 200).replace(/\n/g, ' ')}...`);
      console.log('');
    }
  });

busCommand
  .command('kb-ingest')
  .description('Ingest files or directories into the knowledge base')
  .argument('<paths...>', 'Files or directories to ingest')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared or private', 'shared')
  .option('--force', 'Re-ingest even if already indexed')
  .action((paths: string[], opts: { org?: string; agent?: string; scope?: string; force?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    ensureKBDirs(env.instanceId, env.frameworkRoot, org);

    ingestKnowledgeBase(paths, {
      org,
      agent: opts.agent || env.agentName,
      scope: (opts.scope as 'shared' | 'private') || 'shared',
      force: opts.force,
      frameworkRoot: env.frameworkRoot || process.cwd(),
      instanceId: env.instanceId,
    });
  });

busCommand
  .command('kb-collections')
  .description('List knowledge base collections and document counts')
  .option('--org <org>', 'Organization name')
  .action((opts: { org?: string }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const { execFileSync } = require('child_process');
    const { existsSync, readFileSync } = require('fs');
    const { join: pjoin } = require('path');
    const { homedir: hdir } = require('os');

    const frameworkRoot = env.frameworkRoot || process.cwd();
    const instanceId = env.instanceId;
    const kbRoot = pjoin(env.ctxRoot, 'orgs', org, 'knowledge-base');
    const chromaDir = pjoin(kbRoot, 'chromadb');
    const isWin = process.platform === 'win32';
    const venvBin = isWin ? 'Scripts' : 'bin';
    const pythonExe = isWin ? 'python.exe' : 'python3';
    const pythonPath = pjoin(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
    const mmragPath = pjoin(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

    // Load .env and secrets.env (same as bash `source`)
    const envFiles = [
      pjoin(frameworkRoot, '.env'),
      pjoin(frameworkRoot, 'orgs', org, 'secrets.env'),
    ];
    const extraVars: Record<string, string> = {};
    for (const ef of envFiles) {
      if (existsSync(ef)) {
        for (const line of readFileSync(ef, 'utf-8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            let val = trimmed.slice(idx + 1);
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            extraVars[trimmed.slice(0, idx)] = val;
          }
        }
      }
    }

    if (!existsSync(chromaDir)) {
      console.log('No collections found. Run kb-ingest first.');
      process.exit(0);
    }

    const envVars: Record<string, string | undefined> = {
      ...process.env,
      ...extraVars,
      CTX_ORG: org,
      CTX_INSTANCE_ID: instanceId,
      CTX_FRAMEWORK_ROOT: frameworkRoot,
      MMRAG_DIR: kbRoot,
      MMRAG_CHROMADB_DIR: chromaDir,
      MMRAG_CONFIG: pjoin(kbRoot, 'config.json'),
    };
    try {
      execFileSync(pythonPath, [mmragPath, 'collections'], {
        stdio: 'inherit',
        env: envVars,
      });
    } catch {
      // python printed error already
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Hook subcommands — cross-platform replacements for hook-*.sh bash scripts
// These are invoked by Claude Code settings.json hooks on all platforms.
// ---------------------------------------------------------------------------

function runHook(hookName: string): void {
  const hookPath = join(__dirname, `hooks/${hookName}.js`);
  const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

// ---------------------------------------------------------------------------
// Telegram utility commands — parity with bash edit-message / answer-callback
// ---------------------------------------------------------------------------

busCommand
  .command('edit-message')
  .description('Edit an existing Telegram message text and optionally update inline keyboard')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'Message ID to edit')
  .argument('<new-text>', 'Replacement text (Telegram Markdown)')
  .argument('[reply-markup]', 'Optional JSON inline keyboard markup (pass "null" to clear)')
  .action(async (chatId: string, messageId: string, newText: string, replyMarkup?: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = readFileSync(agentEnv, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    let markup: object | undefined;
    if (replyMarkup && replyMarkup !== 'null') {
      try { markup = JSON.parse(replyMarkup); } catch { console.error('Invalid reply-markup JSON'); process.exit(1); }
    } else {
      markup = { inline_keyboard: [] }; // clear keyboard
    }

    try {
      await api.editMessageText(parseInt(chatId, 10), parseInt(messageId, 10), newText, markup);
      console.log('Message edited');
    } catch (err: any) {
      console.error(`Failed to edit message: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('answer-callback')
  .description('Answer a Telegram callback query to dismiss button loading state')
  .argument('<callback-query-id>', 'Callback query ID from Telegram update')
  .argument('[toast-text]', 'Optional toast notification text', 'Got it')
  .action(async (callbackQueryId: string, toastText: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = readFileSync(agentEnv, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      await api.answerCallbackQuery(callbackQueryId, toastText);
      console.log('Callback answered');
    } catch (err: any) {
      console.error(`Failed to answer callback: ${err.message || err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Agent discovery and skill discovery
// ---------------------------------------------------------------------------

busCommand
  .command('list-agents')
  .description('Discover all agents in the system with their status and roles')
  .option('--org <org>', 'Filter by organization')
  .option('--status <filter>', 'Filter by status: running|all', 'all')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action(async (opts: { org?: string; status?: string; format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const frameworkRoot = env.frameworkRoot || process.cwd();

    // Collect agents from enabled-agents.json + filesystem scan
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    const agentMap: Record<string, { org: string; enabled: boolean }> = {};

    if (existsSync(enabledFile)) {
      try {
        const data = JSON.parse(readFileSync(enabledFile, 'utf-8'));
        for (const [name, cfg] of Object.entries(data as Record<string, any>)) {
          agentMap[name] = { org: cfg.org ?? '', enabled: cfg.enabled !== false };
        }
      } catch { /* skip corrupt */ }
    }

    // Also scan org agent directories
    const orgsDir = join(frameworkRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir)) {
        const agentsDir = join(orgsDir, org, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const name of readdirSync(agentsDir)) {
          if (!agentMap[name]) agentMap[name] = { org, enabled: true };
        }
      }
    }

    // Determine running agents via IPC daemon.
    const runningAgents = new Set<string>();
    const ipc = new IPCClient(env.instanceId);
    try {
      const resp = await ipc.send({ type: 'status', source: 'cortextos bus' });
      if (resp.success && Array.isArray(resp.data)) {
        for (const a of resp.data as Array<{ name: string; status: string }>) {
          if (a.status === 'running') runningAgents.add(a.name);
        }
      }
    } catch {
      // Daemon not running — no running agent data available
    }

    const results = [];
    for (const [name, info] of Object.entries(agentMap)) {
      if (opts.org && info.org !== opts.org) continue;

      const running = runningAgents.has(name);
      if (opts.status === 'running' && !running) continue;

      // Read role from IDENTITY.md
      let role = '';
      const agentDir = info.org
        ? join(frameworkRoot, 'orgs', info.org, 'agents', name)
        : join(frameworkRoot, 'agents', name);
      const identityFile = join(agentDir, 'IDENTITY.md');
      if (existsSync(identityFile)) {
        const content = readFileSync(identityFile, 'utf-8');
        const m = content.match(/^## Role\s*\n(.+)/m);
        if (m) role = m[1].trim();
      }

      // Read heartbeat
      const hbFile = join(ctxRoot, 'state', name, 'heartbeat.json');
      let lastHeartbeat = '', currentTask = '', mode = '';
      if (existsSync(hbFile)) {
        try {
          const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
          lastHeartbeat = hb.last_heartbeat ?? '';
          currentTask = hb.current_task ?? '';
          mode = hb.mode ?? '';
        } catch { /* skip */ }
      }

      results.push({ name, org: info.org, role, enabled: info.enabled, running, last_heartbeat: lastHeartbeat, current_task: currentTask, mode });
    }

    if (opts.format === 'text') {
      console.log(`Agents in system:\n`);
      for (const a of results) {
        const status = a.running ? 'RUNNING' : 'stopped';
        console.log(`  ${a.name} (${a.org || 'root'}) [${status}]`);
        if (a.role) console.log(`    Role: ${a.role}`);
        if (a.current_task) console.log(`    Working on: ${a.current_task}`);
        console.log('');
      }
      console.log(`Total: ${results.length} agents`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  });

busCommand
  .command('list-skills')
  .description('Discover available skills for the current agent')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action((opts: { format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const agentDir = env.agentDir || process.cwd();

    // Read template from config.json
    let template = '';
    const configFile = join(agentDir, 'config.json');
    if (existsSync(configFile)) {
      try { template = JSON.parse(readFileSync(configFile, 'utf-8')).template ?? ''; } catch { /* skip */ }
    }

    // Parse YAML frontmatter from SKILL.md
    function parseSkillFrontmatter(filePath: string): { name: string; description: string } | null {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let name = '', description = '';
        for (const line of lines) {
          if (line.trim() === '---') {
            if (inFrontmatter) break;
            inFrontmatter = true;
            continue;
          }
          if (!inFrontmatter) continue;
          const nm = line.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
          if (nm) name = nm[1];
          const dm = line.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
          if (dm) description = dm[1];
        }
        return name ? { name, description } : null;
      } catch { return null; }
    }

    type SkillInfo = { name: string; description: string; path: string; source: string };

    // Scan a skills directory, returns map of name -> skill info
    function scanSkillsDir(dir: string, source: string): Map<string, SkillInfo> {
      const map = new Map<string, SkillInfo>();
      if (!existsSync(dir)) return map;
      for (const entry of readdirSync(dir)) {
        const skillFile = join(dir, entry, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const parsed = parseSkillFrontmatter(skillFile);
        if (parsed) map.set(parsed.name, { ...parsed, path: skillFile, source });
      }
      return map;
    }

    // Merge in priority order: framework < template < agent (agent wins)
    const merged = new Map<string, SkillInfo>();
    for (const [k, v] of scanSkillsDir(join(frameworkRoot, '.claude', 'skills'), 'framework')) merged.set(k, v);
    if (template) {
      for (const [k, v] of scanSkillsDir(join(frameworkRoot, 'templates', template, '.claude', 'skills'), `template:${template}`)) merged.set(k, v);
    }
    for (const [k, v] of scanSkillsDir(join(agentDir, '.claude', 'skills'), 'agent')) merged.set(k, v);

    const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (opts.format === 'text') {
      console.log(`Available skills for ${env.agentName}:\n`);
      for (const s of skills) {
        console.log(`  ${s.name} (${s.source})`);
        if (s.description) console.log(`    ${s.description}`);
        console.log('');
      }
      console.log(`Total: ${skills.length} skills`);
    } else {
      console.log(JSON.stringify(skills, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Agent coordination: notify-agent, soft-restart, send-mobile-reply
// ---------------------------------------------------------------------------

busCommand
  .command('notify-agent')
  .description('Send urgent signal to another agent for immediate delivery via fast-checker')
  .argument('<agent>', 'Target agent name')
  .argument('<message>', 'Urgent message text')
  .action((targetAgent: string, message: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const ctxRoot = env.ctxRoot;

    // Write urgent signal file that fast-checker checks on every poll
    const signalDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(signalDir, { recursive: true });
    const signal = {
      from: env.agentName,
      message,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    writeFileSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

    // Also send via normal message bus for persistence
    try {
      sendMessage(paths, env.agentName, targetAgent, 'urgent', message);
    } catch { /* signal already written */ }

    console.log(`Signal sent to ${targetAgent}`);
  });

busCommand
  .command('soft-restart')
  .description('Gracefully restart another agent by writing the restart marker then sending /exit')
  .argument('<agent>', 'Target agent name to restart')
  .argument('[reason]', 'Reason for restart', 'user request via soft-restart')
  .action(async (targetAgent: string, reason: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;

    // Step 1: Write .user-restart marker BEFORE triggering exit
    const stateDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);
    console.log(`Wrote .user-restart marker for ${targetAgent}: ${reason}`);

    // Step 2: Send restart via IPC daemon (cross-platform — named pipe on Windows, socket on Unix).
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: targetAgent, source: 'cortextos bus soft-restart' });
      if (resp.success) {
        console.log(`Restarted ${targetAgent} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('soft-restart-all')
  .description('Soft-restart all enabled agents in the org with optional stagger delay')
  .option('--stagger <seconds>', 'Seconds between each agent restart', '5')
  .option('--reason <why>', 'Reason for restart', 'soft-restart-all requested')
  .action(async (opts: { stagger: string; reason: string }) => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const staggerMs = parseInt(opts.stagger, 10) * 1000;

    // Read enabled agents from config
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) {
      console.error('ERROR: enabled-agents.json not found at', enabledFile);
      process.exit(1);
    }
    const enabledAgents: Record<string, { enabled: boolean; org?: string }> =
      JSON.parse(readFileSync(enabledFile, 'utf-8'));

    // Filter to enabled agents in this org (if org set)
    const targets = Object.entries(enabledAgents)
      .filter(([, cfg]) => cfg.enabled !== false)
      .filter(([, cfg]) => !env.org || !cfg.org || cfg.org === env.org)
      .map(([name]) => name);

    if (targets.length === 0) {
      console.log('No enabled agents found for org:', env.org || '(all)');
      process.exit(0);
    }

    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting ${targets.length} agent(s) with ${opts.stagger}s stagger: ${targets.join(', ')}`);

    for (let i = 0; i < targets.length; i++) {
      const agent = targets[i];
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }
      // Write .user-restart marker
      const stateDir = join(ctxRoot, 'state', agent);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-restart'), opts.reason);

      // Send IPC restart signal
      const resp = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos bus soft-restart-all' });
      if (resp.success) {
        console.log(`[${i + 1}/${targets.length}] Restarted ${agent}`);
      } else {
        console.error(`[${i + 1}/${targets.length}] Failed to restart ${agent}: ${resp.error}`);
      }
    }

    console.log('soft-restart-all complete.');
  });

busCommand
  .command('send-mobile-reply')
  .description('Reply to a mobile app user message and ACK the inbox message')
  .argument('<agent>', 'Agent name sending the reply')
  .argument('<reply>', 'Reply text')
  .argument('[msg-id]', 'Inbox message ID to ACK')
  .action((agent: string, reply: string, msgId?: string) => {
    // Same literal '\n'/'\t' normalize as send-telegram (codex agent fix).
    reply = reply.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const { mkdirSync, appendFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;

    // Write to outbound-messages.jsonl so iOS app chat history picks it up
    const logDir = join(ctxRoot, 'logs', agent);
    mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent,
      text: reply,
      message_id: `mobile-reply-${Date.now()}`,
      type: 'text',
    });
    appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n');

    // ACK the original inbox message
    if (msgId) {
      const paths = resolvePaths(agent, env.instanceId, env.org, env.ctxRoot);
      try { ackInbox(paths, msgId); } catch { /* best effort */ }
    }

    console.log('Replied to mobile user');
  });

// ---------------------------------------------------------------------------
// list-approvals — was missing from CLI, only available via dashboard
// ---------------------------------------------------------------------------

busCommand
  .command('list-approvals')
  .description('List pending approval requests')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .option('--all-orgs', 'Scan all orgs under CTX_ROOT (matches dashboard view)', false)
  .action((opts: { format?: string; allOrgs?: boolean }) => {
    const { listPendingApprovals } = require('../bus/approval.js');
    const { readdirSync, existsSync } = require('fs');
    const { join, homedir: _homedir } = require('path');
    const { homedir } = require('os');
    const env = resolveEnv();

    let approvals: unknown[] = [];

    if (opts.allOrgs) {
      // Scan every org directory under CTX_ROOT — mirrors dashboard syncAll() behaviour
      const ctxRoot = env.ctxRoot;
      const orgsDir = join(ctxRoot, 'orgs');
      const orgs: string[] = existsSync(orgsDir)
        ? readdirSync(orgsDir, { withFileTypes: true })
            .filter((d: { isDirectory(): boolean }) => d.isDirectory())
            .map((d: { name: string }) => d.name)
        : [];
      for (const org of orgs) {
        const orgPaths = resolvePaths(env.agentName, env.instanceId, org, env.ctxRoot);
        approvals = approvals.concat(listPendingApprovals(orgPaths));
      }
    } else {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
      approvals = listPendingApprovals(paths);
    }

    if (opts.format === 'text') {
      if (approvals.length === 0) { console.log('No pending approvals'); return; }
      for (const a of approvals as Array<{ id: string; title: string; category: string; requesting_agent: string; created_at: string; description?: string; org?: string }>) {
        console.log(`[${a.id}] ${a.title}`);
        console.log(`  Category: ${a.category} | Agent: ${a.requesting_agent} | Org: ${a.org ?? env.org} | Created: ${a.created_at}`);
        if (a.description) console.log(`  Context: ${a.description}`);
        console.log('');
      }
      console.log(`Total: ${approvals.length} pending`);
    } else {
      console.log(JSON.stringify(approvals, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Reminder commands — persistent cron state that survives hard-restarts (#69)
// ---------------------------------------------------------------------------

busCommand
  .command('create-reminder')
  .argument('<fire-at>', 'When to fire, ISO 8601 UTC (e.g. 2026-04-05T08:00:00Z)')
  .argument('<prompt>', 'Text to inject into boot prompt when overdue')
  .description('Create a persistent reminder that survives hard-restarts')
  .action((fireAt: string, prompt: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const reminder = createReminder(paths, fireAt, prompt);
    console.log(reminder.id);
  });

busCommand
  .command('list-reminders')
  .option('--all', 'Include acked reminders', false)
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .description('List pending (or all) reminders')
  .action((opts: { all?: boolean; format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const reminders = listReminders(paths, { all: opts.all });

    if (opts.format === 'json') {
      console.log(JSON.stringify(reminders, null, 2));
      return;
    }

    if (reminders.length === 0) {
      console.log('No pending reminders');
      return;
    }

    const now = Date.now();
    for (const r of reminders) {
      const overdue = Date.parse(r.fire_at) <= now;
      const overdueTag = overdue ? ' [OVERDUE]' : '';
      console.log(`[${r.id}]${overdueTag}`);
      console.log(`  fire_at: ${r.fire_at}  status: ${r.status}`);
      console.log(`  prompt:  ${r.prompt}`);
      console.log('');
    }
  });

busCommand
  .command('ack-reminder')
  .argument('<id>', 'Reminder ID to acknowledge')
  .description('Mark a reminder as handled')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    ackReminder(paths, id);
    console.log(`ACK'd reminder ${id}`);
  });

busCommand
  .command('prune-reminders')
  .option('--days <n>', 'Retain acked reminders for N days', '7')
  .description('Delete acked reminders older than N days')
  .action((opts: { days?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const pruned = pruneReminders(paths, parseInt(opts.days ?? '7', 10));
    console.log(`Pruned ${pruned} acked reminder(s)`);
  });

busCommand
  .command('update-cron-fire')
  .argument('<cron-name>', 'Name of the cron as defined in config.json')
  .option('--interval <interval>', 'Expected interval, e.g. "6h", "24h", "30m"')
  .description('Record that a named cron just fired (enables daemon gap detection for dead zones)')
  .action((cronName: string, opts: { interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    updateCronFire(paths.stateDir, cronName, opts.interval);
    console.log(`Recorded fire for cron "${cronName}"`);
  });

// ---------------------------------------------------------------------------
// External Persistent Cron Management (Subtask 1.4)
// ---------------------------------------------------------------------------

/**
 * Validate a schedule string — either an interval shorthand ("6h", "30m") or
 * a 5-field cron expression ("0 8 * * *").  Returns the normalised schedule
 * string, or throws an Error with a human-readable message on failure.
 */
function validateSchedule(raw: string): string {
  const trimmed = raw.trim();
  // Detect format by counting whitespace-separated tokens
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Interval shorthand: must match parseDurationMs
    if (isNaN(parseDurationMs(trimmed))) {
      throw new Error(
        `Invalid interval '${trimmed}'. Expected formats: "6h", "30m", "1d", "2w".`
      );
    }
    return trimmed;
  }
  if (tokens.length === 5) {
    // 5-field cron expression: validate by computing a next fire time
    const probe = nextFireFromCron(trimmed, Date.now());
    if (isNaN(probe)) {
      throw new Error(
        `Invalid cron expression '${trimmed}'. Expected 5-field cron ("0 8 * * *", "*/30 * * * *", etc.).`
      );
    }
    return trimmed;
  }
  throw new Error(
    `Invalid schedule '${trimmed}'. Use an interval ("6h") or a 5-field cron expression ("0 8 * * *").`
  );
}

/**
 * Check whether an agent exists in the current framework root.
 * Returns false if the framework root is unknown (graceful degradation).
 */
function agentExistsInFramework(agentName: string, frameworkRoot: string): boolean {
  if (!frameworkRoot) return true; // can't check — allow
  const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs');
  const { join: pjoin } = require('path');
  const orgsDir = pjoin(frameworkRoot, 'orgs');
  if (!fsExists(orgsDir)) return true; // no orgs dir — allow
  try {
    for (const org of fsReaddir(orgsDir)) {
      if (fsExists(pjoin(orgsDir, org, 'agents', agentName))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Format an ISO timestamp for display (shortens to "YYYY-MM-DD HH:mm UTC").
 */
function fmtTs(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Send a reload-crons IPC signal to the daemon (non-blocking, best-effort).
 * Silently swallows errors — the daemon will pick up changes on its next tick.
 */
async function signalCronReload(agentName: string, instanceId: string): Promise<void> {
  try {
    const ipc = new IPCClient(instanceId);
    await ipc.send({ type: 'reload-crons', agent: agentName, source: 'cortextos bus cron-cmd' });
  } catch { /* non-fatal — scheduler picks up file change on next 30s tick */ }
}

busCommand
  .command('add-cron')
  .description('Add a new persistent cron for an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name (unique per agent, slug format recommended)')
  .argument('<interval>', 'Schedule: interval ("6h", "30m", "1d") or 5-field cron expr ("0 8 * * *")')
  .argument('<prompt...>', 'Prompt text injected when the cron fires (all remaining words joined)')
  .option('--desc <description>', 'Human-readable description (optional)')
  .action(async (agent: string, name: string, interval: string, promptWords: string[], opts: { desc?: string }) => {
    // Validate agent name format
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const env = resolveEnv();

    // Validate agent exists in framework
    if (!agentExistsInFramework(agent, env.frameworkRoot)) {
      console.error(`Error: agent '${agent}' not found in framework. Check orgs/*/agents/ directory.`);
      process.exit(1);
    }

    // Validate schedule
    let schedule: string;
    try { schedule = validateSchedule(interval); } catch (err) { console.error(String(err)); process.exit(1); }

    const prompt = promptWords.join(' ');
    const cron: CronDefinition = {
      name,
      prompt,
      schedule,
      enabled: true,
      created_at: new Date().toISOString(),
      ...(opts.desc ? { description: opts.desc } : {}),
    };

    try {
      addCron(agent, cron);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    await signalCronReload(agent, env.instanceId);
    console.log(`Added cron '${name}' for ${agent}`);
  });

busCommand
  .command('remove-cron')
  .description('Remove a persistent cron from an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to remove')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const removed = removeCron(agent, name);
    if (!removed) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Removed cron '${name}' from ${agent}`);
  });

busCommand
  .command('list-crons')
  .description('List all persistent crons configured for an agent')
  .argument('<agent>', 'Agent name')
  .option('--json', 'Emit raw JSON instead of a formatted table')
  .action((agent: string, opts: { json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const crons = readCrons(agent);

    // BUG 1 fix: merge cron-state.json's `last_fire` records into the displayed
    // last-fire timestamp. The daemon writes fire timestamps to two surfaces:
    //   - crons.json `last_fired_at` (via cron-scheduler.updateCron)
    //   - cron-state.json `last_fire` (via bus update-cron-fire from agent skills)
    // For a single source of truth in the CLI, take the most recent of the two.
    const env = resolveEnv();
    const paths = resolvePaths(agent, env.instanceId, env.org, env.ctxRoot);
    const stateRecords = readCronState(paths.stateDir).crons;
    const fireByName = new Map<string, string>();
    for (const rec of stateRecords) fireByName.set(rec.name, rec.last_fire);

    const mostRecent = (a?: string, b?: string): string | undefined => {
      if (!a) return b;
      if (!b) return a;
      return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
    };

    if (opts.json) {
      const enriched = crons.map(c => ({
        ...c,
        last_fired_at: mostRecent(c.last_fired_at, fireByName.get(c.name)),
      }));
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    if (crons.length === 0) {
      console.log(`No crons configured for ${agent}`);
      return;
    }

    // Compute next_fire_at for each cron so the table is informative
    const now = Date.now();
    const rows = crons.map(c => {
      const lastFire = mostRecent(c.last_fired_at, fireByName.get(c.name));
      let nextFire = '-';
      const dms = parseDurationMs(c.schedule);
      if (!isNaN(dms)) {
        const refMs = lastFire ? new Date(lastFire).getTime() : now;
        nextFire = fmtTs(new Date(refMs + dms).toISOString());
      } else {
        const nf = nextFireFromCron(c.schedule, now);
        if (!isNaN(nf)) nextFire = fmtTs(new Date(nf).toISOString());
      }
      const promptPreview = c.prompt.length > 60 ? c.prompt.slice(0, 57) + '...' : c.prompt;
      return {
        name: c.name,
        schedule: c.schedule,
        enabled: c.enabled ? 'yes' : 'no',
        last_fire: fmtTs(lastFire),
        next_fire: nextFire,
        prompt: promptPreview,
      };
    });

    // Column widths
    const nameW = Math.max(4, ...rows.map(r => r.name.length));
    const schedW = Math.max(8, ...rows.map(r => r.schedule.length));
    const enW = 7;
    const lastW = 18;
    const nextW = 18;

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = '-'.repeat(nameW + schedW + enW + lastW + nextW + 63 + 5);

    console.log(`\nCrons for ${agent} (${rows.length})\n`);
    console.log(`  ${pad('Name', nameW)}  ${pad('Schedule', schedW)}  ${pad('Enabled', enW)}  ${pad('Last Fire', lastW)}  ${pad('Next Fire', nextW)}  Prompt`);
    console.log(`  ${sep}`);
    for (const r of rows) {
      console.log(`  ${pad(r.name, nameW)}  ${pad(r.schedule, schedW)}  ${pad(r.enabled, enW)}  ${pad(r.last_fire, lastW)}  ${pad(r.next_fire, nextW)}  ${r.prompt}`);
    }
    console.log('');
  });

busCommand
  .command('update-cron')
  .description('Update fields of an existing persistent cron')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to update')
  .option('--interval <i>', 'New schedule (interval or cron expression)')
  .option('--cron-expr <e>', 'Alias for --interval (5-field cron expression)')
  .option('--prompt <p>', 'New prompt text')
  .option('--enabled <bool>', 'Enable (true) or disable (false) the cron')
  .option('--desc <d>', 'New description')
  .action(async (agent: string, name: string, opts: { interval?: string; cronExpr?: string; prompt?: string; enabled?: string; desc?: string }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const rawSchedule = opts.interval ?? opts.cronExpr;
    if (!rawSchedule && opts.prompt === undefined && opts.enabled === undefined && opts.desc === undefined) {
      console.error('Error: at least one of --interval, --cron-expr, --prompt, --enabled, or --desc is required.');
      process.exit(1);
    }

    const patch: Partial<CronDefinition> = {};

    if (rawSchedule !== undefined) {
      try { patch.schedule = validateSchedule(rawSchedule); } catch (err) { console.error(String(err)); process.exit(1); }
    }
    if (opts.prompt !== undefined) {
      patch.prompt = opts.prompt;
    }
    if (opts.enabled !== undefined) {
      if (opts.enabled !== 'true' && opts.enabled !== 'false') {
        console.error(`Error: --enabled must be 'true' or 'false', got '${opts.enabled}'.`);
        process.exit(1);
      }
      patch.enabled = opts.enabled === 'true';
    }
    if (opts.desc !== undefined) {
      patch.description = opts.desc;
    }

    const ok = updateCronDef(agent, name, patch);
    if (!ok) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Updated cron '${name}' for ${agent}`);
  });

busCommand
  .command('test-cron-fire')
  .description('Fire a cron immediately for testing (injects prompt into agent PTY via daemon IPC)')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to fire')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const cron = getCronByName(agent, name);
    if (!cron) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    const ipc = new IPCClient(env.instanceId);

    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('Error: daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    const resp = await ipc.send({
      type: 'fire-cron',
      agent,
      data: { name: cron.name, prompt: cron.prompt },
      source: 'cortextos bus test-cron-fire',
    });

    if (!resp.success) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }

    console.log(`Fired cron '${name}' for ${agent}`);
  });

busCommand
  .command('get-cron-log')
  .description('Display cron execution log entries for an agent')
  .argument('<agent>', 'Agent name')
  .argument('[name]', 'Cron name to filter by (optional — omit to show all crons)')
  .option('--limit <n>', 'Maximum number of entries to show (default: 50)', '50')
  .option('--json', 'Emit raw JSON array instead of a formatted table')
  .action((agent: string, name: string | undefined, opts: { limit?: string; json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const limit = parseInt(opts.limit ?? '50', 10);
    if (isNaN(limit) || limit < 0) {
      console.error(`Error: --limit must be a non-negative integer, got '${opts.limit}'.`);
      process.exit(1);
    }

    const entries = getExecutionLog(agent, name, limit);

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      if (name !== undefined) {
        console.log(`No log entries for cron '${name}' on ${agent}`);
      } else {
        console.log(`No log entries for ${agent}`);
      }
      return;
    }

    // Human-readable table: ts | cron | status | attempt | duration | error
    const pad = (s: string, w: number) => s.padEnd(w);
    const header = `  ${pad('Timestamp', 20)}  ${pad('Cron', 22)}  ${pad('Status', 7)}  ${pad('Att', 3)}  ${pad('ms', 7)}  Error`;
    const sep = '-'.repeat(header.length);

    console.log(`\nExecution log for ${agent}${name ? ` / ${name}` : ''} (${entries.length} entries)\n`);
    console.log(header);
    console.log(`  ${sep}`);

    for (const e of entries) {
      const ts = e.ts.replace('T', ' ').slice(0, 19) + 'Z';
      const status = e.status;
      const att = String(e.attempt);
      const ms = String(e.duration_ms);
      const error = e.error ?? '';
      const cronPad = pad(e.cron.length > 22 ? e.cron.slice(0, 19) + '...' : e.cron, 22);
      console.log(
        `  ${pad(ts, 20)}  ${cronPad}  ${pad(status, 7)}  ${pad(att, 3)}  ${pad(ms, 7)}  ${error}`
      );
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// migrate-crons — Subtask 2.2: Manual one-shot migration command
// ---------------------------------------------------------------------------

busCommand
  .command('migrate-crons')
  .description('Migrate crons from config.json to crons.json for one or all agents')
  .argument('[agent]', 'Agent name to migrate (omit to migrate all enabled agents)')
  .option('--force', 'Re-run migration even if the marker file already exists')
  .action(async (agentArg: string | undefined, opts: { force?: boolean }) => {
    const { migrateCronsForAgent: migrateSingle, migrateAllAgents: migrateAll } = await import('../daemon/cron-migration.js');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const log = (msg: string) => console.log(msg);
    const migOpts = { force: opts.force ?? false, log };

    if (agentArg) {
      // Single-agent migration
      try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }

      // Resolve config.json path via filesystem scan
      const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs') as typeof import('fs');
      const orgsDir = join(frameworkRoot, 'orgs');
      let configPath: string | undefined;
      if (fsExists(orgsDir)) {
        try {
          for (const org of fsReaddir(orgsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
            const candidate = join(orgsDir, org, 'agents', agentArg, 'config.json');
            if (fsExists(candidate)) { configPath = candidate; break; }
          }
        } catch { /* ignore scan errors */ }
      }

      if (!configPath) {
        console.error(`Error: agent '${agentArg}' not found in framework. Check orgs/*/agents/ directory.`);
        process.exit(1);
      }

      const result = migrateSingle(agentArg, configPath, ctxRoot, migOpts);

      switch (result.status) {
        case 'skipped-already-migrated':
          console.log(`Skipped ${agentArg}: already migrated (use --force to re-run)`);
          break;
        case 'no-config':
          console.log(`Skipped ${agentArg}: no config.json found`);
          break;
        case 'no-crons':
          console.log(`Skipped ${agentArg}: config.json has no crons — empty crons.json written`);
          break;
        case 'migrated':
          console.log(
            `Migrated ${agentArg}: ${result.cronsMigrated} cron(s) migrated` +
            (result.cronsSkipped?.length ? `, ${result.cronsSkipped.length} skipped (${result.cronsSkipped.join(', ')})` : '')
          );
          break;
      }
    } else {
      // All-agents migration
      const summary = migrateAll(frameworkRoot, ctxRoot, migOpts);

      const migrated = summary.results.filter(r => r.status === 'migrated').length;
      const skippedAlready = summary.results.filter(r => r.status === 'skipped-already-migrated').length;
      const noConfig = summary.results.filter(r => r.status === 'no-config').length;
      const noCrons = summary.results.filter(r => r.status === 'no-crons').length;

      console.log(`\nMigration summary:`);
      console.log(`  Agents processed    : ${summary.processed}`);
      console.log(`  Agents migrated     : ${migrated} (${summary.totalCronsMigrated} crons)`);
      console.log(`  Already migrated    : ${skippedAlready}`);
      console.log(`  No config.json      : ${noConfig}`);
      console.log(`  No crons in config  : ${noCrons}`);
    }
  });

// ---------------------------------------------------------------------------
// upgrade-cron-teaching — Subtask 2.4: scan agent workspace for stale
// CronCreate / /loop / config.json cron-registration teaching that predates
// the external-persistent-crons migration.  Scan-only by default; --apply
// performs only the safe literal substitutions known not to depend on
// surrounding context.
// ---------------------------------------------------------------------------

busCommand
  .command('upgrade-cron-teaching')
  .description('Scan agent workspace files for stale CronCreate/loop/config.json cron teaching')
  .argument('[agent]', 'Agent name to scan (omit to scan all agents under orgs/)')
  .option('--apply', 'Perform safe literal substitutions in place (does not rewrite CronCreate references)')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action(async (
    agentArg: string | undefined,
    opts: { apply?: boolean; json?: boolean },
  ) => {
    const { scanAgentDir, groupMatchesByFile } =
      await import('../utils/cron-teaching-scanner.js');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const { existsSync: fsExists, readdirSync: fsReaddir } =
      require('fs') as typeof import('fs');

    // Resolve agent name to its absolute workspace dir (orgs/*/agents/AGENT).
    function resolveAgentDir(agent: string): string | undefined {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (!fsExists(orgsDir)) return undefined;
      try {
        for (const entry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = join(orgsDir, entry.name, 'agents', agent);
          if (fsExists(candidate)) return candidate;
        }
      } catch {
        // ignore scan errors
      }
      return undefined;
    }

    // List every agent dir under orgs/ORG/agents/.
    function listAllAgents(): { agent: string; dir: string }[] {
      const orgsDir = join(frameworkRoot, 'orgs');
      const out: { agent: string; dir: string }[] = [];
      if (!fsExists(orgsDir)) return out;
      try {
        for (const orgEntry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!orgEntry.isDirectory()) continue;
          const agentsRoot = join(orgsDir, orgEntry.name, 'agents');
          if (!fsExists(agentsRoot)) continue;
          for (const a of fsReaddir(agentsRoot, { withFileTypes: true })) {
            if (a.isDirectory() && !a.name.startsWith('.')) {
              out.push({ agent: a.name, dir: join(agentsRoot, a.name) });
            }
          }
        }
      } catch {
        // ignore scan errors
      }
      return out;
    }

    type Report = {
      agent: string;
      result: ReturnType<typeof scanAgentDir>;
    };

    const reports: Report[] = [];
    if (agentArg) {
      try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }
      const dir = resolveAgentDir(agentArg);
      if (!dir) {
        console.error(`Error: agent '${agentArg}' not found under ${join(frameworkRoot, 'orgs')}/*/agents/`);
        process.exit(1);
      }
      reports.push({ agent: agentArg, result: scanAgentDir(dir, { apply: opts.apply }) });
    } else {
      for (const { agent, dir } of listAllAgents()) {
        reports.push({ agent, result: scanAgentDir(dir, { apply: opts.apply }) });
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(
        reports.map((r) => ({
          agent: r.agent,
          agentDir: r.result.agentDir,
          scannedFiles: r.result.scannedFiles,
          skippedSentinelFiles: r.result.skippedSentinelFiles,
          appliedSubstitutions: r.result.appliedSubstitutions,
          matches: r.result.matches,
        })),
        null,
        2,
      ));
      const totalMatches = reports.reduce((sum, r) => sum + r.result.matches.length, 0);
      process.exit(totalMatches === 0 ? 0 : 1);
    }

    let totalMatches = 0;
    let totalApplied = 0;
    for (const { agent, result } of reports) {
      totalMatches += result.matches.length;
      totalApplied += result.appliedSubstitutions;

      if (result.matches.length === 0 && result.appliedSubstitutions === 0) {
        console.log(`✓ ${agent}: no stale cron-teaching references (${result.scannedFiles.length} files scanned)`);
        continue;
      }

      console.log(`\n${agent}: ${result.matches.length} stale reference(s) in ${result.scannedFiles.length} files`);
      if (result.skippedSentinelFiles.length > 0) {
        console.log(`  (skipped ${result.skippedSentinelFiles.length} sentinel-marked file(s): ${result.skippedSentinelFiles.map((f) => f.replace(result.agentDir + '/', '')).join(', ')})`);
      }
      const grouped = groupMatchesByFile(result.matches);
      for (const [file, matches] of grouped) {
        const rel = file.replace(result.agentDir + '/', '');
        console.log(`\n  ${rel}`);
        for (const m of matches) {
          console.log(`    L${m.line} [${m.pattern}]: ${m.excerpt}`);
          console.log(`      → ${m.suggestion}`);
        }
      }
      if (result.appliedSubstitutions > 0) {
        console.log(`\n  Applied ${result.appliedSubstitutions} safe substitution(s) in place.`);
      }
    }

    console.log(`\nSummary: ${totalMatches} stale reference(s) across ${reports.length} agent(s)` +
      (opts.apply ? `, ${totalApplied} substitution(s) applied.` : '.'));
    if (totalMatches > 0 && !opts.apply) {
      console.log(`Run with --apply to substitute the safe-rewritable patterns. CronCreate / /loop references must be updated manually.`);
    }
    process.exit(totalMatches === 0 ? 0 : 1);
  });

busCommand
  .command('hook-context-status')
  .description('StatusLine hook: writes context window % to state/context_status.json')
  .action(() => runHook('hook-context-status'));

busCommand
  .command('hook-ask-telegram')
  .description('PreToolUse hook: forward AskUserQuestion to Telegram (cross-platform)')
  .action(() => runHook('hook-ask-telegram'));

busCommand
  .command('hook-permission-telegram')
  .description('PermissionRequest hook: send approve/deny request to Telegram (cross-platform)')
  .action(() => runHook('hook-permission-telegram'));

busCommand
  .command('hook-planmode-telegram')
  .description('ExitPlanMode hook: send plan for review to Telegram (cross-platform)')
  .action(() => runHook('hook-planmode-telegram'));

busCommand
  .command('hook-compact-telegram')
  .description('PreCompact hook: notify user via Telegram when context compaction starts (#18)')
  .action(() => runHook('hook-compact-telegram'));

busCommand
  .command('hook-idle-flag')
  .description('Stop hook: writes last_idle.flag timestamp so fast-checker knows agent finished its turn')
  .action(() => runHook('hook-idle-flag'));

busCommand
  .command('hook-loop-detector')
  .description('PreToolUse hook: detects and blocks repeated tool loops (same-args repetition + ping-pong alternation)')
  .action(() => runHook('hook-loop-detector'));

// --- OAuth token rotation commands ---

busCommand
  .command('check-usage-api')
  .description('Fetch Claude OAuth utilization from Anthropic usage API (3-min TTL cache)')
  .option('--account <name>', 'Check specific account (default: active account)')
  .option('--force', 'Bypass cache and fetch fresh data')
  .option('--json', 'Output as JSON')
  .action(async (opts: { account?: string; force?: boolean; json?: boolean }) => {
    const env = resolveEnv();
    try {
      const result = await checkUsageApi(env.ctxRoot, { force: opts.force, account: opts.account });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const cached = result.cached ? ' (cached)' : '';
        const warn5h = result.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
        const warn7d = result.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
        console.log(`Account: ${result.account}${cached}`);
        console.log(`5h utilization:  ${pct(result.five_hour_utilization)}${warn5h}`);
        console.log(`7d utilization:  ${pct(result.seven_day_utilization)}${warn7d}`);
        console.log(`Fetched at: ${result.fetched_at}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('refresh-oauth-token')
  .description('Refresh OAuth token for an account using its refresh_token (one-time use — writes atomically)')
  .option('--account <name>', 'Account to refresh (default: active account)')
  .action(async (opts: { account?: string }) => {
    const env = resolveEnv();
    try {
      const result = await refreshOAuthToken(env.ctxRoot, opts.account);
      const expiresIn = Math.round((result.expires_at - Date.now()) / 1000 / 60);
      console.log(`Refreshed account: ${result.account}`);
      console.log(`New token expires in: ${expiresIn} minutes`);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('rotate-oauth')
  .description('Rotate to the next OAuth account if utilization thresholds are met')
  .option('--force', 'Force rotation regardless of utilization')
  .option('--agent <name>', 'Only update this agent\'s .env (default: all agents in org)')
  .option('--reason <text>', 'Reason for rotation (logged)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { force?: boolean; agent?: string; reason?: string; json?: boolean }) => {
    const env = resolveEnv();
    if (!env.frameworkRoot) {
      console.error('CTX_FRAMEWORK_ROOT is required for rotate-oauth');
      process.exit(1);
    }
    try {
      const result = await rotateOAuth(env.ctxRoot, env.frameworkRoot, env.org, {
        force: opts.force,
        agent: opts.agent,
        reason: opts.reason,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.rotated) {
        console.log(`Rotated: ${result.from} → ${result.to}`);
        console.log(`Reason: ${result.reason}`);
      } else {
        console.log(`No rotation needed: ${result.reason}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('list-oauth-accounts')
  .description('List all OAuth accounts and their utilization')
  .action((opts: Record<string, unknown>) => {
    const env = resolveEnv();
    const store = loadAccounts(env.ctxRoot);
    if (!store) {
      console.log('No accounts.json found at state/oauth/accounts.json');
      return;
    }
    for (const [name, acct] of Object.entries(store.accounts)) {
      const active = name === store.active ? ' (active)' : '';
      const expiry = new Date(acct.expires_at).toISOString();
      const warn5h = acct.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
      const warn7d = acct.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
      console.log(`${name}${active}`);
      console.log(`  5h: ${pct(acct.five_hour_utilization)}${warn5h}  7d: ${pct(acct.seven_day_utilization)}${warn7d}  expires: ${expiry}`);
    }
  });

busCommand
  .command('tui-stream')
  .description('Stream Claude Code TUI tool activity to the event log and optionally Telegram')
  .option('--session <name>', 'tmux session name (defaults to CTX_AGENT_NAME)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('--telegram', 'Forward high-signal events to Telegram chat', false)
  .option('--dry-run', 'Print events to stdout instead of logging', false)
  .action(async (opts: { session?: string; interval: string; telegram: boolean; dryRun: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const sessionName = opts.session || env.agentName;
    const pollMs = Math.max(500, parseInt(opts.interval, 10) || 2000);

    // High-signal patterns: tool calls that indicate real work
    const HIGH_SIGNAL = [
      /^[├│└].*Tool:\s*(Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|Agent)/i,
      /^[├│└].*Running bash command/i,
      /^[├│└].*Editing file/i,
      /^[├│└].*Writing file/i,
      /^[├│└].*Reading file/i,
      /error|Error|ERROR/,
      /✓.*completed|✗.*failed/i,
      /Permission (request|denied|approved)/i,
    ];

    const TOOL_LINE = /^[├│└▶◆●]|^(Tool|Bash|Edit|Write|Read|Glob|Grep|Agent):/i;

    let prevOutput = '';
    let telegramApi: any = null;
    let chatId: string | undefined;

    // Set up Telegram if requested
    if (opts.telegram) {
      const { TelegramAPI } = await import('../telegram/api.js');
      const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
      const envPath = join(agentDir, '.env');
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
        const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
        if (botTokenMatch && chatIdMatch) {
          telegramApi = new TelegramAPI(botTokenMatch[1].trim());
          chatId = chatIdMatch[1].trim();
        }
      }
    }

    const logLine = (msg: string) => {
      if (opts.dryRun) {
        console.log(msg);
      }
    };

    let lastTelegramSent = 0;
    const TELEGRAM_COOLDOWN_MS = 10000; // max 1 Telegram message per 10s

    logLine(`[tui-stream] Watching tmux session: ${sessionName} (poll: ${pollMs}ms)`);

    // Poll loop
    while (true) {
      try {
        // Capture current tmux pane content
        let currentOutput = '';
        try {
          const result = execFileSync('tmux', ['capture-pane', '-t', sessionName, '-p'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          currentOutput = result;
        } catch {
          // Session not found or tmux not available — wait and retry
          await sleepMs(pollMs * 5);
          continue;
        }

        // Diff: find new lines appended since last poll
        const prevLines = prevOutput.split('\n');
        const currLines = currentOutput.split('\n');
        const newLines = currLines.length > prevLines.length
          ? currLines.slice(prevLines.length - 1)
          : currLines.filter(l => !prevOutput.includes(l));

        prevOutput = currentOutput;

        if (newLines.length === 0) {
          await sleepMs(pollMs);
          continue;
        }

        // Filter to tool-call lines only
        const toolLines = newLines.filter(l => {
          const t = l.trim();
          return t.length > 0 && (TOOL_LINE.test(t) || t.startsWith('●') || t.startsWith('◆'));
        });

        for (const line of toolLines) {
          const trimmed = line.trim().slice(0, 200);
          const isHighSignal = HIGH_SIGNAL.some(re => re.test(trimmed));

          // Log to event bus
          if (!opts.dryRun) {
            try {
              logEvent(paths, env.agentName, env.org, 'agent_activity' as any, 'tool_call', 'info', {
                line: trimmed,
                session: sessionName,
                high_signal: isHighSignal,
              });
            } catch { /* Never fail the stream */ }
          } else {
            logLine(`[event] ${trimmed}`);
          }

          // Forward high-signal events to Telegram (rate-limited)
          if (isHighSignal && opts.telegram && telegramApi && chatId) {
            const now = Date.now();
            if (now - lastTelegramSent >= TELEGRAM_COOLDOWN_MS) {
              lastTelegramSent = now;
              try {
                await telegramApi.sendMessage(chatId, `[${env.agentName}] ${trimmed}`);
              } catch { /* Never fail the stream */ }
            }
          }
        }
      } catch {
        // Continue on any error
      }

      await sleepMs(pollMs);
    }
  });

// --- fix-agent-settings ---

busCommand
  .command('fix-agent-settings')
  .description('Patch all agent settings.json files: add missing allowlist tools and statusLine hook')
  .option('--dry-run', 'Show what would be changed without writing')
  .action((opts: { dryRun?: boolean }) => {
    const { existsSync: fsExists, readdirSync: fsReaddir, readFileSync: fsRead, writeFileSync: fsWrite } = require('fs');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const orgsDir = join(frameworkRoot, 'orgs');

    const REQUIRED_ALLOW = [
      'Bash', 'Read', 'Edit', 'Write',
      'Glob', 'Grep',
      'WebFetch', 'WebSearch',
      'ToolSearch', 'CronCreate', 'CronList', 'CronDelete',
      'Skill', 'Agent',
    ];
    const STATUS_LINE = {
      type: 'command',
      command: 'cortextos bus hook-context-status',
      refreshInterval: 5,
      timeout: 2,
    };

    if (!fsExists(orgsDir)) {
      console.error('orgs/ directory not found at', orgsDir);
      process.exit(1);
    }

    let patched = 0;
    let skipped = 0;

    for (const org of fsReaddir(orgsDir)) {
      const agentsDir = join(orgsDir, org, 'agents');
      if (!fsExists(agentsDir)) continue;
      for (const agent of fsReaddir(agentsDir)) {
        const settingsPath = join(agentsDir, agent, '.claude', 'settings.json');
        if (!fsExists(settingsPath)) continue;

        let settings: any;
        try { settings = JSON.parse(fsRead(settingsPath, 'utf-8')); }
        catch { console.warn(`  SKIP ${agent}: could not parse settings.json`); skipped++; continue; }

        const changes: string[] = [];

        // Check allow list
        const current: string[] = settings?.permissions?.allow ?? [];
        const missing = REQUIRED_ALLOW.filter(t => !current.includes(t));
        if (missing.length > 0) changes.push(`allow: +[${missing.join(', ')}]`);

        // Check statusLine
        if (!settings.statusLine) changes.push('statusLine: add hook-context-status');

        if (changes.length === 0) {
          console.log(`  OK   ${agent}: already up to date`);
          skipped++;
          continue;
        }

        if (opts.dryRun) {
          console.log(`  DRY  ${agent}: would apply [${changes.join('; ')}]`);
          patched++;
        } else {
          settings.permissions = settings.permissions ?? {};
          settings.permissions.allow = [...current, ...missing];
          settings.statusLine = STATUS_LINE;
          fsWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          console.log(`  FIX  ${agent}: applied [${changes.join('; ')}]`);
          patched++;
        }
      }
    }

    const verb = opts.dryRun ? 'Would patch' : 'Patched';
    console.log(`\n${verb} ${patched} agent(s). ${skipped} already up to date or skipped.`);
    if (!opts.dryRun && patched > 0) {
      console.log('\nRestart affected agents to apply the new settings:');
      console.log('  cortextos restart <agent-name>');
    }
  });

// --- CRM Commands ---

const crmContacts = busCommand.command('crm-contacts').description('CRM contact operations');

crmContacts.command('list')
  .option('--search <query>', 'Search by name or email')
  .option('--company <id>', 'Filter by company ID')
  .option('--source <source>', 'Filter by source')
  .action((opts: { search?: string; company?: string; source?: string }) => {
    const db = getCrmDb();
    const contacts = crm.listContacts(db, opts);
    if (contacts.length === 0) { console.log('No contacts found.'); return; }
    for (const c of contacts) {
      console.log(`${c.id}  ${c.name}  ${c.email ?? '-'}  ${c.source ?? '-'}`);
    }
    console.log(`\n${contacts.length} contact(s)`);
  });

crmContacts.command('get').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  const contact = crm.getContact(db, id);
  if (!contact) { console.error(`Contact ${id} not found`); process.exit(1); }
  console.log(JSON.stringify(contact, null, 2));
});

crmContacts.command('create')
  .requiredOption('--name <name>', 'Contact name')
  .option('--email <email>', 'Email address')
  .option('--phone <phone>', 'Phone number')
  .option('--company <id>', 'Company ID')
  .option('--source <source>', 'Lead source')
  .action((opts: { name: string; email?: string; phone?: string; company?: string; source?: string }) => {
    const db = getCrmDb();
    const contact = crm.createContact(db, { ...opts, company_id: opts.company });
    console.log(contact.id);
  });

crmContacts.command('update').argument('<id>')
  .option('--name <name>')
  .option('--email <email>')
  .option('--phone <phone>')
  .option('--company <id>', 'Company ID')
  .option('--notes <notes>')
  .action((id: string, opts: { name?: string; email?: string; phone?: string; company?: string; notes?: string }) => {
    const db = getCrmDb();
    const fields: Record<string, string | undefined> = {};
    if (opts.name !== undefined) fields.name = opts.name;
    if (opts.email !== undefined) fields.email = opts.email;
    if (opts.phone !== undefined) fields.phone = opts.phone;
    if (opts.company !== undefined) fields.company_id = opts.company;
    if (opts.notes !== undefined) fields.notes = opts.notes;
    crm.updateContact(db, id, fields);
    console.log(`Updated ${id}`);
  });

crmContacts.command('delete').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  crm.deleteContact(db, id);
  console.log(`Deleted contact ${id}`);
});

const crmCompanies = busCommand.command('crm-companies').description('CRM company operations');

crmCompanies.command('list')
  .option('--search <query>', 'Search by name or domain')
  .action((opts: { search?: string }) => {
    const db = getCrmDb();
    const companies = crm.listCompanies(db, opts);
    if (companies.length === 0) { console.log('No companies found.'); return; }
    for (const c of companies) {
      console.log(`${c.id}  ${c.name}  ${c.domain ?? '-'}  ${c.org_number ?? '-'}`);
    }
    console.log(`\n${companies.length} company(ies)`);
  });

crmCompanies.command('get').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  const company = crm.getCompany(db, id);
  if (!company) { console.error(`Company ${id} not found`); process.exit(1); }
  console.log(JSON.stringify(company, null, 2));
});

crmCompanies.command('create')
  .requiredOption('--name <name>', 'Company name')
  .option('--domain <domain>', 'Website domain')
  .option('--industry <industry>')
  .option('--org-number <number>', 'Norwegian org number')
  .option('--size <size>', 'solo|small|medium|large')
  .action((opts: { name: string; domain?: string; industry?: string; orgNumber?: string; size?: string }) => {
    const db = getCrmDb();
    const company = crm.createCompany(db, { ...opts, org_number: opts.orgNumber });
    console.log(company.id);
  });

crmCompanies.command('update').argument('<id>')
  .option('--name <name>')
  .option('--domain <domain>')
  .option('--industry <industry>')
  .option('--org-number <number>')
  .option('--size <size>')
  .option('--notes <notes>')
  .action((id: string, opts: { name?: string; domain?: string; industry?: string; orgNumber?: string; size?: string; notes?: string }) => {
    const db = getCrmDb();
    const fields: Record<string, string | undefined> = {};
    if (opts.name !== undefined) fields.name = opts.name;
    if (opts.domain !== undefined) fields.domain = opts.domain;
    if (opts.industry !== undefined) fields.industry = opts.industry;
    if (opts.orgNumber !== undefined) fields.org_number = opts.orgNumber;
    if (opts.size !== undefined) fields.size = opts.size;
    if (opts.notes !== undefined) fields.notes = opts.notes;
    crm.updateCompany(db, id, fields);
    console.log(`Updated ${id}`);
  });

crmCompanies.command('delete').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  crm.deleteCompany(db, id);
  console.log(`Deleted company ${id}`);
});

const crmDeals = busCommand.command('crm-deals').description('CRM deal operations');

crmDeals.command('list')
  .option('--stage <stage>', 'Filter by stage')
  .option('--contact <id>', 'Filter by contact')
  .option('--company <id>', 'Filter by company')
  .action((opts: { stage?: string; contact?: string; company?: string }) => {
    const db = getCrmDb();
    const deals = crm.listDeals(db, opts);
    if (deals.length === 0) { console.log('No deals found.'); return; }
    for (const d of deals) {
      const value = d.value_nok != null ? `${d.value_nok} NOK` : '-';
      console.log(`${d.id}  ${d.stage.padEnd(12)}  ${value.padStart(12)}  ${d.title}`);
    }
    console.log(`\n${deals.length} deal(s)`);
  });

crmDeals.command('get').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  const deal = crm.getDeal(db, id);
  if (!deal) { console.error(`Deal ${id} not found`); process.exit(1); }
  console.log(JSON.stringify(deal, null, 2));
});

crmDeals.command('create')
  .requiredOption('--title <title>', 'Deal title')
  .option('--value <nok>', 'Value in NOK', parseFloat)
  .option('--stage <stage>', 'Pipeline stage (default: lead)')
  .option('--contact <id>', 'Contact ID')
  .option('--company <id>', 'Company ID')
  .option('--expected-close <date>', 'Expected close date')
  .action((opts: { title: string; value?: number; stage?: string; contact?: string; company?: string; expectedClose?: string }) => {
    const db = getCrmDb();
    const deal = crm.createDeal(db, { ...opts, value_nok: opts.value, contact_id: opts.contact, company_id: opts.company, expected_close: opts.expectedClose });
    console.log(deal.id);
  });

crmDeals.command('update').argument('<id>')
  .option('--stage <stage>')
  .option('--value <nok>', 'Value in NOK', parseFloat)
  .option('--title <title>')
  .option('--notes <notes>')
  .action((id: string, opts: { stage?: string; value?: number; title?: string; notes?: string }) => {
    const db = getCrmDb();
    const fields: Record<string, string | number | undefined> = {};
    if (opts.stage !== undefined) fields.stage = opts.stage;
    if (opts.value !== undefined) fields.value_nok = opts.value;
    if (opts.title !== undefined) fields.title = opts.title;
    if (opts.notes !== undefined) fields.notes = opts.notes;
    crm.updateDeal(db, id, fields);
    console.log(`Updated ${id}`);
  });

crmDeals.command('delete').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  crm.deleteDeal(db, id);
  console.log(`Deleted deal ${id}`);
});

const crmActivities = busCommand.command('crm-activities').description('CRM activity operations');

crmActivities.command('list')
  .option('--contact <id>', 'Filter by contact')
  .option('--deal <id>', 'Filter by deal')
  .option('--type <type>', 'Filter by type')
  .action((opts: { contact?: string; deal?: string; type?: string }) => {
    const db = getCrmDb();
    const activities = crm.listActivities(db, opts);
    if (activities.length === 0) { console.log('No activities found.'); return; }
    for (const a of activities) {
      const date = a.created_at.substring(0, 10);
      console.log(`${a.id}  ${date}  ${a.type.padEnd(8)}  ${a.subject ?? '-'}`);
    }
    console.log(`\n${activities.length} activity(ies)`);
  });

crmActivities.command('create')
  .requiredOption('--type <type>', 'Activity type (meeting, email, call, note, task, booking)')
  .option('--subject <subject>')
  .option('--body <body>')
  .option('--contact <id>', 'Contact ID')
  .option('--deal <id>', 'Deal ID')
  .option('--meeting <id>', 'Meeting ID')
  .option('--due <date>', 'Due date for task-type activities')
  .action((opts: { type: string; subject?: string; body?: string; contact?: string; deal?: string; meeting?: string; due?: string }) => {
    const env = resolveEnv();
    const db = getCrmDb();
    const activity = crm.createActivity(db, { ...opts, contact_id: opts.contact, deal_id: opts.deal, meeting_id: opts.meeting, due_at: opts.due, agent: env.agentName });
    console.log(activity.id);
  });

crmActivities.command('complete')
  .description('Mark a task/follow-up activity complete (stamps completed_at)')
  .argument('<id>')
  .action((id: string) => {
    const db = getCrmDb();
    const done = crm.completeActivity(db, id);
    if (!done) { console.error(`Activity ${id} not found`); process.exit(1); }
    console.log(`Completed ${id}${done.subject ? ` (${done.subject})` : ''}`);
  });

crmActivities.command('delete')
  .description('Permanently delete an activity (requires --force; data deletion)')
  .argument('<id>')
  .option('--force', 'Confirm permanent deletion')
  .action((id: string, opts: { force?: boolean }) => {
    const db = getCrmDb();
    if (!opts.force) {
      console.error(`Refusing to delete activity ${id} without --force. This permanently removes the row (data deletion). Re-run with --force to confirm.`);
      process.exit(1);
    }
    const deleted = crm.deleteActivity(db, id);
    if (!deleted) { console.error(`Activity ${id} not found`); process.exit(1); }
    console.log(`Deleted activity ${id}`);
  });

const crmMeetings = busCommand.command('crm-meetings').description('CRM meeting records');

crmMeetings.command('list')
  .option('--contact <id>', 'Filter by contact')
  .action((opts: { contact?: string }) => {
    const db = getCrmDb();
    const meetings = crm.listMeetings(db, opts);
    if (meetings.length === 0) { console.log('No meetings found.'); return; }
    for (const m of meetings) {
      const date = m.meeting_start?.substring(0, 10) ?? m.created_at.substring(0, 10);
      console.log(`${m.id}  ${date}  ${m.title ?? '-'}`);
    }
    console.log(`\n${meetings.length} meeting(s)`);
  });

crmMeetings.command('get').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  const meeting = crm.getMeeting(db, id);
  if (!meeting) { console.error(`Meeting ${id} not found`); process.exit(1); }
  console.log(JSON.stringify(meeting, null, 2));
});

busCommand.command('crm-pipeline')
  .description('Pipeline overview with deal counts and values per stage')
  .action(() => {
    const db = getCrmDb();
    const pipeline = crm.getPipeline(db);
    if (pipeline.length === 0) { console.log('Pipeline is empty.'); return; }
    let totalValue = 0;
    let totalCount = 0;
    for (const p of pipeline) {
      console.log(`${p.stage.padEnd(14)} ${String(p.count).padStart(3)} deals  ${String(p.total_value).padStart(10)} NOK`);
      totalValue += p.total_value;
      totalCount += p.count;
    }
    console.log(`${'TOTAL'.padEnd(14)} ${String(totalCount).padStart(3)} deals  ${String(totalValue).padStart(10)} NOK`);
  });

const crmFollowUps = busCommand.command('crm-follow-ups').description('Pending follow-up tasks');

crmFollowUps.command('list', { isDefault: true })
  .description('List pending follow-up tasks')
  .option('--due <filter>', 'today|overdue|week')
  .action((opts: { due?: string }) => {
    const db = getCrmDb();
    const dueFilter = opts.due as 'today' | 'overdue' | 'week' | undefined;
    const followUps = crm.getFollowUps(db, dueFilter ? { due: dueFilter } : undefined);
    if (followUps.length === 0) { console.log('No pending follow-ups.'); return; }
    for (const f of followUps) {
      const due = f.due_at?.substring(0, 10) ?? '-';
      console.log(`${f.id}  due:${due}  ${f.subject ?? '-'}`);
    }
    console.log(`\n${followUps.length} follow-up(s)`);
  });

// A follow-up is a task-type activity; resolving one stamps completed_at so it
// drops out of the pending list. Alias of `crm-activities complete`.
crmFollowUps.command('resolve')
  .alias('complete')
  .description('Resolve (complete) a pending follow-up task by id')
  .argument('<id>')
  .action((id: string) => {
    const db = getCrmDb();
    const activity = crm.getActivity(db, id);
    if (!activity) { console.error(`Follow-up ${id} not found`); process.exit(1); }
    // Scope guard: this command only resolves rows that are actually pending
    // follow-ups. Use `crm-activities complete` for arbitrary activities.
    if (!crm.isPendingFollowUp(activity)) {
      const why = activity.completed_at ? 'already completed' : `not a pending follow-up (type=${activity.type}, due_at=${activity.due_at ?? 'none'})`;
      console.error(`${id} is ${why}. Use \`crm-activities complete\` to complete a non-follow-up activity.`);
      process.exit(1);
    }
    const done = crm.completeActivity(db, id);
    console.log(`Resolved follow-up ${id}${done?.subject ? ` (${done.subject})` : ''}`);
  });

const crmDocs = busCommand.command('crm-documents').description('CRM document attachments');

crmDocs.command('list')
  .option('--contact <id>', 'Filter by contact')
  .option('--deal <id>', 'Filter by deal')
  .action((opts: { contact?: string; deal?: string }) => {
    const db = getCrmDb();
    const docs = crm.listDocuments(db, opts);
    if (docs.length === 0) { console.log('No documents.'); return; }
    for (const d of docs) {
      console.log(`${d.id}  ${d.filename}  ${d.filepath}  ${d.created_at.substring(0, 10)}`);
    }
    console.log(`\n${docs.length} document(s)`);
  });

crmDocs.command('add')
  .requiredOption('--file <path>', 'File path')
  .option('--contact <id>', 'Link to contact')
  .option('--deal <id>', 'Link to deal')
  .option('--name <filename>', 'Display name (defaults to basename)')
  .action((opts: { file: string; contact?: string; deal?: string; name?: string }) => {
    const { existsSync, statSync } = require('fs');
    const { basename } = require('path');
    if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1); }
    const stat = statSync(opts.file);
    const env = resolveEnv();
    const db = getCrmDb();
    const doc = crm.addDocument(db, {
      filename: opts.name ?? basename(opts.file),
      filepath: opts.file,
      contact_id: opts.contact,
      deal_id: opts.deal,
      size_bytes: stat.size,
      uploaded_by: env.agentName,
    });
    console.log(doc.id);
  });

crmDocs.command('delete').argument('<id>').action((id: string) => {
  const db = getCrmDb();
  crm.deleteDocument(db, id);
  console.log(`Deleted document ${id}`);
});

const crmReview = busCommand.command('crm-review-queue').description('CRM review queue for low-confidence matches');

crmReview.command('list')
  .option('--status <status>', 'Filter by status (default: pending)')
  .action((opts: { status?: string }) => {
    const db = getCrmDb();
    const items = crm.listReviewQueue(db, opts);
    if (items.length === 0) { console.log('No review items.'); return; }
    for (const item of items) {
      const ctx = item.context ? JSON.parse(item.context) : {};
      console.log(`${item.id}  ${item.type}  ${ctx.reason ?? '-'}  ${item.created_at.substring(0, 10)}`);
    }
    console.log(`\n${items.length} item(s)`);
  });

crmReview.command('resolve').argument('<id>')
  .requiredOption('--action <action>', 'merge|create|dismiss')
  .action((id: string, opts: { action: string }) => {
    const env = resolveEnv();
    const db = getCrmDb();
    const action = opts.action as 'merge' | 'create' | 'dismiss';
    if (!['merge', 'create', 'dismiss'].includes(action)) {
      console.error('Action must be: merge, create, or dismiss');
      process.exit(1);
    }
    crm.resolveReviewItem(db, id, action, env.agentName);
    console.log(`Resolved ${id} (${action})`);
  });

busCommand.command('crm-report')
  .description('Generate CRM reports as HTML and optionally send via Telegram')
  .argument('<type>', 'Report type: pipeline or meeting')
  .option('--meeting-id <id>', 'Meeting ID (for meeting report)')
  .option('--send', 'Send as Telegram document to user')
  .action(async (type: string, opts: { meetingId?: string; send?: boolean }) => {
    const db = getCrmDb();
    let html: string | null = null;
    let filename = '';

    if (type === 'pipeline') {
      html = generatePipelineReport(db);
      filename = `pipeline-report-${new Date().toISOString().split('T')[0]}.html`;
    } else if (type === 'meeting') {
      if (!opts.meetingId) { console.error('--meeting-id required for meeting report'); process.exit(1); }
      html = generateMeetingSummaryHtml(db, opts.meetingId);
      filename = `meeting-summary-${opts.meetingId.substring(0, 8)}.html`;
    } else {
      console.error('Unknown report type. Use: pipeline or meeting');
      process.exit(1);
    }

    if (!html) { console.error('No data found for report'); process.exit(1); }

    if (opts.send) {
      const { writeFileSync, unlinkSync, existsSync } = await import('fs');
      const { join } = await import('path');
      const tmpPath = join(process.env.TMPDIR ?? '/tmp', filename);
      writeFileSync(tmpPath, html);

      const chatId = process.env.CTX_TELEGRAM_CHAT_ID;
      const botToken = process.env.BOT_TOKEN;
      if (!chatId || !botToken) {
        console.log(`Report saved to ${tmpPath} (no Telegram credentials for sending)`);
        return;
      }

      try {
        const { TelegramAPI } = await import('../telegram/api.js');
        const api = new TelegramAPI(botToken);
        await api.sendDocument(parseInt(chatId), tmpPath, filename);
        console.log(`Report sent via Telegram: ${filename}`);
      } catch (err) {
        console.error(`Failed to send report: ${err instanceof Error ? err.message : err}`);
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      }
    } else {
      console.log(html);
    }
  });

busCommand.command('crm-process-webhooks')
  .description('Process pending webhook queue (runs AI pipeline for Fathom, creates CRM entries for Cal.com)')
  .action(async () => {
    const db = getCrmDb();
    const result = await processWebhookQueue(db);
    console.log(`Processed: ${result.processed} | Failed: ${result.failed} | Retrying: ${result.skipped} | Skipped (test): ${result.skippedTest}`);
  });

busCommand.command('content-status-audit')
  .description('Scan the website blog for publish drift (posts marked published that would NOT render). Exits non-zero if drift is found.')
  .action(async () => {
    const { auditContentStatus, formatAuditReport } = await import('../bus/content-status-audit.js');
    const report = auditContentStatus();
    console.log(formatAuditReport(report));
    // Non-zero exit on drift so a cron/CI step can detect failure.
    if (!report.ok) process.exitCode = 1;
  });

busCommand.command('log-measurement')
  .description('Log a måle-garanti measurement event (task_handled) backing the 2 t/uke time-saved guarantee')
  .requiredOption('--client <orgnr>', 'Client org number (the guarantee is per client)')
  .requiredOption('--task-type <type>', 'Task type (booking|doc_review|nav_oppgjor|no_show_chase|...)')
  .requiredOption('--baseline-seconds <n>', 'Baseline manual seconds per task, from signed uke-0 capture')
  .option('--agent <name>', 'Agent that handled the task (default: current agent)')
  .option('--human-touch-seconds <n>', 'Residual human seconds on this task (review/exception)', '0')
  .option('--outcome <o>', 'completed | escalated_to_human | failed', 'completed')
  .option('--confidence <c>', 'Baseline confidence: high | medium | low')
  .option('--completed-at <iso>', 'Completion timestamp (default: now)')
  .action(async (opts: { client: string; taskType: string; baselineSeconds: string; agent?: string; humanTouchSeconds: string; outcome: string; confidence?: string; completedAt?: string }) => {
    const { validateMeasurementMeta } = await import('../bus/measurement.js');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
    const baseline = Number(opts.baselineSeconds);
    const humanTouch = Number(opts.humanTouchSeconds);
    const meta = {
      client_id: opts.client,
      agent_id: opts.agent ?? env.agentName,
      task_type: opts.taskType,
      completed_at: opts.completedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      human_touch_required: humanTouch > 0,
      human_touch_seconds: humanTouch,
      baseline_seconds_per_task: baseline,
      ...(opts.confidence ? { baseline_confidence: opts.confidence } : {}),
      outcome: opts.outcome,
    };
    try {
      validateMeasurementMeta(meta as never);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    logEvent(paths, meta.agent_id, env.org, 'measurement', 'task_handled', 'info', JSON.stringify(meta));
    console.log(`Logged measurement/task_handled for client ${meta.client_id} (${meta.task_type}, outcome=${meta.outcome})`);
  });

busCommand.command('measurement-report')
  .description('Aggregate måle-garanti measurement events for a client into a time-saved / guarantee report')
  .requiredOption('--client <orgnr>', 'Client org number')
  .option('--since <iso>', 'Window start (ISO date/datetime; default: 7 days ago)')
  .option('--until <iso>', 'Window end (ISO date/datetime; default: now)')
  .option('--json', 'Emit JSON instead of text')
  .action(async (opts: { client: string; since?: string; until?: string; json?: boolean }) => {
    const { aggregateMeasurements, formatMeasurementReport } = await import('../bus/measurement.js');
    const { join } = require('path');
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    // A date-only --until means "include that whole day", so pin it to
    // end-of-day; new Date('2026-05-31') is midnight and would drop every
    // task completed during that date.
    const dateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const until = opts.until
      ? new Date(dateOnly(opts.until) ? `${opts.until}T23:59:59.999Z` : opts.until)
      : new Date();
    const since = opts.since ? new Date(opts.since) : new Date(until.getTime() - 7 * 86400000);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      console.error('Invalid --since/--until date');
      process.exit(1);
    }

    // Measurement events are written per-agent at {analyticsDir}/events/{agent}/{date}.jsonl.
    // Scan every agent's event files and keep measurement/task_handled rows for this
    // client whose completed_at falls inside the window.
    const eventsRoot = join(paths.analyticsDir, 'events');
    const collected: Array<Record<string, unknown>> = [];
    if (existsSync(eventsRoot)) {
      for (const agentDir of readdirSync(eventsRoot, { withFileTypes: true })) {
        if (!agentDir.isDirectory()) continue;
        const dir = join(eventsRoot, agentDir.name);
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.jsonl')) continue;
          let lines: string[];
          try { lines = readFileSync(join(dir, file), 'utf-8').split('\n').filter(Boolean); }
          catch { continue; }
          for (const line of lines) {
            let evt: { category?: string; event?: string; metadata?: Record<string, unknown> };
            try { evt = JSON.parse(line); } catch { continue; }
            if (evt.category !== 'measurement' || evt.event !== 'task_handled') continue;
            const m = evt.metadata;
            if (!m || m.client_id !== opts.client) continue;
            const completedAt = new Date(String(m.completed_at));
            if (Number.isNaN(completedAt.getTime())) continue;
            if (completedAt < since || completedAt > until) continue;
            collected.push(m);
          }
        }
      }
    }

    const report = aggregateMeasurements(collected as never, {
      client_id: opts.client,
      window_start: since.toISOString(),
      window_end: until.toISOString(),
    });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatMeasurementReport(report));
  });

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
