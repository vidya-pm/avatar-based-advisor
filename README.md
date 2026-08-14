# Artha — avatar-based investing information assistant

A talking 3D avatar that answers questions about mutual funds and markets in India, the GCC,
and globally, in English or Malayalam. Built on [TalkingHead](https://github.com/met4citizen/TalkingHead)
(kept in this repo under `modules/`, `avatars/`, etc. — see `TALKINGHEAD_UPSTREAM.md` for the
original docs).

**Not a registered financial adviser.** Answers are grounded in live web search and public
AMFI mutual fund data, but this is general information, not personalized investment advice.

## How it's wired together (all free, none of it needs a card)

- **Avatar + lip-sync**: TalkingHead, running fully client-side.
- **Web search**: [Tavily](https://tavily.com) — 1,000 searches/month free.
- **India mutual fund data**: AMFI's public daily NAV file, no key needed.
- **Reasoning**: [Groq](https://groq.com) — free-tier inference (`llama-3.3-70b-versatile`).
- **Speech**: [Sarvam AI](https://sarvam.ai) — native Indian-language TTS (English + Malayalam,
  plus most other Indian languages), ~₹1,000 free credit, no card required.

### About lip-sync accuracy

TalkingHead's precise mouth-shape sync relies on word-to-viseme dictionaries that only exist
for English, Finnish, German, French, and Lithuanian — there's no Malayalam one. For English
answers, the app spreads the real words across the actual audio duration and uses the English
dictionary (good sync). For Malayalam (or any other language), it falls back to cycling generic
mouth shapes across the audio duration — the avatar looks like it's talking, but the shapes
aren't phonetically accurate. See `src/lib/avatar.ts` for both code paths.

## Setup

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill in your own free keys:
   - `TAVILY_API_KEY` — https://app.tavily.com
   - `GROQ_API_KEY` — https://console.groq.com/keys
   - `SARVAM_API_KEY` — https://dashboard.sarvam.ai
3. `npm run dev`

## Deploying

Deploys to Vercel as-is (`api/advise.ts` and `api/tts.ts` become serverless functions). Set the
same three env vars in the Vercel project settings.

## Notes / next steps

- GCC market data has no clean free structured API, so those answers lean entirely on Tavily
  search results rather than real-time figures.
- The AMFI fund matcher (`api/_lib/finance.ts`) does simple keyword matching on scheme names —
  fine for a scaffold, but worth tightening if fund lookups feel noisy.
- Groq's `llama-3.3-70b-versatile` isn't officially trained/evaluated for Malayalam by Meta, so
  Malayalam answer quality is best-effort, not guaranteed — worth keeping an eye on.
- Sarvam's REST TTS endpoint caps requests at ~2,500 characters; longer answers get truncated
  before being spoken (see `MAX_CHARS` in `api/_lib/tts.ts`).
- This directory still has the original TalkingHead git history/remote from cloning. Re-init
  git (`rm -rf .git && git init`) if you want your own repo instead of upstream's.
