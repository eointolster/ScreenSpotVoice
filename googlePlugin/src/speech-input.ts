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
  onState: (state: 'starting' | 'listening' | 'unavailable' | 'error', detail?: string) => void;
};

const Ctor: (new () => SpeechRecognitionLike) | undefined =
  (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;

let recognition: SpeechRecognitionLike | null = null;
let wanted = false;
let listener: Listener | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveErrors = 0;

/** Local turn-taking uses these instead of server-side VAD. */
let assistantBusy = false;
let onAssistantDone: (() => void) | null = null;

export function setListener(next: Listener | null) {
  listener = next;
}

export function setAssistantBusy(busy: boolean, done?: () => void) {
  assistantBusy = busy;
  onAssistantDone = done ?? null;
}

function clearRestart() {
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

export function sttSupported(): boolean {
  return typeof Ctor === 'function';
}

export function startListening() {
  wanted = true;
  consecutiveErrors = 0;
  if (!Ctor) {
    listener?.onState('unavailable', 'This browser has no SpeechRecognition support.');
    return;
  }
  // A second start() while running throws; guard it.
  if (recognition) return;
  spin();
}

function spin() {
  if (!wanted || !Ctor || !listener) return;
  clearRestart();
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
          // Speaking over the assistant cancels its reply: this is the local
          // equivalent of Gemini's server-side barge-in.
          if (assistantBusy) {
            onAssistantDone?.();
            setAssistantBusy(false);
          }
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
    if (!wanted) return;
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
  clearRestart();
  setAssistantBusy(false);
  if (recognition) {
    recognition.onend = null;
    try { recognition.abort(); } catch { /* already stopped */ }
    recognition = null;
  }
  listener?.onState('listening', undefined);
}
