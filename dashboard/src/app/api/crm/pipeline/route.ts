import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const pipeline = db.prepare(`
    SELECT stage, COUNT(*) as count, COALESCE(SUM(value_nok), 0) as total_value
    FROM crm_deals
    WHERE stage NOT IN ('closed_won', 'closed_lost')
    GROUP BY stage
    ORDER BY CASE stage
      WHEN 'lead' THEN 1
      WHEN 'qualified' THEN 2
      WHEN 'proposal' THEN 3
      WHEN 'negotiation' THEN 4
    END
  `).all();

  const closed = db.prepare(`
    SELECT stage, COUNT(*) as count, COALESCE(SUM(value_nok), 0) as total_value
    FROM crm_deals
    WHERE stage IN ('closed_won', 'closed_lost')
    GROUP BY stage
  `).all();

  const totalActive = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(value_nok), 0) as total_value
    FROM crm_deals
    WHERE stage NOT IN ('closed_won', 'closed_lost')
  `).get();

  return Response.json({ pipeline, closed, totalActive });
}
