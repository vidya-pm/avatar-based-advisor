import { TalkingHead } from '../../modules/talkinghead.mjs';
import type { Lang } from '../../api/_lib/finance';

// Ready Player Me (the service TalkingHead's own examples pointed at) shut down its public
// platform on 2026-01-31 after being acquired by Netflix, taking its avatar CDN down with it.
// We use one of the sample GLBs vendored in this repo's avatars/ folder instead — copied into
// public/avatars/ so Vite serves it locally. Swap for any Mixamo-rigged GLB with ARKit/Oculus
// viseme blend shapes (see TALKINGHEAD_UPSTREAM.md Appendix A).
const AVATAR_URL = '/avatars/brunette.glb';

// Generic mouth shapes cycled for languages with no word-to-viseme dictionary (e.g.
// Malayalam) — TalkingHead only ships dictionaries for en/fi/de/fr/lt, and Sarvam's TTS
// doesn't return phoneme timing, so exact lip-sync isn't possible there. This produces an
// approximate "talking" motion instead of a frozen mouth.
const BABBLE_VISEMES = ['aa', 'E', 'O', 'PP', 'I', 'kk'];

let head: TalkingHead | null = null;
let loaded: Promise<void> | null = null;
let audioCtx: AudioContext | null = null;

// TalkingHead loads its lipsync-en.mjs dictionary via a fire-and-forget dynamic import
// (talkinghead.mjs's lipsyncGetProcessor) with no promise exposed to callers. Without this
// wait, a speak() call made right after the avatar loads can race that import and silently
// get zero visemes back — this is what "mouth not syncing" turned out to be.
async function waitForLipsyncModule(h: TalkingHead, lang: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(h as any).lipsync?.[lang]) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function initAvatar(container: HTMLElement): Promise<void> {
  if (loaded) return loaded;

  head = new TalkingHead(container, {
    lipsyncModules: ['en'],
    cameraView: 'upper',
  });

  loaded = head
    .showAvatar({
      url: AVATAR_URL,
      body: 'F',
      avatarMood: 'neutral',
      lipsyncLang: 'en',
    })
    .then(() => waitForLipsyncModule(head!, 'en'));

  return loaded;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function speak(text: string, lang: Lang): Promise<void> {
  if (!head) throw new Error('Avatar not initialized yet');
  await loaded;

  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, lang }),
  });
  const data = (await res.json()) as { audioBase64?: string; error?: string };
  if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'TTS failed');

  audioCtx ??= new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(data.audioBase64));
  const durationMs = audioBuffer.duration * 1000;

  if (lang === 'en') {
    // Real English word-to-viseme dictionary — split the text into words and spread them
    // evenly across the actual audio duration (Sarvam doesn't return per-word timestamps).
    const words = text.split(/\s+/).filter(Boolean);
    const wtimes = words.map((_, i) => (i / words.length) * durationMs);
    const wdurations = words.map(() => durationMs / words.length);
    head.speakAudio({ audio: audioBuffer, words, wtimes, wdurations }, { lipsyncLang: 'en' });
  } else {
    // No dictionary for this language — cycle a generic set of open mouth shapes so the
    // avatar still looks like it's talking, roughly timed to word count.
    const wordCount = Math.max(1, text.split(/\s+/).filter(Boolean).length);
    const step = durationMs / wordCount;
    const visemes = Array.from({ length: wordCount }, (_, i) => BABBLE_VISEMES[i % BABBLE_VISEMES.length]);
    const vtimes = visemes.map((_, i) => i * step);
    const vdurations = visemes.map(() => step * 0.8);
    // speakAudio()'s r.visemes handling is nested inside `if (r.words)` in talkinghead.mjs —
    // without a words array (matched in length, since wtimes/wdurations get indexed
    // unconditionally per word) the whole viseme block is skipped even though it's provided.
    head.speakAudio({
      audio: audioBuffer,
      words: visemes.map(() => '.'),
      wtimes: vtimes,
      wdurations: vdurations,
      visemes,
      vtimes,
      vdurations,
    });
  }

  // speakAudio() (unlike the built-in speakText()) doesn't trigger idle hand gestures on
  // its own — the library only wires that into its Google-TTS and streaming code paths.
  head.speakWithHands();
}

export function stopSpeaking(): void {
  head?.stopSpeaking();
}
