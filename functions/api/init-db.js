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
    // Create the scores table if it doesn't exist
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
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