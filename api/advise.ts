import type { VercelRequest, VercelResponse } from '@vercel/node';
import { advise } from './_lib/finance.js';
import type { Lang, Turn } from './_lib/finance.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tavilyKey = process.env.TAVILY_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!tavilyKey) return res.status(500).json({ error: 'TAVILY_API_KEY is not set' });
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY is not set' });

  const { question, lang, history } = (req.body ?? {}) as { question?: string; lang?: Lang; history?: Turn[] };
  if (!question) return res.status(400).json({ error: 'Missing question' });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  try {
    const { sources, fundMatches } = await advise(tavilyKey, groqKey, question, lang ?? 'en', history ?? [], (text) => {
      res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ type: 'done', sources, fundMatches })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : 'Unknown error' })}\n\n`);
  } finally {
    res.end();
  }
}
