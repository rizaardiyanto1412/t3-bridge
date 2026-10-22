/**
 * The menu bar icon, drawn in code so the app ships no image files: two rings joined by a
 * short bar, a small bridge. Black on transparent so macOS can tint it as a template image.
 */
function draw(size: number) {
  const bitmap = Buffer.alloc(size * size * 4);
  const ring = (
    cx: number,
    cy: number,
    radius: number,
    thickness: number,
    x: number,
    y: number,
  ) => {
    const distance = Math.hypot(x - cx, y - cy);
    return Math.max(0, Math.min(1, thickness / 2 + 0.5 - Math.abs(distance - radius)));
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const unit = size / 36;
      const left = ring(9 * unit, 18 * unit, 6 * unit, 3.4 * unit, px, py);
      const right = ring(27 * unit, 18 * unit, 6 * unit, 3.4 * unit, px, py);
      const bar =
        Math.abs(py - 18 * unit) <= 1.7 * unit && px > 14 * unit && px < 22 * unit ? 1 : 0;
      const alpha = Math.max(left, right, bar);
      const offset = (y * size + x) * 4;
      // BGRA, premultiplied: black ink means only alpha carries the shape.
      bitmap[offset + 3] = Math.round(alpha * 255);
    }
  }
  return bitmap;
}

const SIZE = 36;
export const trayIcon = { size: SIZE, bitmap: draw(SIZE) };
