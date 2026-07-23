// POST /api/summarize-sessions
//
// Cron target (called by a GitHub Actions schedule, not by browsers). Folds
// *closed* play sessions out of the raw player_statistics rows into the
// player_sessions summary table, so the dashboard reads pre-aggregated data
// instead of recomputing session grouping from every raw snapshot on every
// page load.
//
// A session is a run of one fingerprint's consecutive snapshots where no gap
// between two snapshots exceeds 20 minutes. A run only gets finalized once
// it's "closed" -- i.e. either it's not the most recent run for that player,
// or its last snapshot is already more than 20 minutes old -- so a session
// that might still be in progress right now is left alone until a later run
// picks it up. Rows are marked session_processed = 1 once folded into a
// summary row, so re-running this never double-counts them.

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

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json' };

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const secret = env.CRON_SECRET;
  const provided = request.headers.get('X-Cron-Secret') || '';

  if (!secret) {
    return new Response(JSON.stringify({ error: 'Server is not configured with CRON_SECRET' }), { status: 500, headers });
  }

  if (provided !== secret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
  }

  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const openThreshold = nowUnix - SESSION_GAP_SECONDS;

    const fpResult = await env.DB.prepare(
      'SELECT DISTINCT fingerprint FROM player_statistics WHERE session_processed = 0 LIMIT ?'
    ).bind(MAX_FINGERPRINTS_PER_RUN).all();

    const fingerprints = (fpResult.results || []).map(r => r.fingerprint);

    let sessionsFinalized = 0;
    let sessionsStillOpen = 0;
    const statements = [];

    for (const fingerprint of fingerprints) {
      const rowsResult = await env.DB.prepare(
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

        // Leave the trailing run alone if it might still be an active session.
        if (isLast && lastTs > openThreshold) {
          sessionsStillOpen += 1;
          return;
        }

        const summary = summarizeSession(run);

        statements.push(env.DB.prepare(
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
          statements.push(env.DB.prepare(
            `UPDATE player_statistics SET session_processed = 1 WHERE id IN (${idChunk.map(() => '?').join(',')})`
          ).bind(...idChunk));
        }

        sessionsFinalized += 1;
      });
    }

    if (statements.length) {
      await env.DB.batch(statements);
    }

    return new Response(JSON.stringify({
      success: true,
      fingerprintsScanned: fingerprints.length,
      sessionsFinalized,
      sessionsStillOpen
    }), { status: 200, headers });

  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to summarize sessions', details: error.message }),
      { status: 500, headers }
    );
  }
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

    // "max round" and "max day" are the same concept in this game, so only
    // CurrentDay is tracked (see PlayerEconomy.CurrentDay in the game's save data).
    const day = safeNumber(economy.CurrentDay);
    if (day >= maxDay) {
      maxDay = day;
      powersOnMaxDay = collectActivePowers(powers);
    }

    maxDueDate = Math.max(maxDueDate, safeNumber(economy.DueDate));
    maxCurrentDueDate = Math.max(maxCurrentDueDate, safeNumber(economy.Current_due_date));
    maxTickets = Math.max(maxTickets, safeNumber(powers.Tickets, safeNumber(economy.Tickets)));
    maxMoney = Math.max(maxMoney, safeNumber(economy.Money));

    // A "retry" is CurrentDay falling back to 0 after having progressed --
    // i.e. the player lost/restarted and began a new attempt within the same session.
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
