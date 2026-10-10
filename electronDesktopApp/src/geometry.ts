export type Box = [number, number, number, number];
export type Size = { width: number; height: number };

export function validBox(value: unknown): value is Box {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000)) return false;
  const [top, left, bottom, right] = value;
  return bottom - top >= 2 && right - left >= 2 && (bottom - top) * (right - left) <= 700000;
}

export function mapBox(box: Box, image: Size, display: Size) {
  if (Math.min(image.width, image.height, display.width, display.height) <= 0) throw new Error('Invalid image or display size');
  if (Math.abs(image.width / image.height - display.width / display.height) > 0.045) throw new Error('Screen capture and display shapes differ');
  const padX = Math.min(12, display.width * 0.012);
  const padY = Math.min(12, display.height * 0.012);
  const left = Math.max(0, box[1] * display.width / 1000 - padX);
  const top = Math.max(0, box[0] * display.height / 1000 - padY);
  const right = Math.min(display.width, box[3] * display.width / 1000 + padX);
  const bottom = Math.min(display.height, box[2] * display.height / 1000 + padY);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export type Rect = { x: number; y: number; width: number; height: number };

export function shiftRect(rect: Rect, display: Size, offset: { x: number; y: number }): Rect {
  if (![offset.x, offset.y].every(Number.isFinite)) throw new Error('Invalid box alignment');
  return {
    ...rect,
    x: Math.max(0, Math.min(display.width - rect.width, rect.x + offset.x)),
    y: Math.max(0, Math.min(display.height - rect.height, rect.y + offset.y)),
  };
}

// The overlay is a small window around the target. Even if transparency fails,
// it cannot hide the whole desktop.
export function placeOverlay(rect: Rect, display: Rect) {
  if (![rect.x, rect.y, rect.width, rect.height, display.x, display.y, display.width, display.height].every(Number.isFinite)) {
    throw new Error('Invalid overlay geometry');
  }
  if (rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 ||
      rect.x + rect.width > display.width + 1 || rect.y + rect.height > display.height + 1) {
    throw new Error('Highlight box is outside the selected display');
  }
  const labelBelow = rect.y < 40 && rect.y + rect.height + 42 <= display.height;
  const topSpace = labelBelow ? 12 : 40;
  const bottomSpace = labelBelow ? 42 : 12;
  const width = Math.min(display.width, Math.max(220, Math.ceil(rect.width + 32)));
  const height = Math.min(display.height, Math.ceil(rect.height + topSpace + bottomSpace));
  const x = Math.max(display.x, Math.min(Math.floor(display.x + rect.x - 16), display.x + display.width - width));
  const y = Math.max(display.y, Math.min(Math.floor(display.y + rect.y - topSpace), display.y + display.height - height));
  const outline = { x: display.x + rect.x - x, y: display.y + rect.y - y, width: rect.width, height: rect.height };
  const label = {
    x: Math.max(0, Math.min(outline.x, width - 180)),
    y: labelBelow ? outline.y + rect.height + 6 : Math.max(0, outline.y - 31),
  };
  return { bounds: { x, y, width, height }, outline, label };
}
