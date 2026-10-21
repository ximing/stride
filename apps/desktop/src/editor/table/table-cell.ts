import { TableCell, TableHeader } from '@tiptap/extension-table';

/**
 * Cell fill stored on `tableCell` / `tableHeader`. Only hex (or an rgb()
 * equivalent) is kept, so a pasted style cannot inject extra declarations.
 */
export function tableCellBackground(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (short?.[1]) {
    const body = short[1];
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`.toLowerCase();
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (full?.[1]) return `#${full[1].toLowerCase()}`;
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(trimmed);
  if (!rgb) return null;
  const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (channels.some((channel) => !Number.isInteger(channel) || channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Structural stand-in so the server build can typecheck this file without the DOM lib. */
type CellElement = {
  style: { backgroundColor: string };
  getAttribute(name: string): string | null;
};

function backgroundColorAttribute() {
  return {
    default: null as string | null,
    parseHTML: (element: CellElement) =>
      tableCellBackground(element.style.backgroundColor || element.getAttribute('bgcolor')),
    renderHTML: (attributes: { backgroundColor?: unknown }) => {
      const color = tableCellBackground(attributes.backgroundColor);
      if (!color) return {};
      return { style: `background-color: ${color}` };
    },
  };
}

export const DocTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: backgroundColorAttribute(),
    };
  },
});

export const DocTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: backgroundColorAttribute(),
    };
  },
});
