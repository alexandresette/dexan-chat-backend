// api/claude.js — Proxy para Claude API (resolve CORS do browser)
// Aceita: { prompt, image_base64, image_type }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, image_base64, image_type = 'image/png', max_tokens = 1200 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

  // Montar mensagem
  const content = [];
  if (image_base64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image_type, data: image_base64 }
    });
  }
  content.push({ type: 'text', text: prompt });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens,
        messages: [{ role: 'user', content }]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: 'Claude API error', detail: err });
    }

    const data = await resp.json();
    const text = data.content.map(b => b.text || '').join('');
    return res.json({ text });

  } catch (err) {
    console.error('Claude proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
