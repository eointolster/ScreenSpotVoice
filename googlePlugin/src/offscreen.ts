import type { View } from './contracts';

type Active = { id: string; tabId: number; title: string; view: View; ws: WebSocket; pc: RTCPeerConnection; screen: MediaStream; mic: MediaStream; screenSender: RTCRtpSender; micSender: RTCRtpSender; audio: HTMLAudioElement; remoteTrack: MediaStreamTrack | null; paused: boolean; muted: boolean; model: string; diagnostics: Record<string, unknown>; transcript: string[]; meter: AudioContext | null; interval: number | null; statusInterval: number | null; lastSpeech: number; speaking: boolean; status: string };
let active: Active | null = null;
function inform(status: string, detail = '') {
  if (!active) return;
  active.status = status;
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATUS', sessionId: active.id, status, connected: active.pc.connectionState === 'connected', model: active.model, detail, diagnostics: { ...active.diagnostics, rtc: active.pc.connectionState, screen: active.screen.getVideoTracks()[0]?.readyState, mic: active.mic.getAudioTracks()[0]?.readyState }, transcript: active.transcript.slice(-12) }).catch(() => {});
}
function send(value: unknown) { if (active?.ws.readyState === WebSocket.OPEN) active.ws.send(JSON.stringify(value)); }
function stop() {
  if (!active) return;
  const old = active; active = null;
  if (old.interval) clearInterval(old.interval);
  if (old.statusInterval) clearInterval(old.statusInterval);
  old.audio.pause(); old.audio.srcObject = null; old.audio.remove();
  old.meter?.close().catch(() => {});
  old.screen.getTracks().forEach(t => t.stop()); old.mic.getTracks().forEach(t => t.stop());
  old.pc.close(); old.ws.close(); old.transcript.length = 0;
}
async function pause() {
  if (!active) return;
  const item = active; item.paused = true;
  item.screen.getTracks().forEach(t => t.enabled = false);
  item.mic.getTracks().forEach(t => t.enabled = false);
  item.audio.pause(); item.audio.muted = true;
  await Promise.all([item.screenSender.replaceTrack(null), item.micSender.replaceTrack(null)]);
  if (active === item) { send({ type: 'pause' }); inform('Paused', 'Media withheld until explicit resume.'); }
}
async function resume(view: View) {
  if (!active) return;
  const item = active; item.view = view;
  item.screen.getTracks().forEach(t => t.enabled = true);
  item.mic.getTracks().forEach(t => t.enabled = !item.muted);
  await Promise.all([item.screenSender.replaceTrack(item.screen.getVideoTracks()[0]), item.micSender.replaceTrack(item.mic.getAudioTracks()[0])]);
  if (active === item) { item.paused = false; send({ type: 'resume', view }); inform('Listening'); }
}
function resetPlayback() {
  if (!active) return;
  active.audio.pause(); active.audio.srcObject = null; active.audio.muted = true;
}
async function playFresh() {
  if (!active || active.paused || !active.remoteTrack) return;
  active.audio.pause(); active.audio.srcObject = null;
  active.audio.srcObject = new MediaStream([active.remoteTrack]);
  active.audio.muted = false;
  try { await active.audio.play(); } catch (error) { inform('Error', `Audio playback blocked: ${String(error)}`); }
}
async function onServer(message: any) {
  if (!active || !message || typeof message.type !== 'string') return;
  if (message.type === 'hello') { active.model = message.model || ''; active.diagnostics.mode = message.mode; inform(message.mode === 'calibration' ? 'Ready' : 'Connecting', message.mode === 'calibration' ? 'No API key: transport and overlay calibration only.' : 'Connecting to Gemini Live.'); }
  else if (message.type === 'answer' && typeof message.sdp === 'string') { await active.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp }); }
  else if (message.type === 'ice' && message.candidate) { await active.pc.addIceCandidate(message.candidate).catch(() => {}); }
  else if (message.type === 'status') {
    active.diagnostics = { ...active.diagnostics, ...(message.diagnostics || {}) };
    if (typeof message.text === 'string' && message.text) active.transcript.push(message.text.slice(0, 500));
    inform(message.status || 'Listening', message.detail || '');
  } else if (message.type === 'response_start') { await playFresh(); inform('Responding'); }
  else if (message.type === 'interrupted') { resetPlayback(); inform('Listening', 'Previous response interrupted.'); }
  else if (message.type === 'overlay') {
    const reply = await chrome.runtime.sendMessage({ ...message, type: 'OFFSCREEN_OVERLAY', sessionId: active.id }).catch(error => ({ ok: false, reason: String(error) }));
    send({ type: 'overlay_result', id: message.id, ok: !!reply?.ok, reason: reply?.reason || '', view: reply?.view });
  }
}
function startMeter(item: Active) {
  try {
    const context = new AudioContext(); const source = context.createMediaStreamSource(item.mic);
    const analyser = context.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
    item.meter = context;
    const data = new Float32Array(analyser.fftSize);
    let hits = 0;
    item.interval = setInterval(() => {
      if (!active || active !== item || item.paused || item.muted) return;
      analyser.getFloatTimeDomainData(data);
      let power = 0; for (const sample of data) power += sample * sample;
      const audible = Math.sqrt(power / data.length) > 0.04;
      hits = audible ? hits + 1 : 0;
      if (audible) item.lastSpeech = performance.now();
      if (hits >= 4 && !item.speaking) {
        item.speaking = true;
        send({ type: 'turn_start' });
      }
      if (performance.now() - item.lastSpeech > 550) { item.speaking = false; hits = 0; }
    }, 50) as unknown as number;
  } catch { /* Gemini VAD still handles turns if the local indicator is unavailable. */ }
}
async function start(message: { sessionId: string; tabId: number; title: string; streamId: string; token: string; port: number; view: View }) {
  stop();
  // Match the tab viewport when Chrome chooses a capture resolution. Some
  // configurations otherwise pad a narrow tab into a wide desktop-sized frame.
  const minWidth = Math.min(3840, Math.max(1, message.view.width));
  const minHeight = Math.min(2160, Math.max(1, message.view.height));
  const screen = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, minWidth, minHeight
  } } as MediaTrackConstraints });
  let mic: MediaStream;
  try { mic = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (error) { screen.getTracks().forEach(t => t.stop()); throw new Error(`Microphone unavailable. Allow microphone access for this extension in Chrome. ${String(error)}`); }
  const ws = new WebSocket(`ws://127.0.0.1:${message.port}/ws`);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('aria-hidden', 'true'); document.body.append(audio);
  const screenSender = pc.addTrack(screen.getVideoTracks()[0], screen);
  const micSender = pc.addTrack(mic.getAudioTracks()[0], mic);
  const item: Active = { id: message.sessionId, tabId: message.tabId, title: message.title, view: message.view, ws, pc, screen, mic, screenSender, micSender, audio, remoteTrack: null, paused: false, muted: false, model: '', diagnostics: { captureRequestedMinSize: `${minWidth}×${minHeight}`,
    captureTrackSize: `${screen.getVideoTracks()[0].getSettings().width ?? '?'}×${screen.getVideoTracks()[0].getSettings().height ?? '?'}` }, transcript: [], meter: null, interval: null, statusInterval: null, lastSpeech: 0, speaking: false, status: 'Connecting' };
  active = item;
  screen.getVideoTracks()[0].onended = () => { inform('Disconnected', 'Tab capture ended.'); stop(); };
  mic.getAudioTracks()[0].onended = () => { void pause().finally(() => inform('Needs permission', 'Microphone ended.')); };
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.ontrack = event => { if (event.track.kind === 'audio') item.remoteTrack = event.track; };
  pc.onconnectionstatechange = () => inform(pc.connectionState === 'connected' ? 'Listening' : pc.connectionState === 'failed' ? 'Disconnected' : 'Connecting');
  pc.onicecandidate = event => { if (event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() }); };
  ws.onmessage = event => { try { void onServer(JSON.parse(event.data)).catch(error => inform('Error', String(error))); } catch { inform('Error', 'Invalid backend message.'); } };
  ws.onclose = () => { if (active === item) void pause().finally(() => inform('Disconnected', 'Backend connection closed. End this session and start again.')); };
  ws.onerror = () => inform('Error', 'Cannot reach local backend.');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend connection timed out.')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Backend connection failed. Start the local backend and check its port.')); }, { once: true });
  }).catch(error => { stop(); throw error; });
  send({ type: 'hello', token: message.token, session_id: item.id, source_id: crypto.randomUUID(), view: message.view });
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: offer.sdp });
  startMeter(item);
  item.statusInterval = setInterval(async () => {
    if (active !== item) return;
    const stats = await pc.getStats();
    let sentAudio = 0, sentVideo = 0, receivedAudio = 0;
    stats.forEach(s => { if (s.type === 'outbound-rtp' && s.kind === 'audio') sentAudio = s.bytesSent || 0; if (s.type === 'outbound-rtp' && s.kind === 'video') sentVideo = s.bytesSent || 0; if (s.type === 'inbound-rtp' && s.kind === 'audio') receivedAudio = s.bytesReceived || 0; });
    item.diagnostics = { ...item.diagnostics, sentAudioBytes: sentAudio, sentVideoBytes: sentVideo, receivedAudioBytes: receivedAudio };
    inform(item.paused ? 'Paused' : item.status);
  }, 2000) as unknown as number;
  inform('Connecting');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url === chrome.runtime.getURL('offscreen.html')) return;
  const idMatch = active && message?.sessionId === active.id;
  if (message?.type === 'OFFSCREEN_QUERY') { respond(active ? { ok: true, session: { id: active.id, tabId: active.tabId, title: active.title, view: active.view, paused: active.paused, muted: active.muted, model: active.model, diagnostics: active.diagnostics, transcript: active.transcript } } : { ok: true, session: null }); return; }
  if (message?.type === 'OFFSCREEN_START') { void start(message).then(() => respond({ ok: true })).catch(error => respond({ ok: false, reason: String(error?.message || error) })); return true; }
  if (message?.type === 'OFFSCREEN_STOP' && idMatch) { send({ type: 'end' }); stop(); respond({ ok: true }); }
  if (message?.type === 'OFFSCREEN_PAUSE' && idMatch) { void pause().then(() => respond({ ok: true })).catch(error => respond({ ok: false, reason: String(error) })); return true; }
  if (message?.type === 'OFFSCREEN_RESUME' && idMatch) { void resume(message.view).then(() => respond({ ok: true })).catch(error => respond({ ok: false, reason: String(error) })); return true; }
  if (message?.type === 'OFFSCREEN_MUTE' && idMatch) { active!.muted = !!message.muted; active!.mic.getAudioTracks()[0].enabled = !active!.muted && !active!.paused; send({ type: 'mute', muted: active!.muted }); respond({ ok: true }); }
  if (message?.type === 'OFFSCREEN_VIEW' && idMatch) { active!.view = message.view; send({ type: 'view', view: message.view, reason: message.reason }); respond({ ok: true }); }
  if (message?.type === 'OFFSCREEN_USER_CLEAR' && idMatch) { send({ type: 'clear' }); respond({ ok: true }); }
  if (message?.type === 'OFFSCREEN_TEXT' && idMatch) { send({ type: 'text', text: message.text }); respond({ ok: true }); }
});
