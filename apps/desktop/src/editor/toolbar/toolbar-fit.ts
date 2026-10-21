export type ToolbarItemMeasure = {
  width: number;
  margin?: number;
  separator?: boolean;
};

/** Half a pixel covers subpixel rounding without clipping a real item. */
const SLACK = 0.5;

function itemSpace(item: ToolbarItemMeasure): number {
  return item.width + (item.margin ?? 0);
}

function rowWidth(items: readonly ToolbarItemMeasure[], count: number, gap: number): number {
  let used = 0;
  for (let i = 0; i < count; i += 1) {
    const item = items[i];
    if (!item) break;
    used += itemSpace(item) + (i > 0 ? gap : 0);
  }
  return used;
}

/**
 * How many leading items stay in the bar.
 * `available <= 0` means the bar has not been laid out, so keep every item.
 * A trailing separator that no longer fits is dropped and does not open 更多.
 */
export function toolbarFitCount(
  items: readonly ToolbarItemMeasure[],
  available: number,
  moreWidth: number,
  gap: number,
): number {
  if (items.length === 0 || available <= 0) return items.length;
  if (rowWidth(items, items.length, gap) <= available + SLACK) return items.length;

  let contentEnd = items.length;
  while (contentEnd > 0 && items[contentEnd - 1]?.separator) contentEnd -= 1;

  let best = 0;
  for (let count = 0; count <= contentEnd; count += 1) {
    if (count > 0 && items[count - 1]?.separator) continue;
    const used = rowWidth(items, count, gap);
    if (count === contentEnd) {
      if (used <= available + SLACK) best = count;
      continue;
    }
    const need = count === 0 ? moreWidth : used + gap + moreWidth;
    if (need <= available + SLACK) best = count;
  }
  return best;
}

/** Items that move into 更多. Boundary separators stay out of both rows. */
export function toolbarOverflowRange(
  items: readonly { separator?: boolean }[],
  fit: number,
): { start: number; end: number } {
  const endAll = items.length;
  let end = endAll;
  let start = Math.max(0, Math.min(fit, endAll));
  while (end > start && items[end - 1]?.separator) end -= 1;
  while (start < end && items[start]?.separator) start += 1;
  return { start, end };
}
