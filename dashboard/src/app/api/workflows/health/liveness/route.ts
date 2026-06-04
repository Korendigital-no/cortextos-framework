/**
 * GET /api/workflows/health/liveness
 *
 * Payload-free liveness probe for monitors (load balancers, watcher crons,
 * external watchdogs) — the GAP-0034 use case WITHOUT the data exposure:
 * upstream #547 made the detailed fleet-health endpoint public; we expose only
 * {ok:true} anonymously and keep the data-bearing endpoint behind auth.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
