import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, screen, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { PythonBridge } from './bridge';
import { mapBox, placeOverlay, shiftRect, validBox, type Box } from './geometry';
import { parseActiveWindowId, parseWindowBounds, windowRegion, type Rect } from './capture-region';
import { canStoreKey, forgetStoredKey, loadStoredKey, storeKey } from './secure-key';
import { reconcileAnswer } from './response';

type Provider = 'local' | 'gemini';
type Preferences = { provider: Provider; ollamaModel: string; geminiModel: string; whisperModel: string; kokoroVoice: string; displayId: number | null; handsFree: boolean; captureScope: 'window' | 'display'; boxOffsetX: number; boxOffsetY: number; modelDefaultsVersion: number };
const defaults: Preferences = { provider: 'local', ollamaModel: 'qwen3.8:27b', geminiModel: 'gemini-3.5-flash', whisperModel: 'base.en', kokoroVoice: 'af_heart', displayId: null, handsFree: false, captureScope: 'window', boxOffsetX: 0, boxOffsetY: 0, modelDefaultsVersion: 3 };
const projectRoot = app.getAppPath();
const bridge = new PythonBridge(projectRoot);
let preferences: Preferences = { ...defaults };
let geminiKey = '';
let keyStorageError = '';
type HistoryTurn = { user: string; assistant: string };
let history: HistoryTurn[] = [];
let lastHighlight: { box: Box; image: { width: number; height: number }; region: Rect; label: string } | null = null;
let control: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let activeDisplayId: number | null = null;
let sessionGeneration = 0;
let busy = false;
let highlightTimer: NodeJS.Timeout | null = null;

function settingsFile() { return join(app.getPath('userData'), 'preferences.json'); }
function keyFile() { return join(app.getPath('userData'), 'gemini-key.bin'); }
function loadPreferences() {
  try {
    const stored = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    preferences = { ...defaults, ...stored };
    if (preferences.geminiModel === 'gemini-2.5-flash' ||
        (stored.modelDefaultsVersion !== 3 && preferences.geminiModel === 'gemini-3.5-flash-lite') ||
        (stored.modelDefaultsVersion == null && preferences.geminiModel === 'gemini-3.8-flash')) {
      preferences.geminiModel = defaults.geminiModel;
    }
    if (stored.modelDefaultsVersion !== 3) {
      preferences.modelDefaultsVersion = 3;
      savePreferences();
    }
  } catch { preferences = { ...defaults }; }
}
function savePreferences() {
  // The Gemini key is encrypted separately and never enters this file.
  mkdirSync(dirname(settingsFile()), { recursive: true, mode: 0o700 });
  writeFileSync(settingsFile(), JSON.stringify(preferences, null, 2), { mode: 0o600 });
}
function loadKey() {
  try { geminiKey = loadStoredKey(safeStorage, keyFile()); }
  catch (error) { keyStorageError = String(error instanceof Error ? error.message : error); }
}
function keyState() {
  return {
    hasGeminiKey: !!geminiKey,
    keyStored: existsSync(keyFile()),
    canStoreKey: canStoreKey(safeStorage),
    keyStorageError,
  };
}
function event(kind: string, data: Record<string, unknown> = {}) {
  if (control && !control.isDestroyed()) control.webContents.send('screenspot:event', { kind, ...data });
}
function displays() {
  return screen.getAllDisplays().map(display => ({ id: display.id, name: display.label || `Display ${display.id}`, width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor }));
}
function selectedDisplay() {
  const display = screen.getAllDisplays().find(item => item.id === activeDisplayId);
  if (!display) throw new Error('The selected display is no longer available. End and restart the session.');
  return display;
}
function clearHighlight() {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = null;
  lastHighlight = null;
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('screenspot:overlay', { kind: 'clear' });
    overlay.hide();
  }
}
async function createOverlay() {
  const display = selectedDisplay();
  overlay = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: 1, height: 1,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    focusable: false, skipTaskbar: true, show: false, resizable: false,
    webPreferences: { preload: join(projectRoot, 'dist', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  await overlay.loadFile(join(projectRoot, 'dist', 'overlay.html'));
}
function stopSession() {
  sessionGeneration += 1;
  activeDisplayId = null;
  busy = false;
  history = [];
  clearHighlight();
  overlay?.destroy();
  overlay = null;
  bridge.restart();
  event('status', { status: 'Stopped', detail: 'Screen capture and microphone session ended.' });
}
function activeWindowRegion(display: Electron.Display): { id: string; window: Rect; region: Rect } {
  if (display.scaleFactor !== 1) throw new Error('Window-only capture needs 100% desktop scaling. Select Full display in Settings.');
  try {
    const current = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { encoding: 'utf8', timeout: 1200 });
    const id = parseActiveWindowId(current);
    if (!id) throw new Error('No app window is active.');
    const details = execFileSync('xwininfo', ['-id', id], { encoding: 'utf8', timeout: 1200 });
    if (/"ScreenSpot Voice Desktop"/.test(details)) throw new Error('Select the software window and ask again.');
    const bounds = parseWindowBounds(details);
    const region = bounds && windowRegion(bounds, display.bounds);
    if (!region) throw new Error('The active window is outside the selected display.');
    return { id, window: bounds!, region };
  } catch (error) {
    if (error instanceof Error && ['No app window is active.', 'Select the software window and ask again.',
      'The active window is outside the selected display.'].includes(error.message)) throw error;
    throw new Error('Could not capture the active app window. Choose Full display in Settings.');
  }
}
async function captureScreen() {
  const display = selectedDisplay();
  clearHighlight();
  // Leave the control window minimized. Restoring it after each screenshot
  // stole focus from the software the user was working in.
  if (control && !control.isDestroyed() && !control.isMinimized()) control.minimize();
  await new Promise(resolve => setTimeout(resolve, 180));
  if (preferences.captureScope === 'window') {
    const active = activeWindowRegion(display);
    const width = Math.min(3440, Math.max(1, Math.round(active.window.width)));
    const height = Math.min(2160, Math.max(1, Math.round(active.window.height)));
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
    const source = sources.find(item => item.id.startsWith('window:' + parseInt(active.id, 16) + ':'));
    if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the active app window. Select Full display in Settings if needed.');
    const full = source.thumbnail.getSize();
    if (Math.abs(full.width / full.height - active.window.width / active.window.height) > 0.045) {
      throw new Error('Active window image shape changed. Ask again after the window settles.');
    }
    const crop = {
      x: Math.max(0, Math.round((display.bounds.x + active.region.x - active.window.x) * full.width / active.window.width)),
      y: Math.max(0, Math.round((display.bounds.y + active.region.y - active.window.y) * full.height / active.window.height)),
      width: Math.round(active.region.width * full.width / active.window.width),
      height: Math.round(active.region.height * full.height / active.window.height),
    };
    crop.width = Math.min(crop.width, full.width - crop.x);
    crop.height = Math.min(crop.height, full.height - crop.y);
    if (crop.width < 1 || crop.height < 1) throw new Error('Active window is no longer visible.');
    const image = source.thumbnail.crop(crop);
    return { jpeg: image.toJPEG(82).toString('base64'), size: image.getSize(), region: active.region };
  }
  const region = { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height };
  const width = Math.min(3440, Math.max(1, Math.round(display.bounds.width * display.scaleFactor)));
  const height = Math.min(2160, Math.max(1, Math.round(display.bounds.height * display.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const source = sources.find(item => item.display_id === String(display.id))
    ?? (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : null);
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the chosen display. Select a screen and try again.');
  const size = source.thumbnail.getSize();
  if (Math.abs(size.width / size.height - display.bounds.width / display.bounds.height) > 0.045) {
    throw new Error('Captured image shape does not match the chosen display.');
  }
  return { jpeg: source.thumbnail.toJPEG(82).toString('base64'), size, region };
}
function showHighlight(box: Box, image: { width: number; height: number }, region: Rect, label: string) {
  const display = selectedDisplay();
  const local = mapBox(box, image, region);
  const rect = shiftRect({ ...local, x: local.x + region.x, y: local.y + region.y },
    display.bounds, { x: preferences.boxOffsetX, y: preferences.boxOffsetY });
  if (!overlay || overlay.isDestroyed()) throw new Error('Desktop overlay is unavailable');
  lastHighlight = { box, image, region, label };
  const placement = placeOverlay(rect, display.bounds);
  overlay.setBounds(placement.bounds);
  overlay.webContents.send('screenspot:overlay', {
    kind: 'show', rect: placement.outline, labelPosition: placement.label, label: label.slice(0, 90),
  });
  overlay.showInactive();
  overlay.setIgnoreMouseEvents(true, { forward: true });
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(clearHighlight, 20000);
}
function modelName() { return preferences.provider === 'local' ? preferences.ollamaModel : preferences.geminiModel; }

async function submitTurn(payload: { text?: string; audio?: string }) {
  if (activeDisplayId === null) throw new Error('Start a screen session first.');
  if (busy) throw new Error('A question is already being processed.');
  if (preferences.provider === 'gemini' && !geminiKey) throw new Error('Enter a Gemini API key in Settings first.');
  const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 500) : '';
  const audio = typeof payload.audio === 'string' ? payload.audio : '';
  if (!text && (!audio || audio.length > 16000000)) throw new Error('Record a short question or enter text.');
  const generation = sessionGeneration;
  busy = true;
  try {
    let question = text;
    if (!question) {
      event('status', { status: 'Transcribing', detail: `Whisper ${preferences.whisperModel} is listening to your recording.` });
      const transcribed = await bridge.request('transcribe', { audio, model: preferences.whisperModel }, 120000);
      if (generation !== sessionGeneration) return;
      question = String(transcribed.text || '').trim().slice(0, 500);
      if (!question) {
        event('empty');
        event('status', { status: 'Listening', detail: 'No clear speech detected. Try Talk now or speak closer to the microphone.' });
        return;
      }
    }
    event('user', { text: question });
    event('status', { status: 'Capturing', detail: preferences.captureScope === 'window' ? 'Reading the active app window.' : 'Reading the selected display.' });
    const capture = await captureScreen();
    if (generation !== sessionGeneration) return;
    event('status', { status: 'Thinking', detail: `${preferences.provider === 'local' ? 'Ollama' : 'Gemini'} is inspecting this screen image.` });
    const result = await bridge.request('ask', {
      provider: preferences.provider, model: modelName(), question, image: capture.jpeg,
      gemini_key: preferences.provider === 'gemini' ? geminiKey : '', history: history.slice(-6),
    }, 180000);
    if (generation !== sessionGeneration) return;
    let highlighted = false;
    let highlightedLabel: string | null = null;
    let highlightError = '';
    for (const call of result.tool_calls || []) {
      if (call?.name === 'clear_highlights') { clearHighlight(); continue; }
      if (call?.name !== 'highlight_region') continue;
      const args = call.arguments || {};
      if (!validBox(args.box_2d)) { highlightError = 'The model returned invalid box coordinates.'; continue; }
      try {
        const label = String(args.label || 'Target').slice(0, 90);
        showHighlight(args.box_2d, capture.size, capture.region, label);
        highlighted = true;
        highlightedLabel = label;
      }
      catch (error) { highlightError = String(error); }
      break;
    }
    const reply = reconcileAnswer(question, result.text, highlightedLabel);
    history.push({ user: question, assistant: reply });
    history = history.slice(-6);
    event('answer', { text: reply, highlighted, highlightError, modelMs: result.latency_ms });
    event('status', { status: highlighted ? 'Highlighted' : 'Answered', detail: highlightError || `${modelName()} replied.` });
    try {
      const speech = await bridge.request('speak', { text: reply.slice(0, 400), voice: preferences.kokoroVoice }, 120000);
      if (generation === sessionGeneration) event('audio', { wav: speech.audio });
    } catch (error) {
      if (generation === sessionGeneration) event('status', { status: 'Voice unavailable', detail: String(error) });
    }
  } catch (error) {
    if (generation === sessionGeneration) event('status', { status: 'Error', detail: String(error instanceof Error ? error.message : error) });
  } finally {
    if (generation === sessionGeneration) busy = false;
  }
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  loadPreferences();
  loadKey();
  control = new BrowserWindow({
    width: 440, height: 760, minWidth: 390, minHeight: 560, show: false,
    title: 'ScreenSpot Voice Desktop', autoHideMenuBar: true,
    webPreferences: { preload: join(projectRoot, 'dist', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === control?.webContents && permission === 'media');
  });
  control.on('closed', () => { stopSession(); control = null; app.quit(); });
  ipcMain.handle('screenspot:state', () => ({ preferences, displays: displays(), active: activeDisplayId !== null, pythonReady: bridge.ready, ...keyState() }));
  ipcMain.handle('screenspot:config', (_event, raw: any) => {
    if (raw.provider !== 'local' && raw.provider !== 'gemini') throw new Error('Invalid model provider');
    const validModel = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(value);
    if (!validModel(raw.ollamaModel) || !validModel(raw.geminiModel)) throw new Error('Invalid model name');
    if (raw.provider === 'gemini' && /-live(?:-|$)/i.test(raw.geminiModel)) throw new Error('Gemini Live needs a streaming voice mode. Choose gemini-3.5-flash here.');
    if (!['tiny.en', 'base.en', 'small.en'].includes(raw.whisperModel)) throw new Error('Invalid Whisper model');
    if (!['af_heart', 'af_bella', 'am_michael', 'bf_emma'].includes(raw.kokoroVoice)) throw new Error('Invalid Kokoro voice');
    if (raw.displayId !== null && !displays().some(item => item.id === raw.displayId)) throw new Error('Choose an available display');
    if (!['window', 'display'].includes(raw.captureScope)) throw new Error('Choose a capture area');
    const newKey = typeof raw.geminiKey === 'string' && raw.geminiKey.trim() ?
      raw.geminiKey.trim().slice(0, 300) : geminiKey;
    geminiKey = raw.clearGeminiKey ? '' : newKey;
    keyStorageError = '';
    if (raw.clearGeminiKey) forgetStoredKey(keyFile());
    else if (raw.rememberGeminiKey) {
      try { storeKey(safeStorage, keyFile(), geminiKey); }
      catch (error) { keyStorageError = String(error instanceof Error ? error.message : error); }
    } else if (canStoreKey(safeStorage)) forgetStoredKey(keyFile());
    preferences = { provider: raw.provider, ollamaModel: raw.ollamaModel, geminiModel: raw.geminiModel,
      whisperModel: raw.whisperModel, kokoroVoice: raw.kokoroVoice, displayId: raw.displayId,
      handsFree: !!raw.handsFree, captureScope: raw.captureScope, boxOffsetX: preferences.boxOffsetX,
      boxOffsetY: preferences.boxOffsetY, modelDefaultsVersion: 3 };
    savePreferences();
    return keyState();
  });
  ipcMain.handle('screenspot:start', async () => {
    if (activeDisplayId !== null) throw new Error('End the current session first');
    const display = screen.getAllDisplays().find(item => item.id === preferences.displayId) ?? screen.getPrimaryDisplay();
    if (preferences.provider === 'gemini' && !geminiKey) throw new Error('Enter a Gemini API key first.');
    activeDisplayId = display.id;
    sessionGeneration += 1;
    history = [];
    try { await createOverlay(); }
    catch (error) { activeDisplayId = null; throw error; }
    event('status', { status: 'Listening', detail: `Sharing ${display.label || 'selected display'}. Only a question triggers a screen image.` });
    return { displayId: display.id };
  });
  ipcMain.handle('screenspot:stop', () => { stopSession(); return true; });
  ipcMain.handle('screenspot:submit', (_event, payload: any) => {
    void submitTurn(payload || {});
    return true;
  });
  ipcMain.handle('screenspot:clear', () => { clearHighlight(); return true; });
  ipcMain.handle('screenspot:nudge', (_event, dx: number, dy: number) => {
    if (![dx, dy].every(value => Number.isInteger(value) && Math.abs(value) <= 10)) throw new Error('Invalid box adjustment');
    preferences.boxOffsetX = Math.max(-120, Math.min(120, preferences.boxOffsetX + dx));
    preferences.boxOffsetY = Math.max(-120, Math.min(120, preferences.boxOffsetY + dy));
    savePreferences();
    if (lastHighlight) {
      const previous = lastHighlight;
      showHighlight(previous.box, previous.image, previous.region, previous.label);
    }
    return { x: preferences.boxOffsetX, y: preferences.boxOffsetY };
  });
  ipcMain.handle('screenspot:forget-key', () => {
    forgetStoredKey(keyFile());
    geminiKey = '';
    keyStorageError = '';
    return keyState();
  });
  ipcMain.handle('screenspot:reset-alignment', () => {
    preferences.boxOffsetX = 0; preferences.boxOffsetY = 0;
    savePreferences();
    if (lastHighlight) {
      const previous = lastHighlight;
      showHighlight(previous.box, previous.image, previous.region, previous.label);
    }
    return { x: 0, y: 0 };
  });
  ipcMain.handle('screenspot:calibrate', () => {
    if (activeDisplayId === null) throw new Error('Start a session first');
    const display = selectedDisplay();
    showHighlight([300, 300, 580, 720], display.bounds, { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }, 'Calibration');
    return true;
  });
  ipcMain.handle('screenspot:quit', () => { app.quit(); return true; });
  screen.on('display-removed', () => { if (activeDisplayId !== null && !screen.getAllDisplays().some(item => item.id === activeDisplayId)) stopSession(); });
  screen.on('display-metrics-changed', () => { if (activeDisplayId !== null) clearHighlight(); });
  control.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  control.webContents.on('will-navigate', event => event.preventDefault());
  await control.loadFile(join(projectRoot, 'dist', 'index.html'));
  control.show();
}).catch(error => { console.error(error); app.quit(); });

app.on('before-quit', () => { bridge.close(); clearHighlight(); });
app.on('window-all-closed', () => app.quit());
