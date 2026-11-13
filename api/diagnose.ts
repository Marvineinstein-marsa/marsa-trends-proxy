// Smart Kuku - Phase 3: image diagnosis endpoint (Gemini vision with model fallback)

const MODELS = (process.env.GEMINI_MODELS || 'gemini-2.5-flash,gemini-2.5-flash-lite')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server' });

  const { image, mime, prompt } = req.body || {};
  if (typeof image !== 'string' || typeof prompt !== 'string' || !image || !prompt) {
    return res.status(400).json({ error: 'image and prompt are required' });
  }
  if (image.length > 4_000_000) return res.status(413).json({ error: 'Photo is too large' });
  if (prompt.length > 3000) return res.status(400).json({ error: 'Prompt is too long' });

  const errors: string[] = [];
  for (const model of MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime || 'image/jpeg', data: image } }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      });
      if (!r.ok) {
        errors.push(`${model}: HTTP ${r.status}`);
        continue;
      }
      const j: any = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
      if (!text) {
        errors.push(`${model}: empty answer`);
        continue;
      }
      return res.status(200).json({ text, model });
    } catch (e: any) {
      errors.push(`${model}: ${e?.name === 'AbortError' ? 'timeout' : e?.message || 'error'}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return res.status(502).json({ error: 'All models failed', details: errors });
}
