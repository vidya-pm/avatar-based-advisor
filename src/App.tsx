import { useEffect, useRef, useState } from 'react';
import { initAvatar, speak, stopSpeaking } from './lib/avatar';
import type { SearchResult, FundMatch, Lang, Turn as HistoryTurn } from '../api/_lib/finance';

interface Turn {
  question: string;
  answer?: string;
  sources?: SearchResult[];
  fundMatches?: FundMatch[];
  error?: string;
}

// Matches a run of text up to and including a sentence-ending punctuation mark, so we can
// start speaking each sentence as soon as it's fully streamed in rather than waiting for
// the whole answer to finish generating.
const SENTENCE_RE = /[^.!?]*[.!?]+/;

export default function App() {
  const avatarRef = useRef<HTMLDivElement>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [lang, setLang] = useState<Lang>('en');
  const [speaking, setSpeaking] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!avatarRef.current) return;
    initAvatar(avatarRef.current)
      .then(() => setAvatarReady(true))
      .catch((err) => setAvatarError(err instanceof Error ? err.message : 'Failed to load avatar'));
  }, []);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setQuestion('');
    setLoading(true);
    const turnIndex = turns.length;
    setTurns((t) => [...t, { question: q }]);

    const history: HistoryTurn[] = turns
      .filter((t): t is Turn & { answer: string } => !!t.answer)
      .map((t) => ({ question: t.question, answer: t.answer }));

    // Sentences are spoken as they complete, in order, via a chained promise — speak()
    // itself does an async TTS fetch + decode, so without chaining, two sentences whose
    // fetches resolve out of order could get queued into the avatar backwards.
    let speechChain = Promise.resolve();
    function enqueueSpeech(sentence: string) {
      const trimmed = sentence.trim();
      if (!trimmed || !avatarReady) return;
      setSpeaking(true);
      speechChain = speechChain.then(() => speak(trimmed, lang)).catch(console.error);
    }

    try {
      const res = await fetch('/api/advise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, lang, history }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Something went wrong');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullAnswer = '';
      let pendingSpeech = '';
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const event = JSON.parse(trimmed.slice(5).trim()) as
            | { type: 'delta'; text: string }
            | { type: 'done'; sources: SearchResult[]; fundMatches: FundMatch[] }
            | { type: 'error'; error: string };

          if (event.type === 'delta') {
            fullAnswer += event.text;
            pendingSpeech += event.text;
            const currentAnswer = fullAnswer;
            setTurns((t) => {
              const next = [...t];
              next[turnIndex] = { ...next[turnIndex], question: q, answer: currentAnswer };
              return next;
            });

            let match;
            while ((match = SENTENCE_RE.exec(pendingSpeech))) {
              enqueueSpeech(match[0]);
              pendingSpeech = pendingSpeech.slice(match[0].length);
            }
          } else if (event.type === 'done') {
            if (pendingSpeech.trim()) enqueueSpeech(pendingSpeech);
            const finalAnswer = fullAnswer;
            setTurns((t) => {
              const next = [...t];
              next[turnIndex] = {
                question: q,
                answer: finalAnswer,
                sources: event.sources,
                fundMatches: event.fundMatches,
              };
              return next;
            });
          } else if (event.type === 'error') {
            streamError = event.error;
          }
        }
      }

      if (streamError) throw new Error(streamError);
      speechChain.finally(() => setSpeaking(false));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setTurns((t) => {
        const next = [...t];
        next[turnIndex] = { question: q, error: message };
        return next;
      });
      setSpeaking(false);
    } finally {
      setLoading(false);
    }
  }

  function handleStop() {
    stopSpeaking();
    setSpeaking(false);
  }

  function handleNewChat() {
    stopSpeaking();
    setSpeaking(false);
    setTurns([]);
    setQuestion('');
  }

  async function handleCopy(text: string, i: number) {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(i);
    setTimeout(() => setCopiedIndex((cur) => (cur === i ? null : cur)), 1500);
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: '40%', minWidth: 320, position: 'relative', background: '#0c0d10' }}>
        <div ref={avatarRef} style={{ width: '100%', height: '100%' }} />
        {!avatarReady && !avatarError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Loading avatar…
          </div>
        )}
        {avatarError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: '#ff8080' }}>
            {avatarError}
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Artha — investing information assistant</h1>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              type="button"
              onClick={handleNewChat}
              disabled={turns.length === 0}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #333',
                background: 'transparent',
                color: turns.length === 0 ? '#555' : 'inherit',
                fontSize: 12,
                cursor: turns.length === 0 ? 'default' : 'pointer',
              }}
            >
              + New chat
            </button>
            {speaking && (
              <button
                type="button"
                onClick={handleStop}
                style={{
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: '1px solid #333',
                  background: 'transparent',
                  color: '#ff8080',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                ■ Stop
              </button>
            )}
            {(['en', 'ml'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: '1px solid #333',
                  background: lang === l ? '#3b6ef2' : 'transparent',
                  color: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {l === 'en' ? 'English' : 'മലയാളം'}
              </button>
            ))}
          </div>
        </div>
        <p style={{ margin: '0 0 16px', color: '#9a9a9a', fontSize: 13 }}>
          Covers mutual funds and markets across India, the GCC, and globally. Not a registered financial adviser —
          general information only.
        </p>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {turns.map((t, i) => (
            <div key={i}>
              <div style={{ fontWeight: 600 }}>{t.question}</div>
              {t.answer && (
                <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>{t.answer}</div>
                  <button
                    type="button"
                    onClick={() => handleCopy(t.answer!, i)}
                    style={{
                      flexShrink: 0,
                      padding: '2px 8px',
                      borderRadius: 4,
                      border: '1px solid #333',
                      background: 'transparent',
                      color: '#9a9a9a',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    {copiedIndex === i ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              )}
              {t.error && <div style={{ marginTop: 4, color: '#ff8080' }}>{t.error}</div>}
              {t.sources && t.sources.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#8a8a8a' }}>
                  Sources: {t.sources.map((s, j) => (
                    <span key={s.url}>
                      {j > 0 && ', '}
                      <a href={s.url} target="_blank" rel="noreferrer" style={{ color: '#8ab4f8' }}>
                        {s.title}
                      </a>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {loading && <div style={{ color: '#9a9a9a' }}>Thinking…</div>}
        </div>

        <form onSubmit={handleAsk} style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about a mutual fund, market, or investing topic…"
            style={{ flex: 1, padding: '10px 12px', borderRadius: 6, border: '1px solid #333', background: '#1c1e22', color: 'inherit' }}
          />
          <button type="submit" disabled={loading} style={{ padding: '10px 16px', borderRadius: 6, border: 'none', background: '#3b6ef2', color: 'white' }}>
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}
