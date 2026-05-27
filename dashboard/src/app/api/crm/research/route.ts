import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  if (!frameworkRoot) {
    return Response.json({ error: 'CTX_FRAMEWORK_ROOT not set' }, { status: 500 });
  }

  const researchDirs = [
    { agent: 'sales', path: join(frameworkRoot, 'orgs/korendigital/agents/sales/research') },
    { agent: 'builder', path: join(frameworkRoot, 'orgs/korendigital/agents/builder/docs/specs') },
  ];

  const docs: Array<{ agent: string; filename: string; title: string; content: string; path: string }> = [];

  for (const dir of researchDirs) {
    try {
      const files = readdirSync(dir.path).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = join(dir.path, file);
        const content = readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.startsWith('#'));
        const title = firstLine?.replace(/^#+\s*/, '') ?? file.replace('.md', '');
        docs.push({ agent: dir.agent, filename: file, title, content, path: filePath });
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return Response.json(docs);
}
