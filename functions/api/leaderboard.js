export async function onRequest(context) {
  const { request, env } = context;
  
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  
  const url = new URL(request.url);
  
  // INITIALIZE DB (run once via browser)
  if (url.pathname === '/api/init-db' && request.method === 'GET') {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return new Response('Database initialized', { headers });
  }
  
  // SUBMIT SCORE
  if (url.pathname === '/api/submit' && request.method === 'POST') {
    try {
      const { name, score } = await request.json();
      
      // Insert into database
      const result = await env.DB.prepare(
        'INSERT INTO scores (name, score) VALUES (?, ?)'
      ).bind(name, score).run();
      
      // Get player's rank
      const rankResult = await env.DB.prepare(`
        SELECT COUNT(*) + 1 as rank 
        FROM scores 
        WHERE score > ?
      `).bind(score).first();
      
      return new Response(
        JSON.stringify({ 
          success: true, 
          rank: rankResult.rank,
          id: result.meta.last_row_id 
        }),
        { headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers }
      );
    }
  }
  
  // GET LEADERBOARD
  if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
    const limit = url.searchParams.get('limit') || 10;
    
    const { results } = await env.DB.prepare(`
      SELECT name, score, timestamp 
      FROM scores 
      ORDER BY score DESC 
      LIMIT ?
    `).bind(limit).all();
    
    return new Response(
      JSON.stringify(results),
      { headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }
  
  return new Response('Not Found', { status: 404, headers });
}