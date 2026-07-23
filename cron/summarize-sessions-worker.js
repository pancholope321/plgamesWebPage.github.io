// Standalone Cloudflare Worker (NOT a Pages Function -- this file is not
// picked up by the Pages build). Paste this into a separate Worker created
// in the Cloudflare dashboard, with:
//   - a D1 binding named "DB" pointing at the money_sweeper database
//   - a Cron Trigger (e.g. "0 6,18 * * *" for twice a day)
//
// It runs the exact same session-summarization logic as
// functions/api/summarize-sessions.js, but on a schedule via env.DB directly
// instead of over HTTP -- so it never touches the plgames.cl zone and can't
// be caught by that zone's Bot Fight Mode / WAF challenge page the way a
// GitHub Actions curl request to the public domain was.
//
// The fetch() handler below is just for manually testing/backfilling from
// this Worker's own *.workers.dev URL (which isn't covered by the plgames.cl
// zone's security settings, so it isn't challenged either) -- it requires
// the CRON_SECRET var/secret you set on this Worker (independent from any
// secret used elsewhere).

const SESSION_GAP_SECONDS = 20 * 60;
const MAX_FINGERPRINTS_PER_RUN = 200;
const MAX_IDS_PER_STATEMENT = 100; // D1/SQLite caps bound parameters per statement

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// The D1 binding in this Worker's dashboard settings is named "env.DB"
// (literally, dot included) rather than "DB". That's not standard Cloudflare
// convention -- normally you'd name the binding "DB" and reference it in
// code as env.DB, where ".DB" is just JS property-dot-access, not part of
// the name. But since the binding here really is named "env.DB", plain dot
// notation (env.DB) looks for a property literally called "DB" and won't
// find it; bracket notation is required: env["env.DB"].
function getDb(env) {
  return env['env.DB'];
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(summarizeSessions(getDb(env)));
  },

  async fetch(request, env) {
    const headers = { 'Content-Type': 'application/json' };
    const secret = env.CRON_SECRET;
    const url = new URL(request.url);
    const provided = request.headers.get('X-Cron-Secret') || url.searchParams.get('key') || '';

    if (!secret) {
      return new Response(JSON.stringify({ error: 'CRON_SECRET is not configured on this Worker' }), { status: 500, headers });
    }
    if (provided !== secret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }

    const db = getDb(env);
    if (!db) {
      return new Response(JSON.stringify({
        error: '"env.DB" binding is not bound on this Worker',
        availableEnvKeys: Object.keys(env)
      }), { status: 500, headers });
    }

    try {
      const result = await summarizeSessions(db);
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers });
    }
  }
};

async function summarizeSessions(db) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const openThreshold = nowUnix - SESSION_GAP_SECONDS;

  const fpResult = await db.prepare(
    'SELECT DISTINCT fingerprint FROM player_statistics WHERE session_processed = 0 LIMIT ?'
  ).bind(MAX_FINGERPRINTS_PER_RUN).all();

  const fingerprints = (fpResult.results || []).map(r => r.fingerprint);

  let sessionsFinalized = 0;
  let sessionsStillOpen = 0;
  const statements = [];

  for (const fingerprint of fingerprints) {
    const rowsResult = await db.prepare(
      `SELECT id, client_timestamp, powers FROM player_statistics
       WHERE fingerprint = ? AND session_processed = 0
       ORDER BY client_timestamp ASC`
    ).bind(fingerprint).all();

    const rows = rowsResult.results || [];
    if (!rows.length) continue;

    const runs = [];
    let current = [];
    for (const row of rows) {
      const ts = Number(row.client_timestamp);
      const lastTs = current.length ? Number(current[current.length - 1].client_timestamp) : null;
      if (current.length === 0 || (ts - lastTs) <= SESSION_GAP_SECONDS) {
        current.push(row);
      } else {
        runs.push(current);
        current = [row];
      }
    }
    if (current.length) runs.push(current);

    runs.forEach((run, index) => {
      const isLast = index === runs.length - 1;
      const lastTs = Number(run[run.length - 1].client_timestamp);

      if (isLast && lastTs > openThreshold) {
        sessionsStillOpen += 1;
        return;
      }

      const summary = summarizeSession(run);

      // INSERT OR IGNORE + the unique index on (fingerprint, session_start, session_end)
      // (see migration notes) makes this safe against double-processing -- if this exact
      // session was already summarized by another run (e.g. an overlapping manual trigger),
      // the insert is a silent no-op instead of creating a duplicate row.
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO player_sessions
          (fingerprint, session_start, session_end, duration_seconds, snapshot_count,
           max_day, max_due_date, max_current_due_date, max_tickets, max_money,
           powers_on_max_day, retries, games_won, games_lost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        fingerprint, summary.start, summary.end, summary.duration, summary.snapshotCount,
        summary.maxDay, summary.maxDueDate, summary.maxCurrentDueDate, summary.maxTickets, summary.maxMoney,
        JSON.stringify(summary.powersOnMaxDay), summary.retries, summary.gamesWon, summary.gamesLost
      ));

      const ids = run.map(r => r.id);
      for (const idChunk of chunkArray(ids, MAX_IDS_PER_STATEMENT)) {
        statements.push(db.prepare(
          `UPDATE player_statistics SET session_processed = 1 WHERE id IN (${idChunk.map(() => '?').join(',')})`
        ).bind(...idChunk));
      }

      sessionsFinalized += 1;
    });
  }

  if (statements.length) {
    await db.batch(statements);
  }

  return {
    success: true,
    fingerprintsScanned: fingerprints.length,
    sessionsFinalized,
    sessionsStillOpen
  };
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

function collectActivePowers(powers) {
  const set = new Set();
  for (let slot = 1; slot <= 8; slot++) {
    const arr = powers['Power_' + slot];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (typeof p === 'string' && p.trim() !== '') set.add(p);
    }
  }
  return Array.from(set);
}

function summarizeSession(rows) {
  let maxDay = 0, maxDueDate = 0, maxCurrentDueDate = 0, maxTickets = 0, maxMoney = 0;
  let powersOnMaxDay = [];
  let retries = 0;
  let gamesWon = 0, gamesLost = 0;
  let prevDay = null;
  let prevWon = false;
  let prevLost = false;

  for (const row of rows) {
    let powers = {};
    try {
      const parsed = JSON.parse(row.powers);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) powers = parsed;
    } catch {
      // corrupted/legacy row -- treat as an empty snapshot rather than fail the whole session
    }

    const economy = (powers.PlayerEconomy && typeof powers.PlayerEconomy === 'object' && !Array.isArray(powers.PlayerEconomy))
      ? powers.PlayerEconomy
      : {};

    const day = safeNumber(economy.CurrentDay);
    if (day >= maxDay) {
      maxDay = day;
      powersOnMaxDay = collectActivePowers(powers);
    }

    maxDueDate = Math.max(maxDueDate, safeNumber(economy.DueDate));
    maxCurrentDueDate = Math.max(maxCurrentDueDate, safeNumber(economy.Current_due_date));
    maxTickets = Math.max(maxTickets, safeNumber(powers.Tickets, safeNumber(economy.Tickets)));
    maxMoney = Math.max(maxMoney, safeNumber(economy.Money));

    if (prevDay !== null && prevDay > 0 && day === 0) retries += 1;
    prevDay = day;

    const won = Boolean(economy.game_won);
    if (won && !prevWon) gamesWon += 1;
    prevWon = won;

    const lost = Boolean(economy.game_lost);
    if (lost && !prevLost) gamesLost += 1;
    prevLost = lost;
  }

  const start = Number(rows[0].client_timestamp);
  const end = Number(rows[rows.length - 1].client_timestamp);

  return {
    start,
    end,
    duration: Math.max(end - start, 0),
    snapshotCount: rows.length,
    maxDay, maxDueDate, maxCurrentDueDate, maxTickets, maxMoney,
    powersOnMaxDay, retries, gamesWon, gamesLost
  };
}
