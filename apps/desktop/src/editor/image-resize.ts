/** Smallest width a drag may commit. A picture already smaller than this can stay that size. */
export const MIN_IMAGE_WIDTH_PX = 48;

export type ImageResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

/** Pixel length stored on an image node. Percentages and other units are ignored. */
export function imageLengthPx(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value);
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

/**
 * Next box for a corner drag. Width follows the pointer axis that moved farther,
 * and height is the start box's ratio, so the picture never stretches.
 */
export function nextImageSize(input: {
  startWidth: number;
  startHeight: number;
  deltaX: number;
  deltaY: number;
  corner: ImageResizeCorner;
  minWidth: number;
  maxWidth: number;
}): { width: number; height: number } {
  const { startWidth, startHeight } = input;
  if (!(startWidth > 0) || !(startHeight > 0)) {
    return {
      width: Math.max(1, Math.round(startWidth) || 1),
      height: Math.max(1, Math.round(startHeight) || 1),
    };
  }

  const fromLeft = input.corner === 'nw' || input.corner === 'sw';
  const fromTop = input.corner === 'nw' || input.corner === 'ne';
  const dx = fromLeft ? -input.deltaX : input.deltaX;
  const dy = fromTop ? -input.deltaY : input.deltaY;
  const raw =
    Math.abs(dx) >= Math.abs(dy)
      ? startWidth + dx
      : (startWidth * (startHeight + dy)) / startHeight;
  const upper = Math.max(1, input.maxWidth);
  const lower = Math.min(Math.max(1, input.minWidth), upper);
  const width = Math.round(Math.min(upper, Math.max(lower, raw)));
  const height = Math.max(1, Math.round((width * startHeight) / startWidth));
  return { width, height };
}
