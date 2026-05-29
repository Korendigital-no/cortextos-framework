import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export const dynamic = 'force-dynamic';

const DOC_DIR_NAMES = new Set(['research', 'docs', 'notes', 'specs']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build']);
const MAX_DOCS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;       // 2MB — skip oversized files
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;     // 20MB total payload guard

interface DocEntry {
  agent: string;
  filename: string;
  relPath: string;        // path within agent dir, e.g. 'research/notes/2026-05-28.md'
  title: string;
  content: string;
  mtime: string;          // ISO 8601
  sizeBytes: number;
}

interface WalkBudget { totalBytes: number; truncated: boolean }

/** Recursively collect .md files under a root, with paths relative to it. */
function walkMdFiles(root: string, agentDir: string, agent: string, out: DocEntry[], budget: WalkBudget): void {
  if (out.length >= MAX_DOCS || budget.totalBytes >= MAX_TOTAL_BYTES) {
    budget.truncated = true;
    return;
  }
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_DOCS || budget.totalBytes >= MAX_TOTAL_BYTES) {
      budget.truncated = true;
      return;
    }
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkMdFiles(join(root, entry.name), agentDir, agent, out, budget);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const filePath = join(root, entry.name);
    let st;
    try { st = statSync(filePath); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    if (budget.totalBytes + st.size > MAX_TOTAL_BYTES) {
      budget.truncated = true;
      return;
    }

    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

    const firstHeading = content.split('\n').find(l => l.startsWith('#'));
    const title = firstHeading?.replace(/^#+\s*/, '').trim() ?? entry.name.replace(/\.md$/, '');
    const relPath = relative(agentDir, filePath).split(sep).join('/');

    out.push({
      agent,
      filename: entry.name,
      relPath,
      title,
      content,
      mtime: st.mtime.toISOString(),
      sizeBytes: st.size,
    });
    budget.totalBytes += st.size;
  }
}

export async function GET() {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  if (!frameworkRoot) {
    return Response.json({ error: 'CTX_FRAMEWORK_ROOT not set' }, { status: 500 });
  }

  const orgDir = join(frameworkRoot, 'orgs/korendigital/agents');
  const docs: DocEntry[] = [];
  const budget: WalkBudget = { totalBytes: 0, truncated: false };

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(orgDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    return Response.json(docs);
  }

  outer: for (const agent of agentDirs) {
    const agentRoot = join(orgDir, agent);
    let topLevel: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      topLevel = readdirSync(agentRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of topLevel) {
      if (!entry.isDirectory() || !DOC_DIR_NAMES.has(entry.name)) continue;
      walkMdFiles(join(agentRoot, entry.name), agentRoot, agent, docs, budget);
      if (budget.truncated) break outer;
    }
  }

  return Response.json(docs);
}
