/**
 * Reply playback for the local path, using the browser's own synthesiser.
 *
 * The Gemini path returns real audio over WebRTC and does not use this at all.
 * Keeping it here means the local path needs no TTS dependency or extra track.
 *
 * Playback state is published through onPlaybackChange so the recogniser can be
 * stopped while we speak: on the same machine, the microphone hears this speech
 * and would otherwise transcribe the assistant's own reply as a new question.
 */
let voice: SpeechSynthesisVoice | null = null;
let current: SpeechSynthesisUtterance | null = null;
let muted = false;
let onDone: (() => void) | null = null;
let onChange: ((speaking: boolean) => void) | null = null;

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

/** Notified whenever playback starts or ends, so capture can follow it. */
export function onPlaybackChange(callback: ((speaking: boolean) => void) | null) {
  onChange = callback;
}

function finish() {
  current = null;
  onChange?.(false);
  onDone?.();
}

/** Speak one reply, replacing anything currently being spoken. */
export function speak(text: string) {
  if (muted || !text.trim() || !('speechSynthesis' in globalThis)) return;
  if (current) speechSynthesis.cancel();   // finish() fires from the old utterance
  pickVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  utterance.onend = finish;
  utterance.onerror = finish;
  current = utterance;
  onChange?.(true);
  speechSynthesis.speak(utterance);
}

export function cancelSpeech() {
  if (!('speechSynthesis' in globalThis)) return;
  current = null;
  speechSynthesis.cancel();
  onChange?.(false);
  onDone?.();
}

export function isSpeaking(): boolean {
  return current !== null;
}
