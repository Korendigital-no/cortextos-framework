import type Database from 'better-sqlite3';

interface PipelineStage {
  stage: string;
  count: number;
  total_value: number;
}

interface Deal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  contact_name: string | null;
  company_name: string | null;
  updated_at: string;
}

interface Contact {
  id: string;
  name: string;
  email: string | null;
  company_name: string | null;
  source: string | null;
  created_at: string;
}

interface Activity {
  id: string;
  type: string;
  subject: string | null;
  due_at: string | null;
  completed_at: string | null;
  contact_name: string | null;
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SAFE_STAGES = new Set(['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
function safeStageClass(stage: string): string {
  return SAFE_STAGES.has(stage) ? stage : 'lead';
}

const STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; background: #fafafa; color: #1a1a1a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 12px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th { text-align: left; padding: 8px 12px; background: #f0f0f0; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 13px; }
  .value { font-weight: 600; color: #059669; }
  .overdue { color: #dc2626; font-weight: 600; }
  .stage { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .stage-lead { background: #dbeafe; color: #1d4ed8; }
  .stage-qualified { background: #ede9fe; color: #7c3aed; }
  .stage-proposal { background: #fef3c7; color: #b45309; }
  .stage-negotiation { background: #ffedd5; color: #c2410c; }
  .total { font-weight: 700; background: #f0f0f0; }
  .empty { color: #999; font-style: italic; padding: 20px; text-align: center; }
`;

export function generatePipelineReport(db: Database.Database): string {
  const pipeline = db.prepare(`
    SELECT stage, COUNT(*) as count, COALESCE(SUM(value_nok), 0) as total_value
    FROM crm_deals WHERE stage NOT IN ('closed_won', 'closed_lost')
    GROUP BY stage
    ORDER BY CASE stage WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3 WHEN 'negotiation' THEN 4 END
  `).all() as PipelineStage[];

  const deals = db.prepare(`
    SELECT d.*, c.name as contact_name, co.name as company_name
    FROM crm_deals d LEFT JOIN crm_contacts c ON d.contact_id = c.id LEFT JOIN crm_companies co ON d.company_id = co.id
    WHERE d.stage NOT IN ('closed_won', 'closed_lost') ORDER BY d.created_at DESC
  `).all() as Deal[];

  const followUps = db.prepare(`
    SELECT a.*, c.name as contact_name FROM crm_activities a
    LEFT JOIN crm_contacts c ON a.contact_id = c.id
    WHERE a.type = 'task' AND a.due_at IS NOT NULL AND a.completed_at IS NULL
    ORDER BY a.due_at ASC
  `).all() as Activity[];

  const totalValue = pipeline.reduce((s, p) => s + p.total_value, 0);
  const totalDeals = pipeline.reduce((s, p) => s + p.count, 0);
  const today = new Date().toISOString().split('T')[0];

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLES}</style></head><body>`;
  html += `<h1>Pipeline Report</h1>`;
  html += `<div class="subtitle">${new Date().toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} &middot; ${totalDeals} deals &middot; ${formatNOK(totalValue)}</div>`;

  html += `<h2>Pipeline Summary</h2><table><tr><th>Stage</th><th>Deals</th><th>Value</th></tr>`;
  for (const p of pipeline) {
    html += `<tr><td><span class="stage stage-${safeStageClass(p.stage)}">${escapeHtml(p.stage)}</span></td><td>${p.count}</td><td class="value">${formatNOK(p.total_value)}</td></tr>`;
  }
  html += `<tr class="total"><td>Total</td><td>${totalDeals}</td><td class="value">${formatNOK(totalValue)}</td></tr></table>`;

  html += `<h2>Active Deals</h2>`;
  if (deals.length === 0) {
    html += `<div class="empty">No active deals</div>`;
  } else {
    html += `<table><tr><th>Deal</th><th>Contact</th><th>Stage</th><th>Value</th></tr>`;
    for (const d of deals) {
      html += `<tr><td>${escapeHtml(d.title)}</td><td>${escapeHtml(d.contact_name ?? '-')}</td><td><span class="stage stage-${safeStageClass(d.stage)}">${escapeHtml(d.stage)}</span></td><td class="value">${d.value_nok != null ? formatNOK(d.value_nok) : '-'}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<h2>Pending Follow-ups</h2>`;
  if (followUps.length === 0) {
    html += `<div class="empty">No pending follow-ups</div>`;
  } else {
    html += `<table><tr><th>Task</th><th>Contact</th><th>Due</th></tr>`;
    for (const f of followUps) {
      const isOverdue = f.due_at && f.due_at < today;
      html += `<tr><td>${escapeHtml(f.subject ?? '-')}</td><td>${escapeHtml(f.contact_name ?? '-')}</td><td class="${isOverdue ? 'overdue' : ''}">${f.due_at?.substring(0, 10) ?? '-'}${isOverdue ? ' (overdue)' : ''}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `</body></html>`;
  return html;
}

export function generateMeetingSummaryHtml(db: Database.Database, meetingId: string): string | null {
  const meeting = db.prepare('SELECT * FROM crm_meetings WHERE id = ?').get(meetingId) as {
    title: string; summary: string | null; action_items: string | null;
    ai_parsed: string | null; email_draft: string | null; meeting_start: string | null;
    attendees: string | null;
  } | null;

  if (!meeting) return null;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLES}</style></head><body>`;
  html += `<h1>${escapeHtml(meeting.title ?? 'Meeting')}</h1>`;
  if (meeting.meeting_start) html += `<div class="subtitle">${new Date(meeting.meeting_start).toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' })}</div>`;

  if (meeting.summary) {
    html += `<h2>Summary</h2><p>${escapeHtml(meeting.summary)}</p>`;
  }

  if (meeting.action_items) {
    try {
      const items = JSON.parse(meeting.action_items) as Array<{ text?: string; description?: string }>;
      html += `<h2>Action Items</h2><ul>`;
      for (const item of items) html += `<li>${escapeHtml(item.text ?? item.description ?? '')}</li>`;
      html += `</ul>`;
    } catch { /* skip */ }
  }

  if (meeting.ai_parsed) {
    try {
      const ai = JSON.parse(meeting.ai_parsed);
      html += `<h2>AI Analysis</h2>`;
      html += `<p><strong>Category:</strong> ${escapeHtml(ai.meeting_category ?? 'unknown')}</p>`;
      if (ai.deal_signals) {
        html += `<p><strong>Interest:</strong> ${escapeHtml(ai.deal_signals.interest_level ?? 'unknown')}`;
        if (ai.deal_signals.budget_mentioned) html += ` &middot; Budget mentioned`;
        html += `</p>`;
        if (ai.deal_signals.needs?.length) html += `<p><strong>Needs:</strong> ${ai.deal_signals.needs.map(escapeHtml).join(', ')}</p>`;
      }
    } catch { /* skip */ }
  }

  if (meeting.email_draft) {
    html += `<h2>Follow-up Email Draft</h2><div style="background:#f8f8f8;padding:16px;border-radius:8px;border:1px solid #e0e0e0;white-space:pre-wrap;font-size:13px;">${escapeHtml(meeting.email_draft)}</div>`;
  }

  html += `</body></html>`;
  return html;
}
