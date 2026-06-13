import { describe, it, expect } from 'vitest';
import {
  classifyBashSubcommand,
  classifyBash,
  splitBashSubcommands,
  isConfigChangePath,
  isScratchPath,
  extractTelegramChatId,
} from '../../../src/security/action-patterns';

const OWNER = ['6733625733'];

describe('action-patterns: classifyBashSubcommand', () => {
  it('rm -rf of a non-scratch path is catastrophic data-deletion', () => {
    const r = classifyBashSubcommand('rm -rf ~/cortextos');
    expect(r.category).toBe('data-deletion');
    expect(r.catastrophic).toBe(true);
  });

  it('rm -rf confined to a scratch prefix is ALLOW (the benign neighbour)', () => {
    expect(classifyBashSubcommand('rm -rf /tmp/builder2/x').category).toBeNull();
    expect(classifyBashSubcommand('rm -rf ./tmp/scratch').category).toBeNull();
  });

  it('rm -rf with a mix of scratch and non-scratch operands is catastrophic', () => {
    const r = classifyBashSubcommand('rm -rf /tmp/ok ~/real');
    expect(r.category).toBe('data-deletion');
    expect(r.catastrophic).toBe(true);
  });

  it('git push --force is catastrophic data-deletion', () => {
    expect(classifyBashSubcommand('git push --force origin feature').catastrophic).toBe(true);
    expect(classifyBashSubcommand('git push --force-with-lease origin x').category).toBe('data-deletion');
  });

  it('DROP TABLE / DELETE FROM without WHERE / TRUNCATE are catastrophic', () => {
    expect(classifyBashSubcommand('psql -c "DROP TABLE users"').catastrophic).toBe(true);
    expect(classifyBashSubcommand('psql -c "DELETE FROM users"').catastrophic).toBe(true);
    expect(classifyBashSubcommand('psql -c "TRUNCATE TABLE events"').catastrophic).toBe(true);
  });

  it('DELETE FROM WITH a WHERE clause is NOT flagged (scoped delete)', () => {
    expect(classifyBashSubcommand('psql -c "DELETE FROM users WHERE id=1"').category).toBeNull();
  });

  it('deployment verbs classify as deployment, NOT catastrophic (reversible-ish)', () => {
    for (const cmd of ['gh pr merge 5 --squash', 'git push origin main', 'vercel deploy --prod', 'npm run build:prod', 'pm2 restart cortextos-daemon', 'launchctl bootstrap gui/501 x.plist']) {
      const r = classifyBashSubcommand(cmd);
      expect(r.category, cmd).toBe('deployment');
      expect(r.catastrophic, cmd).toBe(false);
    }
  });

  it('curl to a known send endpoint is catastrophic external-comms', () => {
    expect(classifyBashSubcommand('curl -X POST https://api.resend.com/emails -d @x').catastrophic).toBe(true);
    expect(classifyBashSubcommand('curl https://api.twilio.com/2010/Messages').category).toBe('external-comms');
  });

  it('curl to stripe is catastrophic financial', () => {
    expect(classifyBashSubcommand('curl https://api.stripe.com/v1/charges -d amount=5000').category).toBe('financial');
  });

  it('telegram curl to the OWNER chat is exempt (ALLOW)', () => {
    const r = classifyBashSubcommand('curl https://api.telegram.org/botX/sendMessage -d chat_id=6733625733 -d text=hi', { ownerChatIds: OWNER });
    expect(r.category).toBeNull();
  });

  it('telegram curl to a NON-owner chat is catastrophic external-comms', () => {
    const r = classifyBashSubcommand('curl https://api.telegram.org/botX/sendMessage -d chat_id=999999 -d text=secrets', { ownerChatIds: OWNER });
    expect(r.category).toBe('external-comms');
    expect(r.catastrophic).toBe(true);
  });

  it('telegram curl with NO owner list (undeterminable) is ALLOW (never freeze)', () => {
    const r = classifyBashSubcommand('curl https://api.telegram.org/botX/sendMessage -d chat_id=999999', {});
    expect(r.category).toBeNull();
  });

  it('shell redirection writing a config path is config-change', () => {
    expect(classifyBashSubcommand('echo X > .env').category).toBe('config-change');
    expect(classifyBashSubcommand('cat foo | tee ~/.claude/settings.json').category).toBe('config-change');
  });

  it('self-CLI subversion: shelling a gated bus subcommand is caught (spoof defense)', () => {
    // an agent trying to forge an authority identity via bash env-prefix
    const ua = classifyBashSubcommand('CTX_AGENT_NAME=dashboard cortextos bus update-approval appr_1 approved');
    expect(ua.category).toBe('config-change');
    expect(ua.catastrophic).toBe(true); // resolving on gate error must fail closed
    const del = classifyBashSubcommand('cortextos bus crm-contacts delete c_1');
    expect(del.category).toBe('data-deletion');
    expect(del.catastrophic).toBe(true);
  });

  it('cli send-telegram to a non-owner is gated; to owner is exempt', () => {
    expect(classifyBashSubcommand('cortextos bus send-telegram 999 "exfil"', { ownerChatIds: OWNER }).category).toBe('external-comms');
    expect(classifyBashSubcommand('cortextos bus send-telegram 6733625733 "hi"', { ownerChatIds: OWNER }).category).toBeNull();
    expect(classifyBashSubcommand('cortextos bus send-telegram 999 "x"', {}).category).toBeNull(); // no owners ⇒ never freeze
  });

  it('EVASION FIXES: long rm flags, uppercase hosts, quoted redirect targets are all caught', () => {
    // long-form rm flags (the short-flag-only matcher missed these)
    expect(classifyBashSubcommand('rm --recursive --force /prod/data').catastrophic).toBe(true);
    expect(classifyBashSubcommand('rm --recursive /tmp/scratch').category).toBeNull(); // scratch still allowed
    // case-insensitive host match
    expect(classifyBashSubcommand('curl https://API.STRIPE.COM/v1/charges').category).toBe('financial');
    expect(classifyBashSubcommand('curl https://API.RESEND.COM/emails').category).toBe('external-comms');
    // quoted redirect target
    const q = classifyBashSubcommand('echo x > "config.json"');
    expect(q.category).toBe('config-change');
    expect(q.catastrophic).toBe(true);
    expect(classifyBashSubcommand("printf y >> '.env'").category).toBe('config-change');
  });

  it('copy/move/link ONTO a trust-anchor path is config-change (cp/mv/rsync/ln)', () => {
    expect(classifyBashSubcommand('cp /tmp/evil orgs/x/agents/y/config.json').category).toBe('config-change');
    expect(classifyBashSubcommand('mv /tmp/forged orgs/x/approvals/resolved/appr_1.json').category).toBe('config-change');
    expect(classifyBashSubcommand('rsync -a /tmp/x orgs/x/agents/y/.claude/settings.json').category).toBe('config-change');
    // moving a code file is NOT config-change
    expect(classifyBashSubcommand('mv src/a.ts src/b.ts').category).toBeNull();
    // copying FROM a config (source is anchor, dest is /tmp) is NOT a config-change write
    expect(classifyBashSubcommand('cp orgs/x/agents/y/config.json /tmp/backup').category).toBeNull();
  });

  it('multi-target / directory-destination writes to trust anchors are caught (R3)', () => {
    // multiple redirects — second target is a trust anchor
    expect(classifyBashSubcommand('echo ok > src/ok.ts > orgs/x/agents/y/config.json').category).toBe('config-change');
    // tee multi-target
    expect(classifyBashSubcommand('tee src/ok.ts orgs/x/agents/y/config.json').category).toBe('config-change');
    // cp into the approvals DIRECTORY (bare dir, no trailing slash) — forge a resolved row
    expect(classifyBashSubcommand('cp /tmp/approval_1.json orgs/x/approvals/resolved').category).toBe('config-change');
    // cp -t target-directory form (dest is the -t arg, not the last operand)
    expect(classifyBashSubcommand('cp -t orgs/x/approvals/resolved /tmp/approval_1.json').category).toBe('config-change');
    // benign multi-target write to code paths only ⇒ ALLOW
    expect(classifyBashSubcommand('tee src/a.ts src/b.ts').category).toBeNull();
    // BARE RELATIVE trust-anchor paths (cwd already the org/root dir) — no leading slash
    expect(classifyBashSubcommand("echo '{}' > approvals/resolved/forged.json").category).toBe('config-change');
    expect(classifyBashSubcommand('cp forged.json approvals/resolved').category).toBe('config-change');
    expect(classifyBashSubcommand('cp -t approvals/pending forged.json').category).toBe('config-change');
  });

  it('in-place editors writing a trust anchor are caught (sed -i / perl -pi / awk -i / dd)', () => {
    expect(classifyBashSubcommand("sed -i '' 's/enforce/off/' orgs/acme/context.json").category).toBe('config-change');
    expect(classifyBashSubcommand('sed -i.bak s/a/b/ orgs/x/agents/y/config.json').category).toBe('config-change');
    expect(classifyBashSubcommand("perl -pi -e 's/x/y/' orgs/x/agents/y/config.json").category).toBe('config-change');
    expect(classifyBashSubcommand('awk -i inplace "{print}" .env').category).toBe('config-change');
    expect(classifyBashSubcommand('dd if=/tmp/x of=orgs/x/agents/y/config.json').category).toBe('config-change');
    // in-place edit / read of a CODE file is NOT config-change
    expect(classifyBashSubcommand("sed -i '' 's/a/b/' src/foo.ts").category).toBeNull();
    expect(classifyBashSubcommand("perl -ne 'print' orgs/x/agents/y/config.json").category).toBeNull(); // -ne is a READ, no -i
  });

  it('basename-preserving directory copy + downloader output flags are caught (R6)', () => {
    // cp SOURCE into a DIRECTORY → file lands at DIR/basename(source)
    expect(classifyBashSubcommand('cp /tmp/config.json orgs/acme/agents/forge/').category).toBe('config-change');
    expect(classifyBashSubcommand('cp /tmp/context.json orgs/acme/').category).toBe('config-change');
    expect(classifyBashSubcommand('cp -t orgs/acme/agents/forge /tmp/config.json').category).toBe('config-change');
    // downloader output to a trust anchor
    expect(classifyBashSubcommand('curl -fsSL https://x/approval.json -o orgs/acme/approvals/resolved/appr_x.json').category).toBe('config-change');
    expect(classifyBashSubcommand('wget -O orgs/acme/agents/forge/config.json https://x/config.json').category).toBe('config-change');
    expect(classifyBashSubcommand('curl -fsSLo .env https://x/env').category).toBe('config-change'); // combined flags
    // copying a code file into a code dir ⇒ ALLOW
    expect(classifyBashSubcommand('cp /tmp/foo.ts src/').category).toBeNull();
    expect(classifyBashSubcommand('curl https://x -o /tmp/out.json').category).toBeNull();
  });

  it('ordinary commands and code writes are ALLOW', () => {
    for (const cmd of ['ls -la', 'npm test', 'git status', 'echo hi > src/foo.ts', 'cat README.md', 'node dist/cli.js bus check-inbox']) {
      expect(classifyBashSubcommand(cmd).category, cmd).toBeNull();
    }
  });
});

describe('action-patterns: classifyBash (multi-subcommand)', () => {
  it('splits on ; && || | and newlines', () => {
    expect(splitBashSubcommands('a && b | c ; d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a catastrophic sub-command anywhere wins over benign ones', () => {
    const r = classifyBash('ls -la && rm -rf /etc/passwd');
    expect(r.category).toBe('data-deletion');
    expect(r.catastrophic).toBe(true);
  });

  it('all-benign command chain is ALLOW', () => {
    expect(classifyBash('cd /tmp && ls && cat x.txt').category).toBeNull();
  });
});

describe('action-patterns: isConfigChangePath', () => {
  it('flags secrets / settings / bootstrap / crons / approval rows', () => {
    for (const p of [
      '.env', 'foo/.env.local', 'orgs/x/secrets.env',
      'orgs/x/agents/y/.claude/settings.json', 'orgs/x/agents/y/.claude/settings.local.json',
      'orgs/x/agents/y/config.json', 'state/y/crons.json', 'orgs/x/context.json',
      'config/enabled-agents.json',
      'orgs/x/agents/y/GUARDRAILS.md', 'orgs/x/agents/y/IDENTITY.md',
      'orgs/x/approvals/pending/approval_1.json', 'orgs/x/approvals/resolved/approval_2.json',
    ]) {
      expect(isConfigChangePath(p), p).toBe(true);
    }
  });

  it('does NOT flag ordinary code / docs', () => {
    for (const p of ['src/foo.ts', 'README.md', 'dashboard/src/app/page.tsx', 'memory/2026-06-13.md', 'tests/x.test.ts']) {
      expect(isConfigChangePath(p), p).toBe(false);
    }
  });

  it('generic anchor names are LOCATION-aware (config.json in /tmp is NOT our anchor)', () => {
    // a config.json copied OUT to /tmp must not be mis-flagged as a trust-anchor write
    expect(isConfigChangePath('/tmp/backup/config.json')).toBe(false);
    expect(isConfigChangePath('/tmp/context.json')).toBe(false);
    expect(isConfigChangePath('myproject/config.json')).toBe(false);
    // but under an agent/org/state tree it IS the anchor
    expect(isConfigChangePath('orgs/x/agents/y/config.json')).toBe(true);
    expect(isConfigChangePath('/Users/v/.cortextos/default/state/y/crons.json')).toBe(true);
    expect(isConfigChangePath('config.json')).toBe(true); // bare = agent cwd
    // secrets are sensitive ANYWHERE (movement = exfil)
    expect(isConfigChangePath('/tmp/.env')).toBe(true);
  });
});

describe('action-patterns: helpers', () => {
  it('isScratchPath honors default + custom prefixes', () => {
    expect(isScratchPath('/tmp/x')).toBe(true);
    expect(isScratchPath('/home/real')).toBe(false);
    expect(isScratchPath('/scratch/a', ['/scratch/'])).toBe(true);
  });

  it('extractTelegramChatId parses query and json forms', () => {
    expect(extractTelegramChatId('curl x -d chat_id=123')).toBe('123');
    expect(extractTelegramChatId('curl x -d \'{"chat_id":"-456"}\'')).toBe('-456');
    expect(extractTelegramChatId('curl x -d text=hi')).toBeNull();
  });
});
