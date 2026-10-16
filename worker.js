/**
 * Claimcheck proxy for Groq (Cloudflare Worker).
 * Keeps GROQ_API_KEY on the server so the app never ships it.
 *
 * Setup:
 *   1. Workers & Pages > Create > Worker > paste this file > Deploy
 *   2. Settings > Variables and Secrets:
 *        GROQ_API_KEY     (Secret)  your gsk_... key
 *        ALLOWED_ORIGINS  (Text)    https://your-app.netlify.app   (comma separated, or * while testing)
 *   3. Put the worker URL in the app's CLAIMCHECK_CONFIG.proxyUrl
 *   4. Optional: Security > WAF > Rate limiting rule on this worker (e.g. 20 requests/min per IP)
 */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS = ['qwen/qwen3.8-27b'];
const MAX_BODY = 12 * 1024 * 1024;
const MAX_TOKENS = 6000;
const MAX_MESSAGES = 14;
const MAX_IMAGES = 3;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const norm = (s) => { try { return new URL(s.trim()).origin.toLowerCase(); } catch (e) { return s.trim().replace(/\/+$/, '').toLowerCase(); } };
    const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => (s.trim() === '*' ? '*' : norm(s))).filter(Boolean);
    const originOk = allowed.includes('*') || allowed.includes(origin.toLowerCase());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : (origin || allowed[0] || '*'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method === 'GET') return new Response(JSON.stringify({ ok: true, service: 'claimcheck-proxy', keySet: !!env.GROQ_API_KEY, allowedOrigins: allowed }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (!originOk) return json(403, 'Origin not allowed: ' + (origin || 'none'));
    if (req.method !== 'POST') return json(405, 'POST only');
    if (!env.GROQ_API_KEY) return json(500, 'GROQ_API_KEY is not set on the worker');
    if (Number(req.headers.get('Content-Length') || 0) > MAX_BODY) return json(413, 'Request too large');

    let body;
    try { body = await req.json(); } catch (e) { return json(400, 'Invalid JSON'); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return json(400, 'messages required');
    if (!MODELS.includes(body.model)) return json(400, 'Model not allowed');
    if (body.messages.length > MAX_MESSAGES) return json(400, 'Too many messages');
    const images = JSON.stringify(body.messages).match(/"type":"image_url"/g) || [];
    if (images.length > MAX_IMAGES) return json(400, 'Too many images');

    const payload = { ...body, stream: false, max_completion_tokens: Math.min(Number(body.max_completion_tokens) || 1200, MAX_TOKENS) };
    delete payload.max_tokens; delete payload.tools; delete payload.tool_choice;

    let up;
    try {
      up = await fetch(GROQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_API_KEY }, body: JSON.stringify(payload) });
    } catch (e) { return json(502, 'Could not reach Groq'); }
    return new Response(up.body, { status: up.status, headers: { ...cors, 'Content-Type': up.headers.get('Content-Type') || 'application/json' } });
  },
};
