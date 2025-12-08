export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // CORS headers
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
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { status: 405, headers }
    );
  }
  
  try {
    // Get pagination parameters
    const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 10, 100);
    const offset = (page - 1) * pageSize;
    
    // Get total count
    const totalCountResult = await env.DB.prepare(
      'SELECT COUNT(*) as total FROM scores'
    ).first();
    const totalCount = totalCountResult ? totalCountResult.total : 0;
    
    // Fetch paginated scores with global ranking
    const { results } = await env.DB.prepare(`
      SELECT 
        id,
        name, 
        score, 
        timestamp,
        ROW_NUMBER() OVER (ORDER BY score DESC) as rank
      FROM scores 
      ORDER BY score DESC 
      LIMIT ? OFFSET ?
    `).bind(pageSize, offset).all();
    
    // Format response
    const leaderboard = results.map(row => ({
      id: row.id,
      rank: row.rank,
      name: row.name,
      score: row.score,
      timestamp: row.timestamp,
      date: new Date(row.timestamp).toLocaleDateString()
    }));
    
    // Calculate pagination info
    const totalPages = Math.ceil(totalCount / pageSize);
    
    return new Response(
      JSON.stringify({
        success: true,
        data: leaderboard,
        pagination: {
          page: page,
          pageSize: pageSize,
          total: totalCount,
          totalPages: totalPages,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        }
      }), 
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