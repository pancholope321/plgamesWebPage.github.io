// POST  /api/statistics  -> game client submits a player powers/statistics snapshot
// GET   /api/statistics  -> public retrieval (no auth -- see note in handleGet)

const MAX_BODY_BYTES = 100_000;       // hard cap on the whole request body
const MAX_JSON_FIELD_BYTES = 20_000;  // cap on "powers" / "statistics" each, once serialized
const MAX_STRING_LEN = 256;

// Rate limiting: keyed by IP (from Cloudflare's CF-Connecting-IP header, which
// the client cannot forge) rather than by fingerprint, since fingerprint is
// arbitrary client-supplied data and a script could just send a new random
// one on every request to dodge a per-fingerprint limit.
const MIN_SECONDS_BETWEEN_SUBMISSIONS = 5;   // blocks rapid-fire spam (e.g. every scene change)
const MAX_SUBMISSIONS_PER_WINDOW = 30;       // blocks sustained flooding
const RATE_WINDOW_SECONDS = 600;             // ...within a 10 minute rolling window

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

// Some Godot save/serialization paths hand off a Dictionary that's already
// been through JSON.stringify() once (e.g. it was loaded from a save file as
// a JSON string rather than kept as a live Dictionary), so it arrives here
// double-encoded: a JSON string *containing* the object, not the object
// itself. Accept that shape too and parse it through, rather than rejecting
// otherwise-valid data.
function coerceToObject(value) {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
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

    const powersObj = coerceToObject(powers);
    if (!powersObj) {
      return new Response(JSON.stringify({ error: '"powers" must be an object or a JSON-encoded object string' }), { status: 400, headers });
    }

    const statisticsObj = coerceToObject(statistics);
    if (!statisticsObj) {
      return new Response(JSON.stringify({ error: '"statistics" must be an object or a JSON-encoded object string' }), { status: 400, headers });
    }

    const powersJson = JSON.stringify(powersObj);
    const statisticsJson = JSON.stringify(statisticsObj);

    if (powersJson.length > MAX_JSON_FIELD_BYTES || statisticsJson.length > MAX_JSON_FIELD_BYTES) {
      return new Response(JSON.stringify({ error: '"powers"/"statistics" payload too large' }), { status: 413, headers });
    }

    // --- rate limiting, keyed by the edge-verified client IP ---
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const nowUnix = Math.floor(Date.now() / 1000);

    const lastSubmission = await env.DB.prepare(
      'SELECT received_unix FROM player_statistics WHERE ip = ? ORDER BY id DESC LIMIT 1'
    ).bind(clientIp).first();

    if (lastSubmission && (nowUnix - lastSubmission.received_unix) < MIN_SECONDS_BETWEEN_SUBMISSIONS) {
      const retryAfter = MIN_SECONDS_BETWEEN_SUBMISSIONS - (nowUnix - lastSubmission.received_unix);
      return new Response(
        JSON.stringify({ error: 'Too many requests, slow down' }),
        { status: 429, headers: { ...headers, 'Retry-After': String(retryAfter) } }
      );
    }

    const windowCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM player_statistics WHERE ip = ? AND received_unix > ?'
    ).bind(clientIp, nowUnix - RATE_WINDOW_SECONDS).first();

    if ((windowCount?.count || 0) >= MAX_SUBMISSIONS_PER_WINDOW) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded, try again later' }),
        { status: 429, headers: { ...headers, 'Retry-After': String(RATE_WINDOW_SECONDS) } }
      );
    }

    // Parameterized query: every value is bound, never string-concatenated into
    // the SQL text, so this is not vulnerable to SQL injection regardless of
    // what characters the client sends in fingerprint/datetime/JSON fields.
    const insertResult = await env.DB.prepare(
      `INSERT INTO player_statistics (fingerprint, client_timestamp, client_datetime, powers, statistics, ip, received_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(fingerprint.trim(), timestampNum, datetime.trim(), powersJson, statisticsJson, clientIp, nowUnix).run();

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
  // NOTE: this endpoint is intentionally public (no admin key) at the user's
  // request, so anyone who knows/guesses this URL can read all fingerprints
  // and player stat dumps. There is no per-row sensitive/secret data (no auth
  // tokens, no purchase info) beyond the fingerprint + gameplay stats.
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
