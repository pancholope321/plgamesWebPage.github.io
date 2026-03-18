export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 10, 100);
    const offset = (page - 1) * pageSize;
    const requestedMode = (
      url.searchParams.get('gamemode')?.trim() ||
      url.searchParams.get('gameMode')?.trim() ||
      url.searchParams.get('mode')?.trim() ||
      ''
    );

    const totalCountQuery = requestedMode
      ? 'SELECT COUNT(*) as total FROM scores_two_times WHERE gamemode = ?'
      : 'SELECT COUNT(*) as total FROM scores_two_times';

    const totalCountResult = requestedMode
      ? await env.DB.prepare(totalCountQuery).bind(requestedMode).first()
      : await env.DB.prepare(totalCountQuery).first();

    const totalCount = totalCountResult?.total || 0;

    const rowsQuery = requestedMode
      ? `
        SELECT id, name, score, timestamp, gamemode,
            ROW_NUMBER() OVER (ORDER BY score DESC) as rank
        FROM scores_two_times
        WHERE gamemode = ?
        ORDER BY score DESC
        LIMIT ? OFFSET ?
      `
      : `
        SELECT id, name, score, timestamp, gamemode,
            ROW_NUMBER() OVER (ORDER BY score DESC) as rank
        FROM scores_two_times
        ORDER BY score DESC
        LIMIT ? OFFSET ?
      `;

    const { results } = requestedMode
      ? await env.DB.prepare(rowsQuery).bind(requestedMode, pageSize, offset).all()
      : await env.DB.prepare(rowsQuery).bind(pageSize, offset).all();

    const leaderboard = (results || []).map(r => ({
      id: r.id,
      rank: r.rank,
      name: r.name,
      score: r.score,
      timestamp: r.timestamp,
      date: new Date(r.timestamp).toLocaleDateString(),
      gamemode: r.gamemode
    }));

    const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);

    return new Response(JSON.stringify({
      success: true,
      data: leaderboard,
      requestedGamemode: requestedMode,
      // requestedGamemode: requestedMode || 'all',
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
    return new Response(JSON.stringify({ error: 'Failed to fetch leaderboard_two', details: error.message }), { status: 500, headers });
  }
}
