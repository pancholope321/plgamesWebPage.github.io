export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*', // Change to your domain if needed
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  
  // Only allow GET method
  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { 
        status: 405, 
        headers 
      }
    );
  }
  
  try {
    // Get limit from query parameter, default to 10
    const limit = parseInt(url.searchParams.get('limit')) || 10;
    
    // Fetch top scores from database
    const { results } = await env.DB.prepare(`
      SELECT 
        id,
        name, 
        score, 
        timestamp,
        ROW_NUMBER() OVER (ORDER BY score DESC) as rank
      FROM scores 
      ORDER BY score DESC 
      LIMIT ?
    `).bind(limit).all();
    
    // Format the response
    const leaderboard = results.map(row => ({
      id: row.id,
      rank: row.rank,
      name: row.name,
      score: row.score,
      timestamp: row.timestamp,
      date: new Date(row.timestamp).toLocaleDateString()
    }));
    
    // Return the leaderboard
    return new Response(
      JSON.stringify(leaderboard), 
      { 
        status: 200,
        headers 
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        error: 'Failed to fetch leaderboard',
        details: error.message 
      }), 
      { 
        status: 500, 
        headers 
      }
    );
  }
}