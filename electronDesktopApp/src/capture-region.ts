export type Rect = { x: number; y: number; width: number; height: number };

export function parseActiveWindowId(value: string): string | null {
  const id = value.match(/window id # (0x[0-9a-f]+)/i)?.[1];
  return id && id !== '0x0' ? id : null;
}

export function parseWindowBounds(value: string): Rect | null {
  const read = (name: string) => Number(value.match(new RegExp(name + ':\\s*(-?\\d+)'))?.[1]);
  const rect = {
    x: read('Absolute upper-left X'),
    y: read('Absolute upper-left Y'),
    width: read('Width'),
    height: read('Height'),
  };
  return Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0 ? rect : null;
}

export function windowRegion(window: Rect, display: Rect): Rect | null {
  const x = Math.max(window.x, display.x);
  const y = Math.max(window.y, display.y);
  const right = Math.min(window.x + window.width, display.x + display.width);
  const bottom = Math.min(window.y + window.height, display.y + display.height);
  if (right - x < 240 || bottom - y < 160) return null;
  return { x: x - display.x, y: y - display.y, width: right - x, height: bottom - y };
}
