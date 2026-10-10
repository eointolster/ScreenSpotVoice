const outline = document.getElementById('outline')!;
const title = document.getElementById('target-label')!;
window.screenspot.onOverlay(message => {
  if (!message || message.kind === 'clear') { outline.style.display = 'none'; title.style.display = 'none'; return; }
  const rect = message.rect;
  if (message.kind !== 'show' || !rect || ![rect.x, rect.y, rect.width, rect.height].every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) return;
  outline.style.cssText = `display:block;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
  title.textContent = String(message.label || 'Target').slice(0, 90);
  const labelPosition = message.labelPosition || { x: rect.x, y: Math.max(0, rect.y - 31) };
  title.style.cssText = `display:block;left:${labelPosition.x}px;top:${labelPosition.y}px;max-width:${Math.max(80, window.innerWidth - labelPosition.x - 4)}px`;
});
