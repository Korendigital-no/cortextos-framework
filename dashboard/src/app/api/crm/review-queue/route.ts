import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get('status') ?? 'pending';

  const items = db.prepare('SELECT * FROM crm_review_queue WHERE status = ? ORDER BY created_at DESC').all(status);
  return Response.json(items);
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, action } = body;

  if (!id || !action) {
    return Response.json({ error: 'id and action required' }, { status: 400 });
  }
  if (!['create', 'dismiss'].includes(action)) {
    return Response.json({ error: 'action must be create or dismiss' }, { status: 400 });
  }

  if (typeof id !== 'string' || id.length === 0) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  const item = db.prepare("SELECT * FROM crm_review_queue WHERE id = ? AND status = 'pending'").get(id) as { context: string | null } | undefined;
  if (!item) {
    return Response.json({ error: 'Item not found or already resolved' }, { status: 404 });
  }

  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    if (action === 'create') {
      let context: Record<string, unknown> = {};
      try { context = item.context ? JSON.parse(item.context) : {}; } catch { /* invalid context */ }
      const attendees = context.attendees as Array<{ name?: string; email?: string }> | undefined;
      if (Array.isArray(attendees)) {
        for (const att of attendees) {
          if (!att.email || typeof att.email !== 'string') continue;
          db.prepare(`
            INSERT INTO crm_contacts (id, name, email, source, match_confidence, needs_review, created_at, updated_at)
            VALUES (?, ?, ?, 'review_queue', 0.5, 0, ?, ?)
            ON CONFLICT(email) DO NOTHING
          `).run(crypto.randomUUID(), att.name ?? att.email.split('@')[0], att.email, now, now);
        }
      }
    }

    const resolvedStatus = action === 'dismiss' ? 'dismissed' : 'resolved';
    db.prepare("UPDATE crm_review_queue SET status = ?, resolved_by = 'dashboard', resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(resolvedStatus, now, id);
  });

  txn();
  return Response.json({ ok: true });
}
