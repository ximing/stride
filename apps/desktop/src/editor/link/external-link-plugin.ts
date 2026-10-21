import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t, watchLocale } from '../../i18n';
import {
  externalLinkOpenHref,
  externalOpenUrl,
  type ExternalLinkPart,
  mergeExternalLinkRanges,
} from './external-link';

const JUMP_ICON_CLASS = 'doc-ext-link-jump';

const JUMP_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

const pluginKey = new PluginKey<DecorationSet>('externalLinkOpen');
const jumpUnwatch = new WeakMap<Node, () => void>();

let lastOpened = { url: '', at: 0 };

function openExternalUrl(url: string): void {
  const now = Date.now();
  if (lastOpened.url === url && now - lastOpened.at < 500) return;
  lastOpened = { url, at: now };
  window.open(url, '_blank', 'noopener,noreferrer');
}

function createJumpIcon(href: string): HTMLElement {
  const icon = document.createElement('span');
  icon.className = JUMP_ICON_CLASS;
  const applyTitle = () => {
    icon.title = t('editor.openLink');
  };
  applyTitle();
  jumpUnwatch.set(icon, watchLocale(applyTitle));
  icon.dataset.href = href;
  icon.innerHTML = JUMP_ICON_SVG;
  const open = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    openExternalUrl(href);
  };
  icon.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  icon.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    open(event);
  });
  icon.addEventListener('click', (event) => {
    if (event.button !== 0) return;
    open(event);
  });
  return icon;
}

function externalLinkDecorations(doc: ProseMirrorNode): DecorationSet {
  const parts: ExternalLinkPart[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((item) => item.type.name === 'link');
    const raw = mark && typeof mark.attrs.href === 'string' ? mark.attrs.href : null;
    const href = externalOpenUrl(raw);
    if (!href) return;
    const from = pos;
    const to = pos + node.nodeSize;
    const prev = parts[parts.length - 1];
    if (prev && prev.to === from && prev.href === href) {
      prev.to = to;
      return;
    }
    parts.push({ from, to, href });
  });

  const widgets = mergeExternalLinkRanges(parts).map((range) =>
    Decoration.widget(range.to, () => createJumpIcon(range.href), {
      // Keep the icon outside the link mark so the underline stops at the text.
      side: 1,
      marks: [],
      ignoreSelection: true,
      stopEvent: () => true,
      key: `${range.href}@${range.to}`,
      destroy: (node) => {
        jumpUnwatch.get(node)?.();
        jumpUnwatch.delete(node);
      },
    }),
  );
  return DecorationSet.create(doc, widgets);
}

function modifierOpenHref(event: MouseEvent, root: HTMLElement): string | null {
  const target = event.target;
  if (!(target instanceof Element) || !root.contains(target)) return null;
  if (target.closest(`.${JUMP_ICON_CLASS}`)) return null;
  const anchor = target.closest('a');
  if (!(anchor instanceof HTMLAnchorElement) || !root.contains(anchor)) return null;
  return externalLinkOpenHref(anchor.getAttribute('href'), event);
}

function externalLinkPlugin(): Plugin {
  return new Plugin({
    key: pluginKey,
    state: {
      init: (_config, state) => externalLinkDecorations(state.doc),
      apply: (tr, old, _prev, next) => {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return externalLinkDecorations(next.doc);
      },
    },
    props: {
      decorations(state) {
        return pluginKey.getState(state) ?? null;
      },
      handleDOMEvents: {
        // Runs before the link mark's click handler, which otherwise selects the mark and cancels navigation.
        mousedown: (view, event) => {
          if (!modifierOpenHref(event, view.dom)) return false;
          event.preventDefault();
          return true;
        },
        mouseup: (view, event) => {
          const url = modifierOpenHref(event, view.dom);
          if (!url) return false;
          event.preventDefault();
          event.stopPropagation();
          openExternalUrl(url);
          return true;
        },
        click: (view, event) => {
          const url = modifierOpenHref(event, view.dom);
          if (!url) return false;
          event.preventDefault();
          event.stopPropagation();
          openExternalUrl(url);
          return true;
        },
      },
    },
  });
}

export const externalLinkOpen = Extension.create({
  name: 'externalLinkOpen',
  priority: 1000,
  addProseMirrorPlugins() {
    return [externalLinkPlugin()];
  },
});
