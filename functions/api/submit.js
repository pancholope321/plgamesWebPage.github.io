export async function onRequest(context) {
  const { request, env } = context;
  
  // Get the Referer/Origin header
  const referer = request.headers.get('Referer') || '';
  const origin = request.headers.get('Origin') || '';
  
  // List of allowed itch.io domains (more comprehensive)
  const ALLOWED_DOMAINS = [
    'https://itch.io',
    'https://*.itch.io',
    'https://pancholope321.itch.io/money-sweeper'
  ];
  
  // Check if the request comes from an allowed domain
  const isAllowed = ALLOWED_DOMAINS.some(domain => {
    // Handle wildcards
    if (domain.includes('*')) {
      // Replace * with .* for regex, escape other regex characters
      const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '.*');
      const regex = new RegExp('^' + escapedDomain);
      return regex.test(referer) || regex.test(origin);
    }
    // For domains without wildcards, check if starts with
    return referer.startsWith(domain) || origin.startsWith(domain);
  });
  
  // Special case: also allow if it contains 'itch.io' anywhere in the domain
  const containsItchIO = referer.includes('itch.io') || origin.includes('itch.io');
  
  if (!isAllowed && !containsItchIO) {
    return new Response(
      JSON.stringify({ 
        error: 'Unauthorized: Only itch.io games can submit scores',
        hint: 'Your game must be hosted on itch.io to submit scores'
      }), 
      { 
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
  
  // CORS headers
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
    
    // Trim and limit name length
    const trimmedName = name.trim().substring(0, 30);
    
    // Insert the score into database
    const insertResult = await env.DB.prepare(
      'INSERT INTO scores (name, score) VALUES (?, ?)'
    ).bind(trimmedName, parseInt(score)).run();
    
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