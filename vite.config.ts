import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { advise, type Lang, type Turn } from './api/_lib/finance.ts';
import { synthesizeSpeech } from './api/_lib/tts.ts';

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * Dev-server-only proxies mirroring api/advise.ts and api/tts.ts. Keys are read from
 * process.env (via loadEnv below, NOT the VITE_ prefix) so they never get inlined into
 * client-bundled code — only this Node-side middleware ever sees them. The browser talks
 * to same-origin /api/advise and /api/tts, nothing else.
 */
function apiProxyPlugin(env: Record<string, string>): Plugin {
  const tavilyKey = env.TAVILY_API_KEY;
  const groqKey = env.GROQ_API_KEY;
  const sarvamKey = env.SARVAM_API_KEY;

  return {
    name: 'advisor-api-proxy',
    configureServer(server) {
      server.middlewares.use('/api/advise', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        if (!tavilyKey) return sendJson(res, 500, { error: 'TAVILY_API_KEY is not set in .env.local' });
        if (!groqKey) return sendJson(res, 500, { error: 'GROQ_API_KEY is not set in .env.local' });

        let question: string | undefined;
        let lang: Lang | undefined;
        let history: Turn[] | undefined;
        try {
          ({ question, lang, history } = JSON.parse((await readBody(req)) || '{}') as {
            question?: string;
            lang?: Lang;
            history?: Turn[];
          });
          if (!question) throw new Error('Missing question');
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        }

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
      });

      server.middlewares.use('/api/tts', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        if (!sarvamKey) return sendJson(res, 500, { error: 'SARVAM_API_KEY is not set in .env.local' });

        try {
          const { text, lang } = JSON.parse((await readBody(req)) || '{}') as { text?: string; lang?: Lang };
          if (!text) throw new Error('Missing text');
          const result = await synthesizeSpeech(sarvamKey, text, lang ?? 'en');
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 502, { error: err instanceof Error ? err.message : 'Unknown error' });
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), apiProxyPlugin(env)],
    // Restrict the dep scanner to our own entry — the vendored TalkingHead repo also
    // ships its own demo/test HTML files (examples-full-demo/, tests/) with unrelated,
    // uninstalled dependencies that would otherwise trip up Vite's crawler.
    optimizeDeps: {
      entries: ['index.html'],
    },
    server: {
      host: true,
    },
  };
});
