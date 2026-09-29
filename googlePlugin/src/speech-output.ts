/**
 * Reply playback for the local path, using the browser's own synthesiser.
 *
 * The Gemini path returns real audio over WebRTC and does not use this at all.
 * Keeping it here means the local path needs no TTS dependency or extra track.
 */
let voice: SpeechSynthesisVoice | null = null;
let current: SpeechSynthesisUtterance | null = null;
let muted = false;
let onDone: (() => void) | null = null;

function pickVoice() {
  if (voice || !('speechSynthesis' in globalThis)) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  voice = voices.find(v => v.lang.startsWith('en') && v.localService) ?? voices.find(v => v.lang.startsWith('en')) ?? voices[0];
}

if ('speechSynthesis' in globalThis) {
  speechSynthesis.addEventListener('voiceschanged', pickVoice);
  pickVoice();
}

export function speechAvailable(): boolean {
  return 'speechSynthesis' in globalThis;
}

export function setSpeechMuted(next: boolean) {
  muted = next;
  if (next) cancelSpeech();
}

export function onSpeechFinished(callback: (() => void) | null) {
  onDone = callback;
}

/** Speak one reply, replacing anything currently being spoken. */
export function speak(text: string) {
  if (muted || !text.trim() || !('speechSynthesis' in globalThis)) return;
  speechSynthesis.cancel();
  pickVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  utterance.onend = () => { current = null; onDone?.(); };
  utterance.onerror = () => { current = null; onDone?.(); };
  current = utterance;
  speechSynthesis.speak(utterance);
}

export function cancelSpeech() {
  if (!('speechSynthesis' in globalThis)) return;
  current = null;
  speechSynthesis.cancel();
  onDone?.();
}

export function isSpeaking(): boolean {
  return current !== null;
}
