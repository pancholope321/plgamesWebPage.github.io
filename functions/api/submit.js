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
  console.log("this is the referer: ", referer)
  const containsItchIO = referer.includes('itch.zone') || origin.includes('itch.zone');
  
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
    
    // === CHECK TABLE SIZE BEFORE INSERTION ===
    const tableSizeResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM scores'
    ).first();
    
    const tableSize = tableSizeResult?.count || 0;
    console.log(`Current table size: ${tableSize} rows`);
    
    let cleanupPerformed = false;
    let rowsRemoved = 0;
    let newTableSize = 0;
    
    // If table has more than 10,000 rows, keep only top 100 scores AND reset auto-increment
    if (tableSize >= 10000) {
      console.log(`Table is at or over limit (${tableSize} >= 10000), resetting to top 100 scores with new IDs...`);
      cleanupPerformed = true;
      
      // METHOD 1: Complete reset with new IDs (resets auto-increment)
      try {
        // Step 1: Get top 100 scores
        const topScoresResult = await env.DB.prepare(`
          SELECT name, score 
          FROM scores 
          ORDER BY score DESC, timestamp ASC 
          LIMIT 100
        `).all();
        
        const topScores = topScoresResult.results || [];
        rowsRemoved = tableSize - topScores.length;
        
        console.log(`Found ${topScores.length} top scores to keep`);
        
        // Step 2: Create a temporary table with the same structure
        await env.DB.prepare(`
          CREATE TEMPORARY TABLE scores_temp AS 
          SELECT name, score, CURRENT_TIMESTAMP as timestamp
          FROM scores 
          WHERE 1=0
        `).run();
        
        console.log("Created temporary table");
        
        // Step 3: Insert top scores into temporary table
        for (const row of topScores) {
          await env.DB.prepare(
            'INSERT INTO scores_temp (name, score) VALUES (?, ?)'
          ).bind(row.name, row.score).run();
        }
        
        console.log(`Inserted ${topScores.length} scores into temporary table`);
        
        // Step 4: Delete all rows from original table (truncates)
        await env.DB.prepare('DELETE FROM scores').run();
        
        // Step 5: Reset auto-increment sequence
        // For SQLite, we need to delete from sqlite_sequence
        try {
          await env.DB.prepare(`
            DELETE FROM sqlite_sequence WHERE name='scores'
          `).run();
          console.log("Reset auto-increment counter");
        } catch (seqError) {
          console.log("Note: Could not reset sqlite_sequence table:", seqError.message);
          // This is okay - not all SQLite setups have this table
        }
        
        // Step 6: Copy scores back from temporary table
        const copyResult = await env.DB.prepare(`
          INSERT INTO scores (name, score) 
          SELECT name, score FROM scores_temp
        `).run();
        
        console.log(`Copied ${copyResult.changes} scores back to main table`);
        
        // Step 7: Drop temporary table
        await env.DB.prepare('DROP TABLE IF EXISTS scores_temp').run();
        
        console.log("Cleanup and ID reset completed");
        
      } catch (cleanupError) {
        console.error("Cleanup error, trying simpler method:", cleanupError);
        
        // FALLBACK METHOD: Simple delete without temp table
        const cleanupResult = await env.DB.prepare(`
          DELETE FROM scores 
          WHERE id NOT IN (
            SELECT id FROM scores 
            ORDER BY score DESC, timestamp ASC 
            LIMIT 100
          )
        `).run();
        
        rowsRemoved = cleanupResult.changes || 0;
        console.log(`Fallback cleanup: ${rowsRemoved} rows removed`);
        
        // Try to reset auto-increment
        try {
          // Get max ID after cleanup
          const maxIdResult = await env.DB.prepare(
            'SELECT MAX(id) as max_id FROM scores'
          ).first();
          
          const maxId = maxIdResult?.max_id || 0;
          console.log(`Max ID after cleanup: ${maxId}`);
          
          // If max ID is very high, reset it
          if (maxId > 1000000) {
            console.log("Max ID is very high, attempting to reset...");
            // In SQLite, we can't easily reset to a specific value
            // The next insert will use max(id)+1
          }
        } catch (idError) {
          console.log("Could not check/reset max ID:", idError.message);
        }
      }
      
      // Get new table size
      const newSizeResult = await env.DB.prepare(
        'SELECT COUNT(*) as total FROM scores'
      ).first();
      
      newTableSize = newSizeResult?.total || 0;
      console.log(`Table now has ${newTableSize} rows after cleanup`);
    }
    
    // Insert the new score
    const insertResult = await env.DB.prepare(
      'INSERT INTO scores (name, score) VALUES (?, ?)'
    ).bind(trimmedName, scoreNum).run();
    
    console.log("Insert result:", insertResult);
    
    // Get current max ID to see what was assigned
    const maxIdAfterInsert = await env.DB.prepare(
      'SELECT MAX(id) as max_id FROM scores'
    ).first();
    
    console.log("Max ID after insertion:", maxIdAfterInsert?.max_id);
    
    // Get the player's rank
    const rankResult = await env.DB.prepare(`
      SELECT COUNT(*) + 1 as rank 
      FROM scores 
      WHERE score > ?
    `).bind(scoreNum).first();
    
    console.log("Rank result:", rankResult);
    
    // Get final table size if not already done
    if (!cleanupPerformed) {
      const finalSizeResult = await env.DB.prepare(
        'SELECT COUNT(*) as total FROM scores'
      ).first();
      newTableSize = finalSizeResult?.total || 0;
    }
    
    // Return success response
    const responseData = { 
      success: true, 
      message: 'Score submitted successfully!',
      rank: rankResult ? rankResult.rank : 1,
      id: insertResult.meta ? insertResult.meta.last_row_id : null,
      assignedId: maxIdAfterInsert?.max_id || insertResult.meta?.last_row_id
    };
    
    // Add cleanup info if cleanup was performed
    if (cleanupPerformed) {
      responseData.cleanupInfo = {
        performed: true,
        rowsRemoved: rowsRemoved,
        newTableSize: newTableSize,
        autoIncrementReset: true,
        message: `Table was reset to top 100 scores with new IDs (was ${tableSize} rows)`
      };
    } else {
      responseData.tableInfo = {
        currentSize: newTableSize,
        maxSizeBeforeCleanup: 10000,
        remainingCapacity: 10000 - newTableSize
      };
    }
    
    return new Response(
      JSON.stringify(responseData), 
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