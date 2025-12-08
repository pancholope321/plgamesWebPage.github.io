export async function onRequest(context) {
  const { request, env } = context;
  
  // Get the Referer/Origin header (case-insensitive)
  const referer = request.headers.get('Referer') || request.headers.get('referer') || '';
  const origin = request.headers.get('Origin') || request.headers.get('origin') || '';
  
  console.log("Headers received - Referer:", referer, "Origin:", origin);
  
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
  
  // Domain checking - FIXED VERSION
  const ALLOWED_DOMAINS = [
    'itch.io',
    'itch.io/',
    'pancholope321.itch.io',
    'pancholope321.itch.io/'
  ];
  
  // Check if request comes from an allowed domain
  let isAllowed = false;
  let matchedDomain = '';
  
  // Check both referer and origin
  const checkUrl = referer || origin;
  
  if (checkUrl) {
    try {
      const url = new URL(checkUrl);
      const hostname = url.hostname;
      
      // Check if hostname ends with any allowed domain
      isAllowed = ALLOWED_DOMAINS.some(domain => {
        if (hostname === domain || hostname.endsWith('.' + domain) || hostname.includes(domain)) {
          matchedDomain = domain;
          return true;
        }
        return false;
      });
      
      console.log("Domain check - Hostname:", hostname, "Is allowed:", isAllowed, "Matched:", matchedDomain);
      
    } catch (e) {
      console.log("Failed to parse URL:", checkUrl, "Error:", e.message);
      // Continue without domain check if URL is malformed
    }
  }
  
  // For testing, allow localhost and empty referer (direct API calls)
  const isLocalhost = checkUrl.includes('localhost') || checkUrl.includes('127.0.0.1');
  const isEmptyReferer = !referer && !origin; // Direct API call or browser extension
  
  // Comment out for production, uncomment for testing
  // const allowTest = true; // Set to false in production
  
  if (!isAllowed && !isLocalhost && !isEmptyReferer) {
    return new Response(
      JSON.stringify({ 
        error: 'Unauthorized: Only itch.io games can submit scores',
        details: {
          referer: referer,
          origin: origin,
          checkUrl: checkUrl,
          matchedDomain: matchedDomain,
          isAllowed: isAllowed
        },
        hint: 'Your game must be hosted on itch.io to submit scores. If testing locally, use localhost.'
      }), 
      { 
        status: 403,
        headers: headers
      }
    );
  }
  
  // Rest of your code remains the same...
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
    const trimmedName = name.trim().substring(0, 30);
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