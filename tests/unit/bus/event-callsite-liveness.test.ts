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
  refreshHeartbeat: boolean | null;
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
      const expected = call.eventName !== null && ON_BEHALF_EVENTS.has(call.eventName)
        ? false
        : true;
      return call.refreshHeartbeat !== expected;
    });

    expect(wrong).toEqual([]);
    expect(calls.filter((call) => call.refreshHeartbeat === false).map((call) => call.eventName).sort())
      .toEqual([...ON_BEHALF_EVENTS].sort());
  });
});
