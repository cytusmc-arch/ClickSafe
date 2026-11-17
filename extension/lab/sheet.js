// Contact sheet: letterbox drawables into a numbered grid so a vision LLM can refer to cells by index.
import { canvas2d } from './media.js';

export const MAX_CELLS = 16;

// sources: drawables (canvas / ImageBitmap) with width/height. Returns an OffscreenCanvas.
export function composeSheet(sources, { cell = 256, cols = 4 } = {}) {
  const n = Math.min(sources.length, MAX_CELLS);
  const c = Math.max(1, Math.min(cols, n));
  const rows = Math.ceil(n / c);
  const [cv, ctx] = canvas2d(c * cell, rows * cell);
  ctx.fillStyle = '#14161b';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const pad = Math.max(2, Math.round(cell * 0.02));
  const fs = Math.max(11, Math.round(cell * 0.085));
  for (let i = 0; i < n; i++) {
    const src = sources[i];
    const x0 = (i % c) * cell, y0 = Math.floor(i / c) * cell;
    const w = src.width, h = src.height;
    const s = Math.min((cell - 2 * pad) / w, (cell - 2 * pad) / h);
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    ctx.drawImage(src, x0 + Math.round((cell - dw) / 2), y0 + Math.round((cell - dh) / 2), dw, dh);
    // cell frame
    ctx.strokeStyle = '#2c313a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cell - 1, cell - 1);
    // index badge (1-based) in the top-left corner
    const label = String(i + 1);
    ctx.font = `bold ${fs}px system-ui, sans-serif`;
    const bw = Math.ceil(ctx.measureText(label).width) + Math.round(fs * 0.7), bh = Math.round(fs * 1.45);
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(x0 + pad, y0 + pad, bw, bh);
    ctx.strokeStyle = '#ffd400';
    ctx.strokeRect(x0 + pad + 0.5, y0 + pad + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(label, x0 + pad + bw / 2, y0 + pad + bh / 2 + 1);
  }
  return cv;
}
