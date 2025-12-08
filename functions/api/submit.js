export async function onRequest(context) {
  const { request, env } = context;
  
  // Get the Referer/Origin header
  const referer = request.headers.get('Referer') || request.headers.get('Referer') || '';
  const origin = request.headers.get('Origin') || request.headers.get('origin') || '';
  
  // CORS headers - set these FIRST
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  
  // Simple domain check - just check if it contains itch.io
  // Comment out strict checking temporarily for debugging
  console.log("this is the referer: ",referer)
  const containsItchIO = referer.includes('itch.zone') || origin.includes('itch.zone');
  
  // Only enable this check after everything works
  
  if (!containsItchIO && !referer.includes('localhost') && !origin.includes('localhost')) {
    return new Response(
      JSON.stringify({ 
        error: 'Unauthorized: Only itch.io games can submit scores',
        referer: referer,
        origin: origin,
        hint: 'Make sure your game is hosted on itch.io'
      }), 
      { 
        status: 403,
        headers: headers
      }
    );
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
    const body = await request.text();
    console.log("Received body:", body);
    
    const { name, score } = JSON.parse(body);
    
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
    
    // Trim and limit name length
    const trimmedName = name.trim().substring(0, 12);
    const scoreNum = parseInt(score);
    
    console.log("Inserting score:", trimmedName, scoreNum);
    
    // Insert the score into database
    const insertResult = await env.DB.prepare(
      'INSERT INTO scores (name, score) VALUES (?, ?)'
    ).bind(trimmedName, scoreNum).run();
    
    console.log("Insert result:", insertResult);
    
    // Get the player's rank
    const rankResult = await env.DB.prepare(`
      SELECT COUNT(*) + 1 as rank 
      FROM scores 
      WHERE score > ?
    `).bind(scoreNum).first();
    
    console.log("Rank result:", rankResult);
    
    // Return success response
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Score submitted successfully!',
        rank: rankResult ? rankResult.rank : 1,
        id: insertResult.meta ? insertResult.meta.last_row_id : null
      }), 
      { 
        status: 200,
        headers 
      }
    );
    
  } catch (error) {
    console.error("Error in onRequest:", error);
    return new Response(
      JSON.stringify({ 
        error: 'Failed to submit score',
        details: error.message,
        stack: error.stack 
      }), 
      { 
        status: 500, 
        headers 
      }
    );
  }
}