export async function onRequest(context) {
  const { request, env } = context;
  
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
  
  // Only allow POST method
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { 
        status: 405, 
        headers 
      }
    );
  }
  
  try {
    // Parse the JSON body
    const { name, score } = await request.json();
    
    // Validate input
    if (!name || name.trim() === '') {
      return new Response(
        JSON.stringify({ error: 'Name is required' }),
        { 
          status: 400, 
          headers 
        }
      );
    }
    
    if (!score || isNaN(score) || score < 0) {
      return new Response(
        JSON.stringify({ error: 'Valid score is required' }),
        { 
          status: 400, 
          headers 
        }
      );
    }
    
    // Insert the score into database
    const insertResult = await env.DB.prepare(
      'INSERT INTO scores (name, score) VALUES (?, ?)'
    ).bind(name.trim(), parseInt(score)).run();
    
    // Get the player's rank (players with higher scores)
    const rankResult = await env.DB.prepare(`
      SELECT COUNT(*) + 1 as rank 
      FROM scores 
      WHERE score > ?
    `).bind(parseInt(score)).first();
    
    // Return success response
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Score submitted successfully!',
        rank: rankResult.rank,
        id: insertResult.meta.last_row_id
      }), 
      { 
        status: 200,
        headers 
      }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        error: 'Failed to submit score',
        details: error.message 
      }), 
      { 
        status: 500, 
        headers 
      }
    );
  }
}