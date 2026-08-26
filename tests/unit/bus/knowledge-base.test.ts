import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
    statSync: (...args: Parameters<typeof fsMocks.statSync>) => fsMocks.statSync(...args),
    openSync: (...args: Parameters<typeof fsMocks.openSync>) => fsMocks.openSync(...args),
    closeSync: (...args: Parameters<typeof fsMocks.closeSync>) => fsMocks.closeSync(...args),
    writeFileSync: (...args: Parameters<typeof fsMocks.writeFileSync>) => fsMocks.writeFileSync(...args),
  };
});

// Mock execFileSync so we can assert whether it was called (and optionally
// simulate a successful python response). Also mock spawn for detach mode.
const execFileSyncMock = vi.fn();
const spawnMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

// Mock atomicWriteSync (used by saveStamps) so tests don't touch the filesystem.
const atomicWriteSyncMock = vi.fn();
vi.mock('../../../src/utils/atomic.js', () => ({
  atomicWriteSync: (...args: unknown[]) => atomicWriteSyncMock(...args),
}));

const { queryKnowledgeBase, ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.openSync.mockReset().mockReturnValue(5);
  fsMocks.closeSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  execFileSyncMock.mockReset();
  spawnMock.mockReset();
  atomicWriteSyncMock.mockReset();

  warnLog = [];
  logLog = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

// ──────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

/** Minimal stat-like object for statSync mocks. */
function mockFileStat(mtimeMs: number, isDir = false) {
  return { mtimeMs, isDirectory: () => isDir };
}

/** Serialise a stamps map to the JSON string loadStamps expects. */
function makeStampsJson(stamps: Record<string, number>): string {
  return JSON.stringify(stamps);
}

/**
 * Returns a mock ChildProcess-like object whose 'spawn'/'error' events can
 * be triggered synchronously in tests (simulating Node.js EventEmitter firing
 * after the current stack returns).
 */
function makeMockChild() {
  const handlers: Record<string, Function> = {};
  const child = {
    pid: 42,
    unref: vi.fn(),
    once: vi.fn((event: string, cb: Function) => {
      handlers[event] = cb;
    }),
  };
  return {
    child,
    triggerSpawn: () => handlers['spawn']?.(),
    triggerError: (e: Error) => handlers['error']?.(e),
  };
}

// ──────────────────────────────────────────────────────
// ingestKnowledgeBase — graceful missing-config
// ──────────────────────────────────────────────────────

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // First positional arg is the python path, second is the argv array.
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────
// queryKnowledgeBase — graceful missing-config
// ──────────────────────────────────────────────────────

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return empty KBQueryResponse, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────
// kb warn messages — UX invariants
// ──────────────────────────────────────────────────────

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// ingestKnowledgeBase — mtime-guard (blocking mode)
// ──────────────────────────────────────────────────────

describe('ingestKnowledgeBase — mtime-guard (blocking)', () => {
  it('skips unchanged file (stamp === mtime); execFileSync NOT called', () => {
    mockConfiguredKb();
    const absPath = '/abs/memory.md';
    const mtime = 1_000_000;
    fsMocks.statSync.mockReturnValue(mockFileStat(mtime));
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('ingest-stamps.json')) {
        return makeStampsJson({ [`${absPath}::agent-tester`]: mtime });
      }
      return '';
    });

    ingestKnowledgeBase([absPath], { ...baseOptions, scope: 'private', mtimeGuard: true });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logLog.some((m) => m.includes('skipping 1 unchanged'))).toBe(true);
  });

  it('ingests changed file (stamp !== mtime); passes --force to python', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    const absPath = '/abs/memory.md';
    fsMocks.statSync.mockReturnValue(mockFileStat(2_000_000));
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('ingest-stamps.json')) {
        return makeStampsJson({ [`${absPath}::agent-tester`]: 1_000_000 });
      }
      return '';
    });

    ingestKnowledgeBase([absPath], { ...baseOptions, scope: 'private', mtimeGuard: true });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(argv).toContain('--force');
  });

  it('unstamped file (no prior stamp) treated as changed', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    fsMocks.statSync.mockReturnValue(mockFileStat(1_000_000));
    // readFileSync returns '' (default) → JSON.parse fails → loadStamps returns {}

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', mtimeGuard: true });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('all files unchanged → early exit; execFileSync NOT called; logs "all files up to date"', () => {
    mockConfiguredKb();
    const absPath = '/abs/memory.md';
    const mtime = 1_000_000;
    fsMocks.statSync.mockReturnValue(mockFileStat(mtime));
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('ingest-stamps.json')) {
        return makeStampsJson({ [`${absPath}::agent-tester`]: mtime });
      }
      return '';
    });

    ingestKnowledgeBase([absPath], { ...baseOptions, scope: 'private', mtimeGuard: true });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logLog.some((m) => m.includes('all files up to date'))).toBe(true);
  });

  it('--force bypasses mtime-guard: no stat check, execFileSync always called', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/abs/memory.md'], {
      ...baseOptions,
      scope: 'private',
      mtimeGuard: true,
      force: true,
    });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // Guard block skipped (mtimeGuard && !force === false): statSync not called
    expect(fsMocks.statSync).not.toHaveBeenCalled();
    // Stamp block also skipped: atomicWriteSync not called
    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('directory path emits warning and is treated as changed', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    fsMocks.statSync.mockReturnValue(mockFileStat(1_000_000, true));

    ingestKnowledgeBase(['/abs/somedir'], { ...baseOptions, scope: 'private', mtimeGuard: true });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(warnLog.some((m) => m.includes('is a directory'))).toBe(true);
  });

  it('stamps written with PRE-ingest mtime — ordering guard for P1-8 fix', () => {
    // This test is order-sensitive: statSync returns preMtime before execFileSync runs,
    // then execFileSyncMock changes the return value to postMtime (simulating a file
    // edited mid-ingest). The stamp must use preMtime. If the preMtimes capture loop
    // were moved to AFTER execFileSync (regression of P1-8), statSync would return
    // postMtime and the toBe(preMtime) assertion would fail — catching the bug.
    mockConfiguredKb();
    const absPath = '/abs/memory.md';
    const preMtime = 2_000_000;
    const postMtime = 3_000_000;

    fsMocks.statSync.mockReturnValue(mockFileStat(preMtime));
    execFileSyncMock.mockImplementation(() => {
      // Simulate file written during ingest — future statSync calls see a newer mtime.
      fsMocks.statSync.mockReturnValue(mockFileStat(postMtime));
    });

    ingestKnowledgeBase([absPath], { ...baseOptions, scope: 'private', mtimeGuard: true });

    expect(atomicWriteSyncMock).toHaveBeenCalledTimes(1);
    const [stampPath, stampContent] = atomicWriteSyncMock.mock.calls[0] as [string, string];
    expect(stampPath).toMatch(/ingest-stamps\.json$/);
    const stamps = JSON.parse(stampContent);
    // Must be preMtime (captured before ingest), NOT postMtime (file was edited during ingest)
    expect(stamps[`${absPath}::agent-tester`]).toBe(preMtime);
    expect(stamps[`${absPath}::agent-tester`]).not.toBe(postMtime);
  });

  it('stamps NOT written when execFileSync throws (exception propagates)', () => {
    mockConfiguredKb();
    execFileSyncMock.mockImplementation(() => { throw new Error('python crashed'); });
    fsMocks.statSync.mockReturnValue(mockFileStat(1_000_000));

    expect(() =>
      ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', mtimeGuard: true }),
    ).toThrow('python crashed');

    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('stamp key is collection-scoped: private (agent-tester) key written, not shared key', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    const absPath = '/abs/memory.md';
    fsMocks.statSync.mockReturnValue(mockFileStat(1_000_000));

    ingestKnowledgeBase([absPath], { ...baseOptions, scope: 'private', mtimeGuard: true });

    const [, stampContent] = atomicWriteSyncMock.mock.calls[0] as [string, string];
    const stamps = JSON.parse(stampContent);
    expect(Object.keys(stamps).some((k) => k.endsWith('::agent-tester'))).toBe(true);
    expect(Object.keys(stamps).some((k) => k.includes('::shared-'))).toBe(false);
  });

  it('mtime-guard without scope defaults to shared collection', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    const absPath = '/abs/memory.md';
    fsMocks.statSync.mockReturnValue(mockFileStat(1_000_000));

    ingestKnowledgeBase([absPath], { ...baseOptions, mtimeGuard: true });

    const [, stampContent] = atomicWriteSyncMock.mock.calls[0] as [string, string];
    const stamps = JSON.parse(stampContent);
    expect(Object.keys(stamps).some((k) => k.endsWith('::shared-TestOrg'))).toBe(true);
  });

  it('strict equality: backwards mtime (e.g. backup restore) counts as changed (P1-4)', () => {
    // A backwards mtime (stamp > current mtime) must NOT be skipped — restoring a
    // backup rewinds mtime; the file content changed even though mtime went down.
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');
    const absPath = '/abs/memory.md';
    fsMocks.statSync.mockReturnValue(mockFileStat(500_000)); // current mtime < stamp
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('ingest-stamps.json')) {
        return makeStampsJson({ [`${absPath}::agent-tester`]: 1_000_000 }); // higher stamp
      }
      return '';
    });

    ingestKnowledgeBase([absPath], { ...baseOptions, scope: 'private', mtimeGuard: true });

    // Must be treated as changed (not skipped)
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────
// ingestKnowledgeBase — detach mode
// ──────────────────────────────────────────────────────

describe('ingestKnowledgeBase — detach mode', () => {
  it('spawn called, execFileSync NOT called', () => {
    mockConfiguredKb();
    const { child, triggerSpawn } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', detach: true });
    triggerSpawn();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('spawn called with detached: true', () => {
    mockConfiguredKb();
    const { child, triggerSpawn } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', detach: true });
    triggerSpawn();

    const [, , spawnOpts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(spawnOpts.detached).toBe(true);
  });

  it('no stamps written in detach mode — P0-1: failed ingest must not permanently skip files', () => {
    mockConfiguredKb();
    const { child, triggerSpawn } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], {
      ...baseOptions,
      scope: 'private',
      detach: true,
      mtimeGuard: true,
    });
    triggerSpawn();

    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('detach + mtime-guard: all unchanged → early exit before spawn (execFileSync AND spawn NOT called)', () => {
    mockConfiguredKb();
    const absPath = '/abs/memory.md';
    const mtime = 1_000_000;
    fsMocks.statSync.mockReturnValue(mockFileStat(mtime));
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('ingest-stamps.json')) {
        return makeStampsJson({ [`${absPath}::agent-tester`]: mtime });
      }
      return '';
    });

    ingestKnowledgeBase([absPath], {
      ...baseOptions,
      scope: 'private',
      detach: true,
      mtimeGuard: true,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('spawn ENOENT: error event → writes error to log file (FAIL-LOUD); then unrefs', () => {
    mockConfiguredKb();
    const { child, triggerError } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', detach: true });
    triggerError(new Error('spawn ENOENT'));

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/ingest-bg\.log$/),
      expect.stringContaining('spawn ENOENT'),
      expect.objectContaining({ flag: 'a' }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('spawn success: unref called only AFTER once("spawn") fires — P1-7 unconditional-unref guard', () => {
    mockConfiguredKb();
    const { child, triggerSpawn } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', detach: true });

    // unref must NOT be called before 'spawn' fires (guard against the original P1-7 bug)
    expect(child.unref).not.toHaveBeenCalled();

    triggerSpawn();

    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('openSync called for log file; closeSync called with returned fd after spawn', () => {
    mockConfiguredKb();
    fsMocks.openSync.mockReturnValue(7);
    const { child, triggerSpawn } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', detach: true });
    triggerSpawn();

    expect(fsMocks.openSync).toHaveBeenCalledWith(
      expect.stringMatching(/ingest-bg\.log$/),
      'a',
    );
    expect(fsMocks.closeSync).toHaveBeenCalledWith(7);
  });

  it('logs detach start message with pid', () => {
    mockConfiguredKb();
    const { child, triggerSpawn } = makeMockChild();
    spawnMock.mockReturnValue(child);

    ingestKnowledgeBase(['/abs/memory.md'], { ...baseOptions, scope: 'private', detach: true });
    triggerSpawn();

    expect(logLog.some((m) => m.includes('[kb] Detached ingest started') && m.includes('42'))).toBe(true);
  });
});
