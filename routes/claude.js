export async function handleClaude(req, res) {
  const { prompt, image_base64, image_type = 'image/png', max_tokens = 1200 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

  const content = [];
  if (image_base64) content.push({ type: 'image', source: { type: 'base64', media_type: image_type, data: image_base64 } });
  content.push({ type: 'text', text: prompt });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens, messages: [{ role: 'user', content }] })
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Claude API error', detail: await resp.text() });
    const data = await resp.json();
    return res.json({ text: data.content.map(b => b.text || '').join('') });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
