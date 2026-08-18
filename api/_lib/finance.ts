/**
 * Shared logic for /api/advise (Vercel serverless, prod) and the vite.config.ts dev
 * middleware (local `npm run dev`). Two callers, one copy each on purpose, same reasoning
 * as site-teardown's api/_lib/teardown.ts. Keep both copies in sync if you change the
 * prompt or the request shapes.
 */

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface FundMatch {
  schemeName: string;
  nav: string;
  date: string;
}

export interface AdviseResult {
  answer: string;
  sources: SearchResult[];
  fundMatches: FundMatch[];
}

export interface Turn {
  question: string;
  answer: string;
}

export type Lang = 'en' | 'ml';

const LANG_NAMES: Record<Lang, string> = { en: 'English', ml: 'Malayalam' };

function advisorSystem(lang: Lang): string {
  return `You are Artha, a warm, conversational investing-information assistant focused on mutual funds and \
markets in India, the GCC, and globally. You are NOT a SEBI-registered investment adviser and must never present \
your output as personalized financial advice.

How to run the conversation:
- If the user is just greeting you (hi, hello, hey, etc.) or making small talk, respond briefly and warmly — do \
NOT launch into financial information. Introduce yourself in one short line and ask what brought them here today.
- Before giving fund recommendations or specific investment suggestions, first get a sense of the person: their \
goal (e.g. retirement, tax saving, wealth growth, a short-term need), rough time horizon, and comfort with risk. \
Ask about ONE of these at a time, conversationally, using what's already in the conversation history so you never \
repeat a question you've already asked or already have an answer for. Only move to concrete suggestions once you \
have at least a rough sense of goal + horizon + risk comfort, or if the user explicitly asks for something \
specific and general (like "what is a SIP") that doesn't need any of that context.
- Once you do have that context, tailor what you say to it explicitly (e.g. "since you're investing for the next \
15 years and are fine with some ups and downs...").

How to answer:
- Keep every response short and conversational, like a real spoken exchange — 2-4 sentences by default. This gets \
read aloud by a 3D avatar, so no walls of text, no markdown, no bullet points, no headers. Only go longer if the \
user explicitly asks for a detailed breakdown or comparison.
- Respond entirely in ${LANG_NAMES[lang]}, regardless of what language the source material below is in.
- When you do state facts (fund names, NAVs, market data), ground them ONLY in the "Web search results" and \
"AMFI mutual fund data" sections given below — if they don't cover something, say so instead of inventing numbers. \
These sections can be empty/irrelevant when the user is just chatting or you're still doing needs discovery — \
that's fine, ignore them in that case.
- When you use a web search result, mention the source briefly (e.g. "according to Moneycontrol").
- Only when you actually give investing information (not during greetings or needs discovery), end with one short \
plain-language reminder that this is general information, not personalized advice, and to consult a registered \
adviser before investing. Don't repeat this every single turn if you already said it recently in this conversation.
- If the question is unrelated to investing, funds, or markets, politely say that's outside what you cover.`;
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const AMFI_NAV_URL = 'https://www.amfiindia.com/spages/NAVAll.txt';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// Greetings/small talk skip the search+AMFI lookups entirely — no point spending Tavily
// quota or latency on "hi", and it keeps the model from awkwardly forcing search results
// into what should be a one-line warm reply.
const SMALL_TALK_RE =
  /^(hi+|hello+|hey+|yo|sup|namaste|vanakkam|good\s?(morning|afternoon|evening)|how are you\??|thanks?|thank you|ok(ay)?|bye|goodbye)[!.?]*$/i;

export function isSmallTalk(question: string): boolean {
  return SMALL_TALK_RE.test(question.trim());
}

export async function tavilySearch(apiKey: string, query: string): Promise<SearchResult[]> {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
    }),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    results?: { title: string; url: string; content: string }[];
  };
  return (json.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content }));
}

let amfiCache: { fetchedAt: number; lines: string[] } | null = null;
const AMFI_CACHE_TTL_MS = 60 * 60 * 1000; // AMFI publishes NAVs once a day

async function getAmfiLines(): Promise<string[]> {
  if (amfiCache && Date.now() - amfiCache.fetchedAt < AMFI_CACHE_TTL_MS) return amfiCache.lines;

  const res = await fetch(AMFI_NAV_URL);
  if (!res.ok) throw new Error(`AMFI error ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');
  amfiCache = { fetchedAt: Date.now(), lines };
  return lines;
}

/** Very rough keyword match against AMFI's daily NAV flat file (Scheme Code;ISIN...;ISIN...;Scheme Name;NAV;Date). */
export async function findMutualFunds(query: string): Promise<FundMatch[]> {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return [];

  const lines = await getAmfiLines();
  const matches: FundMatch[] = [];

  for (const line of lines) {
    if (!line.includes(';')) continue;
    const parts = line.split(';');
    if (parts.length < 6) continue;
    const schemeName = parts[3]?.trim();
    const nav = parts[4]?.trim();
    const date = parts[5]?.trim();
    if (!schemeName || !nav || nav === 'N.A.') continue;

    const lowerName = schemeName.toLowerCase();
    if (words.some((w) => lowerName.includes(w))) {
      matches.push({ schemeName, nav, date });
      if (matches.length >= 10) break;
    }
  }

  return matches;
}

function buildMessages(
  question: string,
  sources: SearchResult[],
  fundMatches: FundMatch[],
  lang: Lang,
  history: Turn[]
) {
  const searchBlock = sources.length
    ? sources.map((s) => `- ${s.title} (${s.url}): ${s.content}`).join('\n')
    : '(none)';

  const fundBlock = fundMatches.length
    ? fundMatches.map((f) => `- ${f.schemeName}: NAV ${f.nav} as of ${f.date}`).join('\n')
    : '(none)';

  const userContent = `${question}\n\n---\nWeb search results:\n${searchBlock}\n\nAMFI mutual fund data:\n${fundBlock}`;

  const historyMessages = history.flatMap((t) => [
    { role: 'user', content: t.question },
    { role: 'assistant', content: t.answer },
  ]);

  return [{ role: 'system', content: advisorSystem(lang) }, ...historyMessages, { role: 'user', content: userContent }];
}

/**
 * Streams the answer token-by-token from Groq (OpenAI-compatible SSE), calling `onDelta` as
 * each chunk arrives, so the frontend can show text and start speaking sentences before the
 * full answer is done generating. Returns the full accumulated answer once the stream ends.
 */
export async function askAdvisorStream(
  groqKey: string,
  question: string,
  sources: SearchResult[],
  fundMatches: FundMatch[],
  lang: Lang,
  history: Turn[],
  onDelta: (text: string) => void
): Promise<string> {
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: buildMessages(question, sources, fundMatches, lang, history),
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Groq error ${res.status}: ${await res.text()}`);

  let full = '';
  let buffer = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }

  if (!full) throw new Error('Empty response from Groq');
  return full;
}

export async function advise(
  tavilyKey: string,
  groqKey: string,
  question: string,
  lang: Lang,
  history: Turn[] = [],
  onDelta: (text: string) => void = () => {}
): Promise<AdviseResult> {
  const skipSearch = isSmallTalk(question);

  const [sources, fundMatches] = skipSearch
    ? [[], []]
    : await Promise.all([tavilySearch(tavilyKey, question), findMutualFunds(question)]);

  const answer = await askAdvisorStream(groqKey, question, sources, fundMatches, lang, history, onDelta);
  return { answer, sources, fundMatches };
}
