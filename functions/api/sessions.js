// GET /api/sessions -> pre-aggregated play sessions (see player_sessions
// table, populated by /api/summarize-sessions on a schedule). This is what
// the statistics.html dashboard reads, instead of recomputing session
// grouping from every raw player_statistics row on every page load.

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 100, 100);
    const offset = (page - 1) * pageSize;
    const fingerprintFilter = (url.searchParams.get('fingerprint') || '').trim();

    const totalCountResult = fingerprintFilter
      ? await env.DB.prepare('SELECT COUNT(*) as total FROM player_sessions WHERE fingerprint = ?').bind(fingerprintFilter).first()
      : await env.DB.prepare('SELECT COUNT(*) as total FROM player_sessions').first();

    const totalCount = totalCountResult?.total || 0;

    const rowsQuery = fingerprintFilter
      ? `SELECT id, fingerprint, session_start, session_end, duration_seconds, snapshot_count,
                max_day, max_due_date, max_current_due_date, max_tickets, max_money,
                powers_on_max_day, retries, games_won, games_lost, summarized_at
         FROM player_sessions WHERE fingerprint = ? ORDER BY session_start DESC LIMIT ? OFFSET ?`
      : `SELECT id, fingerprint, session_start, session_end, duration_seconds, snapshot_count,
                max_day, max_due_date, max_current_due_date, max_tickets, max_money,
                powers_on_max_day, retries, games_won, games_lost, summarized_at
         FROM player_sessions ORDER BY session_start DESC LIMIT ? OFFSET ?`;

    const { results } = fingerprintFilter
      ? await env.DB.prepare(rowsQuery).bind(fingerprintFilter, pageSize, offset).all()
      : await env.DB.prepare(rowsQuery).bind(pageSize, offset).all();

    const data = (results || []).map(row => {
      let powersOnMaxDay = [];
      try {
        const parsed = JSON.parse(row.powers_on_max_day);
        if (Array.isArray(parsed)) powersOnMaxDay = parsed;
      } catch { /* leave [] if corrupted */ }

      return {
        id: row.id,
        fingerprint: row.fingerprint,
        start: row.session_start,
        end: row.session_end,
        durationSeconds: row.duration_seconds,
        snapshotCount: row.snapshot_count,
        maxDay: row.max_day,
        maxDueDate: row.max_due_date,
        maxCurrentDueDate: row.max_current_due_date,
        maxTickets: row.max_tickets,
        maxMoney: row.max_money,
        powersOnMaxDay,
        retries: row.retries,
        gamesWon: row.games_won,
        gamesLost: row.games_lost,
        summarizedAt: row.summarized_at
      };
    });

    const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);

    return new Response(JSON.stringify({
      success: true,
      data,
      pagination: {
        page,
        pageSize,
        total: totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1
      }
    }), { status: 200, headers });

  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to fetch sessions', details: error.message }),
      { status: 500, headers }
    );
  }
}
