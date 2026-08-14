/**
 * Sarvam AI text-to-speech (https://docs.sarvam.ai) — chosen over Google Cloud TTS
 * because it needs no card on file, has a real free credit grant, and has native
 * Malayalam (and other Indian language) voices instead of just English.
 * Shared by api/tts.ts (Vercel serverless, prod) and vite.config.ts's dev middleware.
 */

import type { Lang } from './finance.js';

const SARVAM_ENDPOINT = 'https://api.sarvam.ai/text-to-speech';
const MAX_CHARS = 2400; // REST endpoint caps requests at 2500 characters

const TARGET_LANGUAGE_CODE: Record<Lang, string> = {
  en: 'en-IN',
  ml: 'ml-IN',
};

export interface TtsResult {
  audioBase64: string; // base64-encoded WAV
}

export async function synthesizeSpeech(apiKey: string, text: string, lang: Lang): Promise<TtsResult> {
  const res = await fetch(SARVAM_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-subscription-key': apiKey },
    body: JSON.stringify({
      text: text.slice(0, MAX_CHARS),
      target_language_code: TARGET_LANGUAGE_CODE[lang],
      model: 'bulbul:v2',
      speaker: 'anushka',
    }),
  });
  if (!res.ok) throw new Error(`Sarvam TTS error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { audios?: string[] };
  const audioBase64 = json.audios?.[0];
  if (!audioBase64) throw new Error('Empty response from Sarvam TTS');
  return { audioBase64 };
}
