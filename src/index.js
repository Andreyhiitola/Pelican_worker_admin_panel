export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const isAdmin = token === env.ADMIN_TOKEN;
    const isViewer = token === env.VIEWER_TOKEN || isAdmin;

    // ===== CONFIG ENDPOINT =====
    if (url.pathname === '/config.json') {
      if (!isViewer) return new Response('403', { status: 403, headers: corsHeaders });
      
      const tables = [
        { name: 'menu', priority: 'daily', role_required: 'editor', active: true },
        { name: 'price', priority: 'daily', role_required: 'editor', active: true },
        { name: 'offer', priority: 'daily', role_required: 'editor', active: true },
        { name: 'booking', priority: 'daily', role_required: 'editor', active: true },
        { name: 'zakazfoods', priority: 'daily', role_required: 'editor', active: true },
        { name: 'rules', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'reviews', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'contacts', priority: 'weekly', role_required: 'admin', active: true },
        { name: 'infrastructure', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'roomtypes', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'gallery', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'activities', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'faq', priority: 'weekly', role_required: 'editor', active: true },
        { name: 'aboutus', priority: 'weekly', role_required: 'admin', active: true }
      ];
      
      return new Response(JSON.stringify(tables), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ===== PUBLISH SINGLE TABLE =====
    if (url.pathname === '/api/admin/publish' && request.method === 'POST' && isAdmin) {
      const tableName = url.searchParams.get('table');
      
      try {
        const sheetData = await fetchGoogleSheet(env, tableName);
        if (!sheetData) {
          return new Response(JSON.stringify({ error: 'No data from Google Sheets' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const jsonData = convertSheetToJSON(sheetData, tableName);
        const published = await publishToGitHub(
          env,
          `${tableName}.json`,
          JSON.stringify(jsonData, null, 2),
          `Update ${tableName}.json from admin panel`
        );
        
        return new Response(JSON.stringify({ 
          success: published,
          table: tableName,
          rows: jsonData.length 
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
        
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // ===== PUBLISH ALL TABLES =====
    if (url.pathname === '/api/admin/publish-all' && request.method === 'POST' && isAdmin) {
      const tables = [
        'menu', 'price', 'offer', 'booking', 'zakazfoods',
        'rules', 'reviews', 'contacts', 'infrastructure', 
        'roomtypes', 'gallery', 'activities', 'faq', 'aboutus'
      ];
      
      const results = [];
      
      for (const tableName of tables) {
        try {
          const sheetData = await fetchGoogleSheet(env, tableName);
          if (!sheetData) {
            results.push({ table: tableName, status: 'error', message: 'No data' });
            continue;
          }
          
          const jsonData = convertSheetToJSON(sheetData, tableName);
          const published = await publishToGitHub(
            env,
            `${tableName}.json`,
            JSON.stringify(jsonData, null, 2),
            `Update ${tableName}.json - batch publish`
          );
          
          if (published) {
            results.push({ table: tableName, status: 'success', rows: jsonData.length });
          } else {
            results.push({ table: tableName, status: 'error', message: 'Publish failed' });
          }
        } catch (error) {
          results.push({ table: tableName, status: 'error', message: error.message });
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        published: results.filter(r => r.status === 'success').length,
        failed: results.filter(r => r.status === 'error').length,
        results
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response('404', { status: 404, headers: corsHeaders });
  }
};

// ===== GOOGLE SHEETS FETCH =====
async function fetchGoogleSheet(env, sheetName) {
  const SPREADSHEET_ID = '1_2eVHM6dqxqHrPqxX0Kb2xjcUa6fzRAjuQMFa5wK8rw';
  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  
  const jwtToken = await createJWT(serviceAccount);
  const range = `${sheetName}!A:Z`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`;
  
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${jwtToken}` }
  });
  
  const data = await response.json();
  return data.values || null;
}

// ===== CONVERT TO JSON =====
function convertSheetToJSON(rows, tableName) {
  if (!rows || rows.length < 2) return [];
  
  const headers = rows[0];
  const result = [];
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] || '';
    });
    result.push(obj);
  }
  
  return result;
}

// ===== PUBLISH TO GITHUB =====
async function publishToGitHub(env, filename, content, commitMessage) {
  const REPO = 'Andreyhiitola/pelikan-alakol-site_v2';
  const BRANCH = 'main';
  
  // Get current SHA
  const shaResponse = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filename}?ref=${BRANCH}`,
    { headers: { 'Authorization': `token ${env.GITHUB_TOKEN}` } }
  );
  
  let sha = null;
  if (shaResponse.ok) {
    const data = await shaResponse.json();
    sha = data.sha;
  }
  
  // Update/Create file
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filename}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: commitMessage,
        content: btoa(unescape(encodeURIComponent(content))),
        branch: BRANCH,
        ...(sha && { sha })
      })
    }
  );
  
  return response.ok;
}

// ===== JWT FOR GOOGLE =====
async function createJWT(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  
  const key = await crypto.subtle.importKey(
    'pkcs8',
    str2ab(serviceAccount.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedToken)
  );
  
  const encodedSignature = base64urlEncode(signature);
  const jwt = `${unsignedToken}.${encodedSignature}`;
  
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  
  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

function base64urlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function str2ab(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
