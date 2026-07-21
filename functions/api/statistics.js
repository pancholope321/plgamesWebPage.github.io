// POST  /api/statistics  -> game client submits a player powers/statistics snapshot
// GET   /api/statistics  -> admin-only retrieval (requires X-Admin-Key header or ?key=)

const MAX_BODY_BYTES = 100_000;       // hard cap on the whole request body
const MAX_JSON_FIELD_BYTES = 20_000;  // cap on "powers" / "statistics" each, once serialized
const MAX_STRING_LEN = 256;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  if (request.method === 'POST') {
    return handlePost(request, env, headers);
  }

  if (request.method === 'GET') {
    return handleGet(request, env, url, headers);
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function handlePost(request, env, headers) {
  // Same origin policy as the other submit endpoints: only the itch.io-hosted
  // game (or localhost during development) may write to this table.
  const referer = request.headers.get('Referer') || '';
  const origin = request.headers.get('Origin') || '';
  const containsItchIO = referer.includes('itch.zone') || origin.includes('itch.zone');

  if (!containsItchIO && !referer.includes('localhost') && !origin.includes('localhost')) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: Only itch.io games can submit statistics' }),
      { status: 403, headers }
    );
  }

  try {
    const rawBody = await request.text();

    if (rawBody.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413, headers });
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
    }

    if (!isPlainObject(data)) {
      return new Response(JSON.stringify({ error: 'Body must be a JSON object' }), { status: 400, headers });
    }

    const { fingerprint, timestamp, datetime, powers, statistics } = data;

    // --- validation: reject anything that isn't the exact shape we expect ---
    if (typeof fingerprint !== 'string' || fingerprint.trim() === '' || fingerprint.length > MAX_STRING_LEN) {
      return new Response(JSON.stringify({ error: 'Valid "fingerprint" is required' }), { status: 400, headers });
    }

    const timestampNum = Number(timestamp);
    if (!Number.isFinite(timestampNum) || timestampNum < 0) {
      return new Response(JSON.stringify({ error: 'Valid "timestamp" is required' }), { status: 400, headers });
    }

    if (typeof datetime !== 'string' || datetime.trim() === '' || datetime.length > 64) {
      return new Response(JSON.stringify({ error: 'Valid "datetime" is required' }), { status: 400, headers });
    }

    if (!isPlainObject(powers)) {
      return new Response(JSON.stringify({ error: '"powers" must be an object' }), { status: 400, headers });
    }

    if (!isPlainObject(statistics)) {
      return new Response(JSON.stringify({ error: '"statistics" must be an object' }), { status: 400, headers });
    }

    const powersJson = JSON.stringify(powers);
    const statisticsJson = JSON.stringify(statistics);

    if (powersJson.length > MAX_JSON_FIELD_BYTES || statisticsJson.length > MAX_JSON_FIELD_BYTES) {
      return new Response(JSON.stringify({ error: '"powers"/"statistics" payload too large' }), { status: 413, headers });
    }

    // Parameterized query: every value is bound, never string-concatenated into
    // the SQL text, so this is not vulnerable to SQL injection regardless of
    // what characters the client sends in fingerprint/datetime/JSON fields.
    const insertResult = await env.DB.prepare(
      `INSERT INTO player_statistics (fingerprint, client_timestamp, client_datetime, powers, statistics)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(fingerprint.trim(), timestampNum, datetime.trim(), powersJson, statisticsJson).run();

    return new Response(
      JSON.stringify({ success: true, id: insertResult.meta?.last_row_id || null }),
      { status: 200, headers }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to submit statistics', details: error.message }),
      { status: 500, headers }
    );
  }
}

async function handleGet(request, env, url, headers) {
  // This table stores per-device fingerprints and full player stat dumps, so
  // unlike the public leaderboard it must not be readable by anyone who finds
  // the URL. Require a server-side secret set via:
  //   wrangler pages secret put STATS_ADMIN_KEY --project-name=plgames
  const adminKey = env.STATS_ADMIN_KEY;
  const providedKey = request.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';

  if (!adminKey) {
    return new Response(
      JSON.stringify({ error: 'Server is not configured with STATS_ADMIN_KEY' }),
      { status: 500, headers }
    );
  }

  if (providedKey !== adminKey) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
  }

  try {
    const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 25, 100);
    const offset = (page - 1) * pageSize;
    const fingerprintFilter = (url.searchParams.get('fingerprint') || '').trim();

    const totalCountResult = fingerprintFilter
      ? await env.DB.prepare('SELECT COUNT(*) as total FROM player_statistics WHERE fingerprint = ?').bind(fingerprintFilter).first()
      : await env.DB.prepare('SELECT COUNT(*) as total FROM player_statistics').first();

    const totalCount = totalCountResult?.total || 0;

    const rowsQuery = fingerprintFilter
      ? `SELECT id, fingerprint, client_timestamp, client_datetime, powers, statistics, created_at
         FROM player_statistics WHERE fingerprint = ? ORDER BY id DESC LIMIT ? OFFSET ?`
      : `SELECT id, fingerprint, client_timestamp, client_datetime, powers, statistics, created_at
         FROM player_statistics ORDER BY id DESC LIMIT ? OFFSET ?`;

    const { results } = fingerprintFilter
      ? await env.DB.prepare(rowsQuery).bind(fingerprintFilter, pageSize, offset).all()
      : await env.DB.prepare(rowsQuery).bind(pageSize, offset).all();

    const data = (results || []).map(row => {
      let powers = null;
      let statistics = null;
      try { powers = JSON.parse(row.powers); } catch { /* leave null if corrupted */ }
      try { statistics = JSON.parse(row.statistics); } catch { /* leave null if corrupted */ }

      return {
        id: row.id,
        fingerprint: row.fingerprint,
        timestamp: row.client_timestamp,
        datetime: row.client_datetime,
        powers,
        statistics,
        createdAt: row.created_at
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
      JSON.stringify({ error: 'Failed to fetch statistics', details: error.message }),
      { status: 500, headers }
    );
  }
}
