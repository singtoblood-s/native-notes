import type { InkStroke } from "./models";

export interface InkRect { left: number; top: number; right: number; bottom: number; }
export interface InkSelection { ids: Set<string>; bounds: InkRect; }

function strokeRect(stroke: InkStroke, width: number, height: number): InkRect | null {
  if (!stroke.points.length) return null;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const point of stroke.points) {
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
  }
  const radius = Math.max(.25, stroke.width / 2);
  if (right < 0 || bottom < 0 || left > width || top > height) return null;
  return { left: Math.max(0, left - radius), right: Math.min(width, right + radius),
    top: Math.max(0, top - radius), bottom: Math.min(height, bottom + radius) };
}

export function selectInk(strokes: InkStroke[], width: number, height: number, match: (id: string, box: InkRect) => boolean): InkSelection | null {
  const ids = new Set<string>();
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const stroke of strokes) {
    const rect = strokeRect(stroke, width, height);
    if (!rect || !match(stroke.id, rect)) continue;
    ids.add(stroke.id);
    bounds.left = Math.min(bounds.left, rect.left); bounds.right = Math.max(bounds.right, rect.right);
    bounds.top = Math.min(bounds.top, rect.top); bounds.bottom = Math.max(bounds.bottom, rect.bottom);
  }
  return ids.size ? { ids, bounds } : null;
}

export function offsetInkRect(bounds: InkRect, x: number, y: number): InkRect {
  return { left: bounds.left + x, top: bounds.top + y, right: bounds.right + x, bottom: bounds.bottom + y };
}
