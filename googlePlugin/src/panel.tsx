import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { chooseProvider, emptyState, fetchProviderStatus, type PanelState, type ProviderStatus } from './contracts';

function App() {
  const [state, setState] = useState<PanelState>(emptyState());
  const [token, setToken] = useState('');
  const [port, setPort] = useState('8766');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [providerError, setProviderError] = useState('');

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await fetchProviderStatus(Number(port) || 8766));
      setProviderError('');
    } catch (e) {
      setProviders(null);
      setProviderError(`Cannot reach the backend on port ${port}: ${(e as Error).message}`);
    }
  }, [port]);

  useEffect(() => { void refreshProviders(); }, [refreshProviders]);

  /** Switch provider for the next session. The backend has the final say. */
  async function selectProvider(provider: string) {
    setProviderError(''); setBusy(true);
    try {
      if (token.trim().length < 16) throw new Error('Enter the pairing code to switch provider.');
      const next = await chooseProvider(Number(port) || 8766, token.trim(), provider);
      setProviders(next);
      setError(`Provider set to ${next.providers[provider]?.label ?? provider}. Start a new session to use it.`);
    } catch (e) {
      setProviderError((e as Error).message);
    } finally { setBusy(false); }
  }
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }).then(reply => { if (reply?.ok) setState(reply.value); }).catch(() => {});
    const listener = (message: any) => { if (message?.type === 'STATE') setState(message.state); };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  async function command(type: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try {
      const reply = await chrome.runtime.sendMessage({ type, ...extra });
      if (!reply?.ok) throw new Error(reply?.reason || 'Command failed');
      if (reply.value?.status) setState(reply.value);
      return reply.value;
    } catch (e) { setError(String((e as Error).message || e)); } finally { setBusy(false); }
  }
  async function start() {
    setError(''); setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a regular website and click the extension toolbar icon on that tab.');
      if (token.trim().length < 16) throw new Error('Enter the pairing code printed by the local backend.');
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null);
      if (permission?.state !== 'granted') {
        const setupUrl = new URL(chrome.runtime.getURL('mic-permission.html'));
        setupUrl.searchParams.set('returnTab', String(tab.id));
        await chrome.tabs.create({ url: setupUrl.toString(), active: true });
        setError('Allow microphone in the new ScreenSpot tab, return to this webpage, then click Start Session again.');
        return;
      }
      const reply = await chrome.runtime.sendMessage({ type: 'BEGIN', tabId: tab.id, title: tab.title || 'Shared tab', token: token.trim(), port: Number(port) });
      if (!reply?.ok) throw new Error(reply?.reason || 'Start failed');
      setState(reply.value);
      setToken('');
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }
  const active = state.tabId !== null;
  // The backend tells us which provider is really running; never assume Gemini.
  const mode = (state.diagnostics.mode as string) || '';
  const isLocal = mode === 'local';
  const provider = state.model || 'unknown provider';
  return <main>
    <h1>ScreenSpot Voice</h1>
    <div className="muted">Live screen-aware voice guidance</div>
    <div className="card"><div className="status">{state.status}</div><small>{state.detail || (active ? `Sharing: ${state.tabTitle}` : 'Click the toolbar icon on a website to authorize that tab.')}</small>{active && <small>Shared tab: {state.tabTitle} (#{state.tabId})</small>}
      <small><strong>Model:</strong> {provider} ({mode || 'unknown mode'})</small>
    </div>
    {mode === 'calibration' && <div className="card"><small><strong>No live model is configured.</strong> The backend is running without a Gemini key, so it cannot answer questions. Set <code>MODEL_BACKEND=local</code> in <code>googlePlugin/.env</code> and restart to use a local model instead, or add <code>GEMINI_API_KEY</code>.</small></div>}
    <div className="card">
      <label htmlFor="provider">Model provider</label>
      {!providers
        ? <div className="row"><button disabled onClick={() => {}}>Unavailable</button><button disabled onClick={() => {}}>Unavailable</button><button disabled onClick={() => void refreshProviders()}>Retry</button></div>
        : <div className="row">{(['local', 'gemini'] as const).map(id => {
            const info = providers.providers[id];
            const selected = providers.selected === id;
            return <button key={id}
              className={selected ? 'primary' : ''}
              disabled={busy || active || !info?.available}
              title={info?.available ? info.detail : `${info?.label ?? id}: ${info?.detail ?? 'unavailable'}`}
              onClick={() => void selectProvider(id)}>
              {info?.label ?? id}{selected ? ' ✓' : ''}{info && !info.available ? ' (no key)' : ''}
            </button>;
          })}
          {active && <button disabled>End session to switch</button>}
        </div>}
      {providers && <small>Applies to the next session. {providers.mode === 'local'
        ? 'Screenshots stay on this machine; Chrome sends microphone audio to a Google speech service.'
        : 'Microphone audio and tab images are sent to Google Gemini.'}</small>}
      {providerError && <div className="error" role="alert">{providerError}</div>}
    </div>
    {!active && <>
      <div className="card"><small>{isLocal
        ? 'Microphone audio is transcribed by Chrome (audio goes to a Google speech service). Selected tab images are sent only to the local backend and your own model, so page content is not uploaded to Google. No webcam or tab audio is captured.'
        : 'During a live session, microphone audio and selected tab images go through your local backend to Google Gemini. No webcam or tab audio is captured. End Session stops new uploads; data already sent cannot be recalled.'}</small></div>
      <label htmlFor="pair">Backend pairing code</label><input id="pair" type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="Code shown in backend terminal" />
      <label htmlFor="port">Backend port</label><input id="port" inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} />
      <div className="row"><button className="primary" disabled={busy} onClick={start}>Start Session</button><button disabled={busy} onClick={() => command('CALIBRATE')}>Calibrate box</button><button disabled={busy} onClick={() => command('CLEAR')}>Clear box</button></div>
    </>}
    {active && <>
      <div className="row">
        {state.paused && <button className="primary" disabled={busy} onClick={() => command('RESUME')}>Resume shared tab</button>}
        <button disabled={busy} onClick={() => command('MUTE', { muted: !state.muted })}>{state.muted ? 'Unmute mic' : 'Mute mic'}</button>
        <button disabled={busy} onClick={() => command('CLEAR')}>Clear highlight</button>
        <button disabled={busy} onClick={() => command('CALIBRATE')}>Calibrate box</button>
        <button className="primary" disabled={busy} onClick={() => command('END')}>End Session</button>
      </div>
      <label htmlFor="typed">Optional typed message</label><input id="typed" value={text} maxLength={500} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { void command('TEXT', { text: text.trim() }); setText(''); } }} placeholder="Ask about what is visible" />
      <div className="row"><button disabled={busy || !text.trim() || state.paused} onClick={() => { void command('TEXT', { text: text.trim() }); setText(''); }}>Send</button></div>
    </>}
    {error && <div className="error" role="alert">{error}</div>}
    {state.transcript.length > 0 && <div className="card transcript">{state.transcript.map((line, index) => <div key={index}>{line}</div>)}</div>}
    <details><summary>Diagnostics</summary><pre>{JSON.stringify({ model: state.model || 'none', connected: state.connected, ...state.diagnostics }, null, 2)}</pre></details>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
