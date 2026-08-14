import type { VercelRequest, VercelResponse } from '@vercel/node';
import { synthesizeSpeech } from './_lib/tts.js';
import type { Lang } from './_lib/finance.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SARVAM_API_KEY is not set' });

  try {
    const { text, lang } = (req.body ?? {}) as { text?: string; lang?: Lang };
    if (!text) throw new Error('Missing text');

    const result = await synthesizeSpeech(apiKey, text, lang ?? 'en');
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
}
