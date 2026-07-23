export async function onRequest(context) {
  const { request, env } = context;
  
  // Add CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*', // Or your specific domain
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'text/plain'
  };
  
  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  
  // Only allow GET method
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers 
    });
  }
  
  try {
    // NOTE: env.DB.exec() splits statements on the "\n" character rather than
    // ";", so a multi-line-formatted CREATE TABLE breaks it (each line gets
    // run as its own incomplete statement). Using batch() with one prepared
    // statement per DDL command avoids that entirely.
    const statements = [
      `CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS scores_two_times (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        gamemode TEXT NOT NULL DEFAULT 'default',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS player_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        client_timestamp REAL NOT NULL,
        client_datetime TEXT NOT NULL,
        powers TEXT NOT NULL,
        statistics TEXT NOT NULL,
        ip TEXT,
        received_unix INTEGER NOT NULL DEFAULT 0,
        session_processed INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_player_statistics_fingerprint ON player_statistics(fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_player_statistics_created_at ON player_statistics(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_player_statistics_ip_time ON player_statistics(ip, received_unix)`,
      `CREATE INDEX IF NOT EXISTS idx_player_statistics_unprocessed ON player_statistics(fingerprint, session_processed, client_timestamp)`,
      `CREATE TABLE IF NOT EXISTS player_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        session_start REAL NOT NULL,
        session_end REAL NOT NULL,
        duration_seconds REAL NOT NULL,
        snapshot_count INTEGER NOT NULL,
        max_day INTEGER NOT NULL DEFAULT 0,
        max_due_date INTEGER NOT NULL DEFAULT 0,
        max_current_due_date INTEGER NOT NULL DEFAULT 0,
        max_tickets INTEGER NOT NULL DEFAULT 0,
        max_money INTEGER NOT NULL DEFAULT 0,
        powers_on_max_day TEXT NOT NULL DEFAULT '[]',
        retries INTEGER NOT NULL DEFAULT 0,
        games_won INTEGER NOT NULL DEFAULT 0,
        games_lost INTEGER NOT NULL DEFAULT 0,
        summarized_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_player_sessions_fingerprint ON player_sessions(fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_player_sessions_start ON player_sessions(session_start)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_player_sessions_unique ON player_sessions(fingerprint, session_start, session_end)`
    ];

    await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));

    return new Response('✅ Database initialized successfully!', {
      status: 200,
      headers
    });
    
  } catch (error) {
    return new Response(`❌ Error: ${error.message}`, { 
      status: 500,
      headers 
    });
  }
}