import { Command } from 'commander';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { notifyAgent } from '../bus/agents.js';

export const notifyAgentCommand = new Command('notify-agent')
  .description('Send an urgent notification to an agent')
  .argument('<name>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <agent>', 'Sender agent name', 'cli')
  .option('--instance <id>', 'Instance ID', 'default')
  .action((name: string, message: string, options: { from: string; instance: string }) => {
    // resolveEnv, not a hand-rolled homedir path: honors CTX_ROOT and
    // .cortextos-env. resolvePaths is PURE — without the threaded ctxRoot it
    // silently falls back to ~/.cortextos/<instance>, writing the signal to
    // the wrong tree under CTX_ROOT-override deploys (same class as the P2
    // measurement-ctxRoot fix, task_1780542355208 / task_1780603297377).
    const env = resolveEnv({ agentName: options.from, instanceId: options.instance });
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    notifyAgent(paths, env.agentName, name, message, env.ctxRoot);
    console.log(`Signal sent to ${name}`);
  });
