export type View = { documentId: string; revision: number; width: number; height: number; dpr: number; zoom: number };
export type Box = [number, number, number, number];
export type OverlayRequest = { kind: 'SHOW'; id: string; box: Box; label: string; view: View; image: { width: number; height: number } } | { kind: 'CLEAR'; id: string };
export type PanelState = { status: string; tabId: number | null; tabTitle: string; paused: boolean; muted: boolean; connected: boolean; model: string; detail: string; diagnostics: Record<string, unknown>; transcript: string[] };
export type ProviderInfo = { label: string; available: boolean; detail: string };
export type ProviderStatus = { selected: string; mode: string; model: string; providers: Record<string, ProviderInfo> };
export const emptyState = (): PanelState => ({ status: 'Ready', tabId: null, tabTitle: '', paused: false, muted: false, connected: false, model: '', detail: '', diagnostics: {}, transcript: [] });

/**
 * Read the backend's provider list.
 *
 * Availability comes from the backend, not from here, so a missing API key is
 * reported as "not available" instead of being discovered only when nothing
 * replies. `http://` is allowed by connect-src for exactly this loopback call.
 */
export async function fetchProviderStatus(port: number): Promise<ProviderStatus> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Backend /health returned ${response.status}`);
  const body = await response.json();
  return {
    selected: String(body.selected ?? 'gemini'),
    mode: String(body.mode ?? ''),
    model: String(body.model ?? ''),
    providers: (body.providers ?? {}) as Record<string, ProviderInfo>,
  };
}

/**
 * Ask the backend to use `provider` for subsequent sessions.
 *
 * The pairing code is required because the switch is a control-plane change, not
 * a health probe. The backend refuses an unavailable provider, so this throws
 * with the reason to show (for example, "No GEMINI_API_KEY set").
 */
export async function chooseProvider(port: number, token: string, provider: string): Promise<ProviderStatus> {
  const response = await fetch(`http://127.0.0.1:${port}/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, token }),
  });
  if (!response.ok) {
    let reason = `Switch refused (${response.status})`;
    try { const body = await response.json(); if (body?.detail) reason = String(body.detail); } catch { /* non-JSON error body */ }
    throw new Error(reason);
  }
  const body = await response.json();
  return {
    selected: String(body.selected ?? provider),
    mode: String(body.mode ?? ''),
    model: String(body.model ?? ''),
    providers: (body.providers ?? {}) as Record<string, ProviderInfo>,
  };
}
export function validBox(value: unknown): value is Box {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000) && value[0] < value[2] && value[1] < value[3] && (value[2] - value[0]) >= 2 && (value[3] - value[1]) >= 2;
}
export function mapBox(box: Box, image: { width: number; height: number }, viewport: { width: number; height: number }) {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new Error('Invalid geometry');
  if (Math.abs(image.width / image.height - viewport.width / viewport.height) > 0.045) throw new Error('Capture and viewport aspect ratios disagree');
  const paddingX = Math.min(12, viewport.width * 0.012), paddingY = Math.min(12, viewport.height * 0.012);
  const x = box[1] / 1000 * viewport.width, y = box[0] / 1000 * viewport.height;
  const right = box[3] / 1000 * viewport.width, bottom = box[2] / 1000 * viewport.height;
  return { x: Math.max(0, x - paddingX), y: Math.max(0, y - paddingY), width: Math.min(viewport.width, right + paddingX) - Math.max(0, x - paddingX), height: Math.min(viewport.height, bottom + paddingY) - Math.max(0, y - paddingY) };
}
