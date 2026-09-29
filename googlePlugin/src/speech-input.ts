/**
 * Chrome Web Speech recognition, used on the local (non-Gemini) path.
 *
 * Chrome sends microphone audio to a Google speech service; only the resulting
 * text is forwarded to the local backend, so screenshots never leave the
 * machine. This module is therefore *not* privacy-equivalent to the Gemini
 * path for audio - it is privacy-equivalent for images.
 *
 * Auto-restarts are intentional: Chrome ends a recognition session on silence,
 * and without a restart the mic would silently die after the first pause.
 */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

type Listener = {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onState: (state: 'starting' | 'listening' | 'suspended' | 'unavailable' | 'error', detail?: string) => void;
};

const Ctor: (new () => SpeechRecognitionLike) | undefined =
  (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;

let recognition: SpeechRecognitionLike | null = null;
let wanted = false;
let listener: Listener | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveErrors = 0;

// --- Echo suppression -------------------------------------------------------
// The assistant's reply is spoken aloud on the same machine that is listening,
// so the microphone hears it back. Chrome's recogniser captures independently
// of our WebRTC track, so disabling that track does not help: recognition has
// to actually stop while we speak.
let assistantBusy = false;
/** Set when the assistant is speaking, cleared a moment after it stops. */
let echoGuardUntil = 0;
/** What the assistant last said, used to catch audio still in the room. */
let lastSpoken = '';
/** Consecutive dropped echoes; guards against a runaway loop if the guard fails. */
let echoStreak = 0;
let onEchoLoop: (() => void) | null = null;

const ECHO_SETTLE_MS = 400;
const ECHO_LOOP_LIMIT = 4;

function clearTimers() {
  if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
  if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
}

export function setListener(next: Listener | null) {
  listener = next;
}

export function onEchoLoopDetected(callback: (() => void) | null) {
  onEchoLoop = callback;
}

/** Record what the assistant is about to say, so its echo can be recognised. */
export function noteAssistantSaid(text: string) {
  lastSpoken = normalize(text);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when `text` looks like the assistant hearing itself.
 *
 * Token overlap is the reliable signal: genuine new questions rarely reuse most
 * of the assistant's wording, while a mistranscribed echo usually does.
 */
export function looksLikeEcho(text: string): boolean {
  if (assistantBusy) return true;
  if (Date.now() < echoGuardUntil) return true;
  const heard = normalize(text);
  if (!heard || !lastSpoken) return false;
  const spokenTokens = new Set(lastSpoken.split(' ').filter(Boolean));
  const heardTokens = heard.split(' ').filter(Boolean);
  if (!heardTokens.length) return false;
  const shared = heardTokens.filter(token => spokenTokens.has(token)).length;
  return shared / heardTokens.length >= 0.6;
}

/** Called when the assistant starts or finishes speaking. */
export function setAssistantBusy(busy: boolean) {
  if (busy === assistantBusy) return;
  assistantBusy = busy;
  if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
  if (busy) {
    // Stop capturing for the whole spoken reply.
    hardStop();
    listener?.onState('suspended');
    return;
  }
  // The room still rings after playback stops, so wait before listening again.
  echoGuardUntil = Date.now() + ECHO_SETTLE_MS;
  if (wanted) {
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!wanted || assistantBusy) return;
      spin();
    }, ECHO_SETTLE_MS);
  }
}

export function sttSupported(): boolean {
  return typeof Ctor === 'function';
}

export function startListening() {
  wanted = true;
  consecutiveErrors = 0;
  echoStreak = 0;
  if (!Ctor) {
    listener?.onState('unavailable', 'This browser has no SpeechRecognition support.');
    return;
  }
  if (assistantBusy) return;          // resumed by setAssistantBusy(false)
  if (recognition) return;            // a second start() while running throws
  spin();
}

/** Abort the current recognition session without clearing `wanted`. */
function hardStop() {
  clearTimers();
  if (recognition) {
    recognition.onend = null;
    try { recognition.abort(); } catch { /* already stopped */ }
    recognition = null;
  }
}

function spin() {
  if (!wanted || !Ctor || !listener || assistantBusy) return;
  clearTimers();
  let session: SpeechRecognitionLike;
  try {
    session = new Ctor();
  } catch (error) {
    listener.onState('error', `Could not start recognition: ${String(error)}`);
    return;
  }
  recognition = session;
  session.lang = 'en-US';
  session.continuous = true;
  session.interimResults = true;
  session.maxAlternatives = 1;

  session.onresult = event => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        const text = transcript.trim();
        if (text) {
          consecutiveErrors = 0;
          if (looksLikeEcho(text)) {
            // Our own voice, not the user. Dropping it is what stops the loop.
            echoStreak += 1;
            if (echoStreak >= ECHO_LOOP_LIMIT) {
              echoStreak = 0;
              lastSpoken = '';
              onEchoLoop?.();
            }
            continue;
          }
          echoStreak = 0;
          lastSpoken = '';             // a real question clears the reference
          listener?.onFinal(text);
        }
      } else {
        interim += transcript;
      }
    }
    if (interim.trim()) listener?.onInterim(interim.trim());
  };

  session.onerror = (event: any) => {
    const code = event?.error ?? 'unknown';
    // 'no-speech' and 'aborted' are routine; they resolve via onend.
    if (code !== 'no-speech' && code !== 'aborted') {
      consecutiveErrors += 1;
      listener?.onState('error', `Speech recognition error: ${code}`);
    }
  };

  session.onend = () => {
    recognition = null;
    if (!wanted || assistantBusy) return;
    if (consecutiveErrors >= 5) {
      listener?.onState('error', 'Speech recognition keeps failing; use typed messages instead.');
      return;
    }
    listener?.onState('listening');
    restartTimer = setTimeout(spin, 250);
  };

  try {
    session.start();
    listener.onState('starting');
  } catch (error) {
    recognition = null;
    listener.onState('error', `Could not start recognition: ${String(error)}`);
  }
}

export function stopListening() {
  wanted = false;
  clearTimers();
  assistantBusy = false;
  echoGuardUntil = 0;
  lastSpoken = '';
  echoStreak = 0;
  hardStop();
  listener?.onState('listening', undefined);
}
