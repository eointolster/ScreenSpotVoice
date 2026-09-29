export type View = { documentId: string; revision: number; width: number; height: number; dpr: number; zoom: number };
export type Box = [number, number, number, number];
export type OverlayRequest = { kind: 'SHOW'; id: string; box: Box; label: string; view: View; image: { width: number; height: number } } | { kind: 'CLEAR'; id: string };
export type PanelState = { status: string; tabId: number | null; tabTitle: string; paused: boolean; muted: boolean; connected: boolean; model: string; detail: string; diagnostics: Record<string, unknown>; transcript: string[] };
export const emptyState = (): PanelState => ({ status: 'Ready', tabId: null, tabTitle: '', paused: false, muted: false, connected: false, model: '', detail: '', diagnostics: {}, transcript: [] });
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
