export async function onRequest(context) {
  const { request, env } = context;

  const referer = request.headers.get('Referer') || request.headers.get('referer') || '';
  const origin = request.headers.get('Origin') || request.headers.get('origin') || '';

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const containsItchIO = referer.includes('itch.zone') || origin.includes('itch.zone');
  if (!containsItchIO && !referer.includes('localhost') && !origin.includes('localhost')) {
    return new Response(
      JSON.stringify({
        error: 'Unauthorized: Only itch.io games can submit scores',
        referer,
        origin,
        hint: 'Make sure your game is hosted on itch.io'
      }),
      { status: 403, headers }
    );
  }

  try {
    const bodyText = await request.text();
    const { name, score, gamemode } = JSON.parse(bodyText || '{}');

    if (!name || name.trim() === '') {
      return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400, headers });
    }

    if (score === undefined || score === null || isNaN(score) || Number(score) < 0) {
      return new Response(JSON.stringify({ error: 'Valid score is required' }), { status: 400, headers });
    }

    const trimmedName = name.trim().substring(0, 32);
    const scoreNum = parseInt(score, 10);
    const mode = (typeof gamemode === 'string' && gamemode.trim() !== '' ? gamemode.trim().substring(0, 32) : 'default');

    const tableSizeResult = await env.DB.prepare('SELECT COUNT(*) as count FROM scores_two_times').first();
    const tableSize = tableSizeResult?.count || 0;

    if (tableSize >= 10000) {
      await env.DB.prepare(`
        DELETE FROM scores_two_times
        WHERE id NOT IN (
          SELECT id FROM scores_two_times
          ORDER BY score DESC, timestamp ASC
          LIMIT 100
        )
      `).run();
      await env.DB.prepare(`DELETE FROM sqlite_sequence WHERE name='scores_two_times'`).run().catch(() => null);
    }

    const insertResult = await env.DB.prepare(
      'INSERT INTO scores_two_times (name, score, gamemode) VALUES (?, ?, ?)' 
    ).bind(trimmedName, scoreNum, mode).run();

    const rankResult = await env.DB.prepare(
      'SELECT COUNT(*) + 1 as rank FROM scores_two_times WHERE score > ? AND gamemode = ?'
    ).bind(scoreNum, mode).first();

    return new Response(JSON.stringify({
      success: true,
      message: 'Score submitted successfully for scores_two_times!',
      rank: rankResult?.rank || 1,
      id: insertResult.meta?.last_row_id || null,
      gamemode: mode
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to submit score to scores_two_times', details: error.message }), { status: 500, headers });
  }
}
