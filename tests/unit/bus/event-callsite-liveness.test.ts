import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Source invariant for #930.
 *
 * `logEvent` defaults to not refreshing heartbeat, but every production call
 * site must still declare its liveness intent explicitly. This turns the
 * security boundary into a reviewable allowlist:
 *
 * - daemon/runtime writes performed on an agent's behalf use `false`;
 * - events caused by the agent's own CLI/tool activity use `true`.
 *
 * Parse TypeScript rather than matching text: the invariant depends on call
 * syntax and the final options object, not formatting or comments.
 */

const SRC_ROOT = join(process.cwd(), 'src');
const ON_BEHALF_EVENTS = new Set([
  'telegram_received',
  'codex_app_server_unsupported_request',
]);
const ON_BEHALF_COMMANDS = new Set([
  'send-message',
  'ack-inbox',
  'log-event',
  'send-telegram',
  'egress-alert',
]);
const ON_BEHALF_FUNCTIONS = new Set([
  'gateBusAction',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

interface LogEventCall {
  file: string;
  line: number;
  eventName: string | null;
  commandName: string | null;
  functionName: string | null;
  refreshHeartbeat: boolean | null;
}

function containingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function commanderCommandName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && current.expression.name.text === 'action'
    ) {
      let found: string | null = null;
      const findCommand = (candidate: ts.Node): void => {
        if (
          ts.isCallExpression(candidate)
          && ts.isPropertyAccessExpression(candidate.expression)
          && candidate.expression.name.text === 'command'
        ) {
          const name = candidate.arguments[0];
          if (name && ts.isStringLiteralLike(name)) found = name.text;
        }
        if (found === null) ts.forEachChild(candidate, findCommand);
      };
      findCommand(current.expression.expression);
      return found;
    }
    current = current.parent;
  }
  return null;
}

function inspectLogEventCalls(): LogEventCall[] {
  const calls: LogEventCall[] = [];

  for (const file of sourceFiles(SRC_ROOT)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'logEvent'
      ) {
        const eventArg = node.arguments[4];
        const eventName = eventArg && ts.isStringLiteralLike(eventArg)
          ? eventArg.text
          : null;
        const optsArg = node.arguments[7];
        let refreshHeartbeat: boolean | null = null;

        if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
          const property = optsArg.properties.find((candidate) => (
            ts.isPropertyAssignment(candidate)
            && (
              (ts.isIdentifier(candidate.name) && candidate.name.text === 'refreshHeartbeat')
              || (ts.isStringLiteralLike(candidate.name) && candidate.name.text === 'refreshHeartbeat')
            )
          ));
          if (property && ts.isPropertyAssignment(property)) {
            if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) refreshHeartbeat = true;
            if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) refreshHeartbeat = false;
          }
        }

        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        calls.push({
          file: relative(process.cwd(), file),
          line: line + 1,
          eventName,
          commandName: commanderCommandName(node),
          functionName: containingFunctionName(node),
          refreshHeartbeat,
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return calls;
}

describe('logEvent heartbeat ownership (#930 source invariant)', () => {
  it('classifies every production call site explicitly', () => {
    const calls = inspectLogEventCalls();
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((call) => call.refreshHeartbeat === null)).toEqual([]);
  });

  it('keeps daemon/runtime on-behalf events spoof-safe and self-activity live', () => {
    const calls = inspectLogEventCalls();
    const wrong = calls.filter((call) => {
      const onBehalf = (
        (call.eventName !== null && ON_BEHALF_EVENTS.has(call.eventName))
        || (call.commandName !== null && ON_BEHALF_COMMANDS.has(call.commandName))
        || (call.functionName !== null && ON_BEHALF_FUNCTIONS.has(call.functionName))
      );
      const expected = !onBehalf;
      return call.refreshHeartbeat !== expected;
    });

    expect(wrong).toEqual([]);
    const falseCalls = calls.filter((call) => call.refreshHeartbeat === false);
    expect(new Set(falseCalls.map((call) => {
      if (call.commandName !== null && ON_BEHALF_COMMANDS.has(call.commandName)) {
        return call.commandName;
      }
      if (call.functionName !== null && ON_BEHALF_FUNCTIONS.has(call.functionName)) {
        return call.functionName;
      }
      return call.eventName;
    }))).toEqual(new Set([
      ...ON_BEHALF_EVENTS,
      ...ON_BEHALF_COMMANDS,
      ...ON_BEHALF_FUNCTIONS,
    ]));
    expect(falseCalls.filter((call) => call.functionName === 'gateBusAction')).toHaveLength(2);
  });
});
