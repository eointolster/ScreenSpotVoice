import { mapBox, validBox, type View, type OverlayRequest } from './contracts';

const documentId = crypto.randomUUID();
let revision = 0;
let current: HTMLElement | null = null;
let timer: number | undefined;
let lastRoute = location.href;
let invalidationScheduled = false;
const view = (): View => ({ documentId, revision, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, zoom: window.visualViewport?.scale || 1 });
function clear() { if (timer) clearTimeout(timer); current?.remove(); current = null; }
function report(reason: string) { try { chrome.runtime.sendMessage({ type: 'VIEW', view: view(), reason }).catch(() => {}); } catch { /* A reloaded extension invalidates old isolated-world contexts. */ } }
function invalidate(reason: string) { clear(); if (invalidationScheduled) return; invalidationScheduled = true; revision++; report(reason); requestAnimationFrame(() => { invalidationScheduled = false; }); }
addEventListener('scroll', () => invalidate('scroll'), true);
addEventListener('resize', () => invalidate('resize'));
window.visualViewport?.addEventListener('resize', () => invalidate('visual viewport'));
window.visualViewport?.addEventListener('scroll', () => invalidate('visual viewport'));
addEventListener('pagehide', () => invalidate('pagehide'));
addEventListener('popstate', () => invalidate('route'));
addEventListener('hashchange', () => invalidate('route'));
setInterval(() => { if (location.href !== lastRoute) { lastRoute = location.href; invalidate('route'); } }, 500);

chrome.runtime.onMessage.addListener((message: OverlayRequest | { kind: 'VIEW' }, _sender, sendResponse) => {
  if (message.kind === 'VIEW') { sendResponse({ ok: true, view: view() }); return; }
  if (message.kind === 'CLEAR') { clear(); sendResponse({ ok: true, view: view() }); return; }
  if (message.kind !== 'SHOW' || !validBox(message.box)) { sendResponse({ ok: false, reason: 'invalid box' }); return; }
  const expected = message.view, now = view();
  if (expected.documentId !== now.documentId || expected.revision !== now.revision || expected.width !== now.width || expected.height !== now.height || expected.dpr !== now.dpr || expected.zoom !== now.zoom) {
    sendResponse({ ok: false, reason: 'view changed', view: now }); return;
  }
  try {
    const rect = mapBox(message.box, message.image, now);
    clear();
    const host = document.createElement('div');
    host.setAttribute('data-screenspot-overlay', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `0 0 ${now.width} ${now.height}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'display:block;pointer-events:none';
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    outline.setAttribute('x', String(rect.x)); outline.setAttribute('y', String(rect.y));
    outline.setAttribute('width', String(rect.width)); outline.setAttribute('height', String(rect.height));
    outline.setAttribute('rx', '9'); outline.setAttribute('fill', 'none'); outline.setAttribute('stroke', '#000'); outline.setAttribute('stroke-width', '7');
    const inner = outline.cloneNode(true) as SVGRectElement;
    inner.setAttribute('stroke', '#79eaff'); inner.setAttribute('stroke-width', '4');
    svg.append(outline, inner); root.append(svg);
    (document.documentElement || document.body).append(host);
    current = host;
    timer = setTimeout(() => invalidate('expiry'), 8000) as unknown as number;
    sendResponse({ ok: true, view: now });
  } catch (error) { sendResponse({ ok: false, reason: String(error) }); }
});
report('ready');
