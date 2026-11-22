import type { Command, Result } from './types.mjs';

// CDP serializes these functions. Keep them independent of Node and module scope.
export async function waitForGameFrame(this: (command: Command) => Result, command: Command) {
  const initial = this(command);
  if (!initial.data) return initial;
  const painted = await new Promise<boolean>(resolve => {
    let frame: number;
    const timeout = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 1200);
    // Allow one complete paint after binding, including DOM-based HUD elements.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { clearTimeout(timeout); resolve(true); });
    });
  });
  if (!painted) {
    // 窗口不可见时 rAF 不触发：不判失败，交由 CDP 直接复制合成器画面。
    const still = this(command);
    if (!still.data) return still;
    if (initial.data.epoch !== still.data.epoch) return { fault: 'SESSION_CHANGED', inGame: true };
    return still;
  }
  const current = this(command);
  if (!current.data) return current;
  if (initial.data.epoch !== current.data.epoch) return { fault: 'SESSION_CHANGED', inGame: true };
  return current;
}

export function holdGameFrame(this: (command: Command) => Result, command: Command, epoch: string) {
  const current = this(command);
  if (!current.data) return current;
  if (current.data.epoch !== epoch) return { fault: 'SESSION_CHANGED', inGame: true };
  // A separate inspector task leaves Chromium's paint callback free to finish.
  debugger;
  return this(command);
}

export async function scaleCapturedPng(encoded: string): Promise<Result> {
  // Only the immutable captured pixels are inputs. Do not consult the live DOM or game.
  const source = new Image();
  source.src = 'data:image/png;base64,' + encoded;
  try {
    await source.decode();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error();
    for (const edge of [1280, 960, 720, 480, 320]) {
      const scale = Math.min(1, edge / Math.max(source.width, source.height));
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgba = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4);
      if (!rgba.some(pixel => pixel !== rgba[0])) throw new Error();
      const image = canvas.toDataURL('image/png').split(',')[1];
      const bytes = image.length * 3 / 4 - (image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0);
      if (bytes <= 512 * 1024) {
        return { image, data: { width: canvas.width, height: canvas.height, bytes, mimeType: 'image/png' } };
      }
    }
    return { fault: 'OUTPUT_LIMIT', inGame: true };
  } catch {
    return { fault: 'CAPTURE_FAILED', inGame: true };
  }
}
