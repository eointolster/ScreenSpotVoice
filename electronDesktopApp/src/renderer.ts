type DesktopAPI = {
  state: () => Promise<any>; config: (value: unknown) => Promise<any>; start: () => Promise<any>; stop: () => Promise<any>;
  submit: (value: unknown) => Promise<any>; clear: () => Promise<any>; calibrate: () => Promise<any>;
  nudge: (dx: number, dy: number) => Promise<any>; resetAlignment: () => Promise<any>; forgetKey: () => Promise<any>;
  onEvent: (callback: (value: any) => void) => () => void;
  onOverlay: (callback: (value: any) => void) => () => void;
};
declare global { interface Window { screenspot: DesktopAPI } }
export {};

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusText = element<HTMLElement>('status');
const detail = element<HTMLElement>('detail');
const statusDot = element<HTMLElement>('status-dot');
const display = element<HTMLSelectElement>('display');
const captureScope = element<HTMLSelectElement>('capture-scope');
const provider = element<HTMLSelectElement>('provider');
const ollamaModel = element<HTMLInputElement>('ollama-model');
const geminiModel = element<HTMLInputElement>('gemini-model');
const geminiKey = element<HTMLInputElement>('gemini-key');
const rememberKey = element<HTMLInputElement>('remember-key');
let hasKey = false;
let keyStored = false;
const whisperModel = element<HTMLSelectElement>('whisper-model');
const kokoroVoice = element<HTMLSelectElement>('kokoro-voice');
const handsFree = element<HTMLInputElement>('hands-free');
const typed = element<HTMLInputElement>('typed');
const messages = element<HTMLElement>('messages');
const startButton = element<HTMLButtonElement>('start');
const talkButton = element<HTMLButtonElement>('talk');
const muteButton = element<HTMLButtonElement>('mute');
const endButton = element<HTMLButtonElement>('end');
let active = false;
let processing = false;
let muted = false;
let manual = false;
let speaking = false;
let echoGuardUntil = 0;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let micNode: AudioWorkletNode | null = null;
let output: HTMLAudioElement | null = null;
let preRoll: Float32Array[] = [];
let phrase: Float32Array[] = [];
let phraseSamples = 0;
let speechHits = 0;
let silenceSamples = 0;
let noiseFloor = 0.004;
let calibrationUntil = 0;

function setStatus(status: string, description = '') {
  statusText.textContent = status;
  detail.textContent = description;
  statusDot.className = `status-dot${status === 'Error' || status === 'Voice unavailable' ? ' error' : active ? ' live' : ''}`;
}
function clearConversation() {
  messages.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'Questions and replies appear here during the session.';
  messages.append(empty);
  element<HTMLElement>('model-latency').textContent = '';
}
function appendMessage(who: 'user' | 'assistant' | 'note', text: string) {
  messages.querySelector('.empty')?.remove();
  const paragraph = document.createElement('p');
  paragraph.className = `message ${who}`;
  const label = document.createElement('b');
  label.textContent = who === 'user' ? 'You: ' : who === 'assistant' ? 'ScreenSpot: ' : '';
  paragraph.append(label, document.createTextNode(text));
  messages.append(paragraph);
  while (messages.childElementCount > 24) messages.firstElementChild?.remove();
  messages.scrollTop = messages.scrollHeight;
}
function updateKeyState(state: any) {
  hasKey = !!state.hasGeminiKey;
  keyStored = !!state.keyStored;
  rememberKey.disabled = !state.canStoreKey;
  rememberKey.checked = !!state.keyStored && !!state.canStoreKey;
  const status = element<HTMLElement>('key-state');
  status.textContent = state.keyStorageError ? 'Saved key could not be unlocked: ' + state.keyStorageError :
    !state.canStoreKey ? 'No secure desktop key store is available; a new key will last only this session.' :
    state.keyStored && hasKey ? 'Key saved with your desktop key store.' :
    hasKey ? 'Key available until this app quits.' : 'No key entered.';
  element<HTMLButtonElement>('forget-key').hidden = provider.value !== 'gemini' || (!hasKey && !state.keyStored);
}
function updateAlignment(value: { x: number; y: number }) {
  element<HTMLElement>('alignment-state').textContent = 'Box alignment: ' + value.x + ', ' + value.y + ' px';
}
function updateProvider() {
  const gemini = provider.value === 'gemini';
  element<HTMLElement>('local-model-row').hidden = gemini;
  element<HTMLElement>('gemini-model-row').hidden = !gemini;
  element<HTMLElement>('gemini-key-row').hidden = !gemini;
  element<HTMLElement>('remember-key-row').hidden = !gemini;
  element<HTMLButtonElement>('forget-key').hidden = !gemini || (!hasKey && !keyStored);
}
function controls() {
  startButton.disabled = active;
  endButton.disabled = !active;
  talkButton.disabled = !active || muted || processing || speaking;
  muteButton.disabled = !active;
  element<HTMLButtonElement>('calibrate').disabled = !active;
  element<HTMLButtonElement>('clear').disabled = !active;
  element<HTMLButtonElement>('send').disabled = !active || processing;
  talkButton.textContent = manual ? 'Finish question' : 'Talk now';
  muteButton.textContent = muted ? 'Unmute mic' : 'Mute mic';
  display.disabled = active;
  provider.disabled = active;
}
async function saveSettings() {
  const result = await window.screenspot.config({
    displayId: display.value ? Number(display.value) : null, captureScope: captureScope.value,
    provider: provider.value, ollamaModel: ollamaModel.value.trim(), geminiModel: geminiModel.value.trim(),
    geminiKey: geminiKey.value, rememberGeminiKey: rememberKey.checked, whisperModel: whisperModel.value, kokoroVoice: kokoroVoice.value, handsFree: handsFree.checked,
  });
  geminiKey.value = '';
  updateKeyState(result);
  return result;
}
function resetDetection() { preRoll = []; phrase = []; phraseSamples = 0; speechHits = 0; silenceSamples = 0; }
function joinAudio(chunks: Float32Array[], count: number) {
  const result = new Float32Array(count);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  return result;
}
function wavBase64(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const string = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  string(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); string(8, 'WAVE'); string(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  string(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
async function submitAudio() {
  if (!active || processing || !context || phraseSamples < context.sampleRate * 0.3) { resetDetection(); return; }
  const samples = joinAudio(phrase, phraseSamples);
  resetDetection();
  processing = true;
  controls();
  setStatus('Transcribing', 'Whisper is processing your question.');
  try { await window.screenspot.submit({ audio: wavBase64(samples, context.sampleRate) }); }
  catch (error) { processing = false; setStatus('Error', String(error)); controls(); }
}
function onMicChunk(chunk: Float32Array) {
  if (!active || muted || processing || speaking || performance.now() < echoGuardUntil || !context) return;
  const seconds = chunk.length / context.sampleRate;
  let energy = 0;
  for (const sample of chunk) energy += sample * sample;
  const rms = Math.sqrt(energy / chunk.length);
  if (manual) {
    phrase.push(chunk); phraseSamples += chunk.length;
    return;
  }
  if (performance.now() < calibrationUntil) {
    noiseFloor = noiseFloor * 0.8 + rms * 0.2;
    return;
  }
  if (!handsFree.checked) return;
  if (!phrase.length) {
    preRoll.push(chunk);
    while (preRoll.length * seconds > 0.34) preRoll.shift();
    noiseFloor = noiseFloor * 0.985 + Math.min(rms, 0.04) * 0.015;
    speechHits = rms > Math.max(0.024, noiseFloor * 2.5) ? speechHits + 1 : 0;
    if (speechHits >= 6) {
      phrase = [...preRoll];
      phraseSamples = phrase.reduce((sum, part) => sum + part.length, 0);
      silenceSamples = 0;
      setStatus('Hearing you', 'Pause briefly when you finish your question.');
    }
    return;
  }
  phrase.push(chunk); phraseSamples += chunk.length;
  silenceSamples = rms < Math.max(0.014, noiseFloor * 1.7) ? silenceSamples + chunk.length : 0;
  if (silenceSamples / context.sampleRate >= 0.68 || phraseSamples / context.sampleRate >= 16) void submitAudio();
}
async function openMic() {
  stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule('mic-worklet.js');
    const source = context.createMediaStreamSource(stream);
    micNode = new AudioWorkletNode(context, 'screenspot-mic');
    const silentOutput = context.createGain(); silentOutput.gain.value = 0;
    source.connect(micNode).connect(silentOutput).connect(context.destination);
    micNode.port.onmessage = event => onMicChunk(event.data as Float32Array);
    noiseFloor = 0.004;
    calibrationUntil = performance.now() + 1000;
  } catch (error) { await closeMic(); throw error; }
}
async function closeMic() {
  micNode?.disconnect(); micNode = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  await context?.close().catch(() => {}); context = null;
  resetDetection();
}
function stopSpeech() {
  if (output) { output.pause(); output.src = ''; output = null; }
  speaking = false;
  echoGuardUntil = performance.now() + 450;
  controls();
}
async function playSpeech(wav: string) {
  stopSpeech();
  if (!active) return;
  speaking = true;
  controls();
  output = new Audio(`data:audio/wav;base64,${wav}`);
  output.onended = () => { stopSpeech(); if (active) setStatus('Listening', 'Ask another question.'); };
  output.onerror = () => { stopSpeech(); setStatus('Voice unavailable', 'The generated audio could not play.'); };
  try { await output.play(); }
  catch (error) { stopSpeech(); setStatus('Voice unavailable', String(error)); }
}
async function endSession() {
  if (!active) return;
  active = false; processing = false; manual = false; muted = false;
  stopSpeech();
  await closeMic();
  await window.screenspot.stop();
  controls();
  setStatus('Stopped', 'No screen capture or microphone session is active.');
}

window.screenspot.onEvent(message => {
  if (!message) return;
  if (message.kind === 'status') {
    setStatus(message.status || 'Ready', message.detail || '');
    if (message.status === 'Error' || message.status === 'Voice unavailable') { processing = false; controls(); }
  } else if (message.kind === 'user') appendMessage('user', String(message.text || ''));
  else if (message.kind === 'answer') {
    appendMessage('assistant', String(message.text || ''));
    if (message.highlightError) appendMessage('note', `Box: ${message.highlightError}`);
    element<HTMLElement>('model-latency').textContent = typeof message.modelMs === 'number' ? `Model ${message.modelMs} ms` : '';
  } else if (message.kind === 'empty') { processing = false; controls(); }
  else if (message.kind === 'audio') {
    processing = false; controls();
    if (active && typeof message.wav === 'string') void playSpeech(message.wav);
  }
});

provider.addEventListener('change', updateProvider);
element<HTMLButtonElement>('forget-key').addEventListener('click', () => {
  void window.screenspot.forgetKey().then(result => {
    geminiKey.value = '';
    updateKeyState(result);
    setStatus(active ? 'Listening' : 'Ready', 'Gemini key removed from this session and secure storage.');
  }).catch(error => setStatus('Error', String(error)));
});
document.querySelectorAll<HTMLButtonElement>('[data-nudge-x]').forEach(button => {
  button.addEventListener('click', () => {
    void window.screenspot.nudge(Number(button.dataset.nudgeX), Number(button.dataset.nudgeY))
      .then(updateAlignment).catch(error => setStatus('Error', String(error)));
  });
});
element<HTMLButtonElement>('reset-alignment').addEventListener('click', () => {
  void window.screenspot.resetAlignment().then(updateAlignment).catch(error => setStatus('Error', String(error)));
});
element<HTMLButtonElement>('save-settings').addEventListener('click', () => {
  void saveSettings().then(result => setStatus(result.keyStorageError ? 'Error' : active ? 'Listening' : 'Ready', result.keyStorageError || 'Settings saved.')).catch(error => setStatus('Error', String(error)));
});
startButton.addEventListener('click', () => {
  void (async () => {
    try {
      await saveSettings();
      await window.screenspot.start();
      active = true; clearConversation(); controls();
      await openMic();
      if (handsFree.checked) {
        setStatus('Calibrating mic', 'Stay quiet briefly so hands-free detection can learn the room level.');
        setTimeout(() => { if (active && !processing && !manual) setStatus('Listening', 'Ask a question and pause to send it.'); }, 1050);
      } else {
        setStatus('Listening', 'Click Talk now to record a question.');
      }
    } catch (error) {
      if (active) await endSession().catch(() => {});
      setStatus('Error', String(error instanceof Error ? error.message : error));
    }
  })();
});
endButton.addEventListener('click', () => { void endSession().catch(error => setStatus('Error', String(error))); });
muteButton.addEventListener('click', () => {
  muted = !muted;
  stream?.getAudioTracks().forEach(track => track.enabled = !muted);
  resetDetection(); controls();
  setStatus(muted ? 'Muted' : 'Listening', muted ? 'Microphone audio is withheld.' : 'Microphone ready.');
});
talkButton.addEventListener('click', () => {
  if (!active || muted || processing || speaking) return;
  if (manual) { manual = false; void submitAudio(); }
  else { manual = true; phrase = [...preRoll]; phraseSamples = phrase.reduce((sum, part) => sum + part.length, 0); setStatus('Recording', 'Click Finish question when you are done.'); }
  controls();
});
element<HTMLButtonElement>('clear').addEventListener('click', () => { void window.screenspot.clear(); });
element<HTMLButtonElement>('calibrate').addEventListener('click', () => { void window.screenspot.calibrate().catch(error => setStatus('Error', String(error))); });
element<HTMLFormElement>('typed-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = typed.value.trim();
  if (!active || !text || processing) return;
  typed.value = '';
  stopSpeech(); resetDetection();
  processing = true; controls();
  void window.screenspot.submit({ text }).catch(error => { processing = false; controls(); setStatus('Error', String(error)); });
});

void window.screenspot.state().then(state => {
  const prefs = state.preferences;
  for (const item of state.displays || []) {
    const option = document.createElement('option'); option.value = String(item.id);
    option.textContent = `${item.name} · ${item.width}×${item.height}`;
    display.append(option);
  }
  display.value = String(prefs.displayId ?? state.displays?.[0]?.id ?? '');
  captureScope.value = prefs.captureScope || 'window';
  updateAlignment({ x: prefs.boxOffsetX || 0, y: prefs.boxOffsetY || 0 });
  provider.value = prefs.provider; ollamaModel.value = prefs.ollamaModel; geminiModel.value = prefs.geminiModel;
  whisperModel.value = prefs.whisperModel; kokoroVoice.value = prefs.kokoroVoice; handsFree.checked = prefs.handsFree;
  updateKeyState(state);
  element<HTMLElement>('setup-hint').hidden = !!state.pythonReady;
  updateProvider(); controls();
}).catch(error => setStatus('Error', String(error)));
