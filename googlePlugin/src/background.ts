import { emptyState, validBox, type PanelState, type View, type OverlayRequest } from './contracts';
import { lifecycleAction } from './lifecycle';

type Session = { id: string; tabId: number; title: string; view: View | null; paused: boolean; muted: boolean };
let session: Session | null = null;
let state: PanelState = emptyState();
let creating: Promise<void> | null = null;
let calibrationTabId: number | null = null;
let pendingStart: { message: { tabId: number; title: string; token: string; port: number }; expires: number } | null = null;
const broadcast = () => chrome.runtime.sendMessage({ type: 'STATE', state }).catch(() => {});
const update = (patch: Partial<PanelState>) => { state = { ...state, ...patch }; void chrome.action.setBadgeText({ text: state.tabId === null ? '' : state.paused ? 'PAUSE' : 'LIVE' }); void chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#8c5f22' : '#0b8f79' }); broadcast(); };
const fromOffscreen = (sender: chrome.runtime.MessageSender) => sender.url === chrome.runtime.getURL('offscreen.html');
const fromPanel = (sender: chrome.runtime.MessageSender) => sender.url === chrome.runtime.getURL('panel.html');
const fromContent = (sender: chrome.runtime.MessageSender) => sender.tab?.id === session?.tabId;
async function hydrate() {
  if (session) return;
  const exists = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [chrome.runtime.getURL('offscreen.html')] }).then(x => x.length > 0);
  if (!exists) return;
  const result = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_QUERY' }).catch(() => null);
  if (!result?.session) return;
  const item = result.session;
  session = { id: item.id, tabId: item.tabId, title: item.title, view: item.view, paused: item.paused, muted: item.muted };
  update({ status: item.paused ? 'Paused' : 'Listening', tabId: item.tabId, tabTitle: item.title, paused: item.paused, muted: item.muted, model: item.model, diagnostics: item.diagnostics, transcript: item.transcript || [] });
}
async function ensureOffscreen() {
  if (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [chrome.runtime.getURL('offscreen.html')] }).then(x => x.length > 0)) return;
  if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'WEB_RTC', 'AUDIO_PLAYBACK'], justification: 'Capture the authorized tab and microphone, maintain WebRTC and play assistant audio.' }).finally(() => { creating = null; });
  await creating;
}
async function sendOffscreen(message: unknown) { await ensureOffscreen(); return chrome.runtime.sendMessage(message); }
async function prepareContent(tabId: number) {
  let response = await chrome.tabs.sendMessage(tabId, { kind: 'VIEW' }).catch(() => null);
  if (!response?.ok) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    response = await chrome.tabs.sendMessage(tabId, { kind: 'VIEW' });
  }
  if (!response?.ok || !response.view) throw new Error('This page cannot display highlights.');
  return response.view as View;
}
async function clearOverlay() {
  const tabId = session?.tabId ?? calibrationTabId;
  if (tabId != null) await chrome.tabs.sendMessage(tabId, { kind: 'CLEAR', id: crypto.randomUUID() } satisfies OverlayRequest).catch(() => {});
  calibrationTabId = null;
}
async function end(reason = 'Ended') {
  pendingStart = null;
  await clearOverlay();
  if (session) await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', sessionId: session.id }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  session = null;
  update({ status: reason, tabId: null, tabTitle: '', paused: false, muted: false, connected: false, model: '', detail: '', diagnostics: {}, transcript: [] });
}
async function pause(reason: string) {
  if (!session || session.paused) return;
  session.paused = true;
  await clearOverlay();
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PAUSE', sessionId: session.id }).catch(() => {});
  update({ status: 'Paused', paused: true, detail: reason });
}
async function begin(message: { tabId: number; title: string; token: string; port: number }) {
  await hydrate();
  pendingStart = null;
  await clearOverlay();
  if (session) await end('Ready');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id || active.id !== message.tabId || !/^https?:\/\//.test(active.url || '')) throw new Error('Open a normal website, then click the extension toolbar icon on that tab.');
  if (!message.token || message.token.length < 16 || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw new Error('Enter the backend pairing code and valid port.');
  await prepareContent(active.id);
  await ensureOffscreen();
  // The user's Start click may lack a tabCapture invocation in some Chrome builds.
  // In that case arm a second, explicit toolbar click and obtain the ID synchronously in action.onClicked.
  try {
    const streamId = await captureId(active.id);
    await finishBegin(message, streamId);
  } catch (error) {
    const detail = String((error as Error).message || error);
    if (!detail.includes('not been invoked') && !detail.includes('activeTab')) throw error;
    pendingStart = { message, expires: Date.now() + 30000 };
    update({ status: 'Needs permission', detail: 'Click the extension toolbar icon again on this tab to authorize capture (within 30 seconds).', tabId: null, tabTitle: '', paused: false });
    await chrome.action.setBadgeText({ text: 'CLICK' });
    // Chrome may treat clicking an icon while its panel is open as a close, not a new action invocation.
    // Close deliberately before the second click; there is no recording yet.
    await (chrome.sidePanel as unknown as { close: (options: { windowId: number }) => Promise<void> }).close({ windowId: active.windowId }).catch(() => {});
  }
}
function captureId(tabId: number): Promise<string> {
  return (chrome.tabCapture.getMediaStreamId as unknown as (options: { targetTabId: number }) => Promise<string>)({ targetTabId: tabId });
}
async function finishBegin(message: { tabId: number; title: string; token: string; port: number }, streamId: string) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== message.tabId) throw new Error('Return to the authorized tab.');
  const response = await chrome.tabs.sendMessage(active.id, { kind: 'VIEW' });
  if (!response?.ok) throw new Error('Page changed; start again.');
  const id = crypto.randomUUID();
  session = { id, tabId: active.id, title: (active.title || message.title || 'Shared tab').slice(0, 120), view: response.view, paused: false, muted: false };
  pendingStart = null;
  update({ status: 'Connecting', tabId: active.id, tabTitle: session.title, paused: false, detail: '' });
  try {
    const result = await sendOffscreen({ type: 'OFFSCREEN_START', sessionId: id, tabId: active.id, title: session.title, streamId, token: message.token, port: message.port, view: response.view });
    if (!result?.ok) throw new Error(result?.reason || 'Media startup failed');
  } catch (error) { await end('Error'); throw error; }
}
async function resume() {
  await hydrate();
  if (!session || !session.paused) throw new Error('No paused session.');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== session.tabId) throw new Error('Return to the shared tab to resume.');
  const response = await chrome.tabs.sendMessage(session.tabId, { kind: 'VIEW' });
  if (!response?.ok) throw new Error('Page changed. End and click the toolbar icon again to authorize it.');
  session.view = response.view;
  session.paused = false;
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESUME', sessionId: session.id, view: session.view });
  update({ status: 'Listening', paused: false, detail: '' });
}
async function handleOverlay(message: { sessionId: string; id: string; kind: string; box?: unknown; label?: string; view?: View; image?: { width: number; height: number } }) {
  await hydrate();
  if (!session || session.id !== message.sessionId || session.paused) return { ok: false, reason: 'session inactive' };
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== session.tabId) return { ok: false, reason: 'shared tab not active' };
  if (message.kind === 'CLEAR') {
    const result = await chrome.tabs.sendMessage(session.tabId, { kind: 'CLEAR', id: message.id });
    if (result?.view) session.view = result.view;
    return result;
  }
  if (message.kind !== 'SHOW' || !validBox(message.box) || !message.view || !session.view || !message.image) return { ok: false, reason: 'invalid highlight' };
  if (JSON.stringify(message.view) !== JSON.stringify(session.view)) return { ok: false, reason: 'view changed' };
  const result = await chrome.tabs.sendMessage(session.tabId, { kind: 'SHOW', id: message.id, box: message.box, label: message.label || '', view: message.view, image: message.image } satisfies OverlayRequest);
  return result;
}
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener(tab => {
  const pending = pendingStart;
  if (pending && Date.now() >= pending.expires) { pendingStart = null; update({ status: 'Ready', detail: 'Authorization timed out. Click Start again.' }); }
  if (pending && tab.id === pending.message.tabId && Date.now() < pending.expires) {
    pendingStart = null;
    void chrome.action.setBadgeText({ text: '' });
    // Call before any await: Chrome ties tab capture to this action invocation.
    const stream = captureId(tab.id);
    void stream.then(id => finishBegin(pending.message, id)).catch(error => update({ status: 'Needs permission', detail: String(error?.message || error) }));
  }
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});
(chrome.sidePanel as unknown as { onClosed: { addListener: (fn: () => void) => void } }).onClosed.addListener(() => {
  // The capture fallback deliberately closes the panel before the second toolbar click.
  if (pendingStart) return;
  void hydrate().then(() => {
    if (session) void end('Ended when side panel closed');
    else if (calibrationTabId !== null) void clearOverlay();
  });
});
chrome.tabs.onActivated.addListener(({ tabId }) => { void hydrate().then(() => { if (calibrationTabId !== null && tabId !== calibrationTabId) void clearOverlay(); if (pendingStart && tabId !== pendingStart.message.tabId) { pendingStart = null; update({ status: 'Ready', detail: 'Tab changed. Click Start again on the desired tab.' }); } if (session && lifecycleAction(session.tabId, { kind: 'activated', tabId }) === 'pause') return pause('Switched away from shared tab. Return and click Resume.'); }); });
chrome.tabs.onRemoved.addListener(tabId => { void hydrate().then(() => { if (calibrationTabId === tabId) void clearOverlay(); if (pendingStart?.message.tabId === tabId) pendingStart = null; if (session && lifecycleAction(session.tabId, { kind: 'removed', tabId }) === 'end') return end('Shared tab closed'); }); });
chrome.tabs.onUpdated.addListener((tabId, info) => { void hydrate().then(() => { if (calibrationTabId === tabId && (info.status === 'loading' || info.url)) void clearOverlay(); if (pendingStart?.message.tabId === tabId && (info.status === 'loading' || info.url)) pendingStart = null; if (session && lifecycleAction(session.tabId, { kind: 'updated', tabId, loading: info.status === 'loading', urlChanged: !!info.url }) === 'end') return end('Page changed. Click toolbar icon to authorize again.'); }); });
chrome.tabs.onZoomChange.addListener(({ tabId }) => { void hydrate().then(() => { if (session && lifecycleAction(session.tabId, { kind: 'zoom', tabId }) === 'pause') return pause('Browser zoom changed. Click Resume after checking the page.'); }); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.tab?.id && message?.type === 'VIEW') {
    void hydrate().then(() => {
      if (!fromContent(sender) || !session) return;
      session.view = message.view;
      if (message.reason !== 'ready') { void clearOverlay(); void chrome.runtime.sendMessage({ type: 'OFFSCREEN_VIEW', sessionId: session.id, view: message.view, reason: message.reason }).catch(() => {}); }
    });
    return;
  }
  if (fromOffscreen(sender)) {
    if (message?.type === 'OFFSCREEN_STATUS') {
      void hydrate().then(() => { if (session?.id === message.sessionId) update({ status: message.status, connected: !!message.connected, model: message.model || '', detail: message.detail || '', diagnostics: message.diagnostics || {}, transcript: message.transcript || state.transcript }); }); return;
    }
    if (message?.type === 'OFFSCREEN_OVERLAY') { void handleOverlay(message).then(respond).catch(error => respond({ ok: false, reason: String(error) })); return true; }
  }
  if (!fromPanel(sender)) return;
  const run = async () => {
    await hydrate();
    switch (message?.type) {
      case 'GET_STATE': return state;
      case 'BEGIN': await begin(message); return state;
      case 'END': await end(); return state;
      case 'RESUME': await resume(); return state;
      case 'MUTE': if (session) { session.muted = !!message.muted; await chrome.runtime.sendMessage({ type: 'OFFSCREEN_MUTE', sessionId: session.id, muted: session.muted }); update({ muted: session.muted }); } return state;
      case 'CLEAR':
        if (session) { await clearOverlay(); await chrome.runtime.sendMessage({ type: 'OFFSCREEN_USER_CLEAR', sessionId: session.id }); }
        else { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id) await chrome.tabs.sendMessage(tab.id, { kind: 'CLEAR', id: crypto.randomUUID() }).catch(() => {}); }
        return state;
      case 'TEXT': if (session && !session.paused && typeof message.text === 'string' && message.text.length <= 500) await chrome.runtime.sendMessage({ type: 'OFFSCREEN_TEXT', sessionId: session.id, text: message.text }); return state;
      case 'CALIBRATE': {
        if (session?.view) return handleOverlay({ sessionId: session.id, id: crypto.randomUUID(), kind: 'SHOW', box: [250, 250, 520, 700], view: session.view, image: { width: session.view.width, height: session.view.height } });
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a regular webpage and click the toolbar icon first.');
        const view = await prepareContent(tab.id);
        calibrationTabId = tab.id;
        return chrome.tabs.sendMessage(tab.id, { kind: 'SHOW', id: crypto.randomUUID(), box: [250, 250, 520, 700], label: 'Calibration', view, image: { width: view.width, height: view.height } } satisfies OverlayRequest);
      }
      default: throw new Error('Unknown command');
    }
  };
  void run().then(value => respond({ ok: true, value })).catch(error => respond({ ok: false, reason: String(error?.message || error) }));
  return true;
});
