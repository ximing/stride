import type { MermaidConfig } from 'mermaid';
import { t, watchLocale } from '../../i18n';
import { mermaidSvgLooksUnsafe } from './mermaid-svg';

export type MermaidPaintState = 'off' | 'empty' | 'loading' | 'drawn' | 'error';

export type MermaidFrame = {
  figure: HTMLElement;
  state: () => MermaidPaintState;
  /** Draw `source`, or clear the figure when it is empty. `debounce` waits while the source is being typed. */
  sync: (source: string, options?: { debounce?: boolean }) => void;
  destroy: () => void;
};

type MermaidApi = {
  startOnLoad: boolean;
  initialize: (config: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

type ThemeName = 'light' | 'dark';

const LIGHT = {
  bg: '#f6f3ec',
  sunken: '#efeade',
  surface: '#fffdf8',
  ink: '#221d16',
  ink2: '#574e41',
  ink3: '#8b8172',
  line: '#e6dfd0',
  accent: '#b3402a',
  goldSoft: '#f8f0dc',
  goldLine: '#ecd9ac',
  greenSoft: '#e9f2ea',
  greenLine: '#cbe0cf',
};

const DARK = {
  bg: '#1c1915',
  sunken: '#15120e',
  surface: '#26221c',
  ink: '#f0e8d8',
  ink2: '#c9bfae',
  ink3: '#9a8f7d',
  line: '#3f372c',
  accent: '#e06a52',
  goldSoft: '#3a3018',
  goldLine: '#5c4c24',
  greenSoft: '#1c2c22',
  greenLine: '#2f4a38',
};

const DROP_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta']);

let mermaidApi: Promise<MermaidApi> | null = null;
let renderChain: Promise<void> = Promise.resolve();
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidApi ??= import('mermaid').then((mod) => {
    const api = mod.default as MermaidApi;
    api.startOnLoad = false;
    return api;
  });
  return mermaidApi;
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = renderChain.then(job, job);
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function documentTheme(): ThemeName {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function themeConfig(theme: ThemeName): MermaidConfig {
  const tone = theme === 'dark' ? DARK : LIGHT;
  const sans = cssVar('--sd-font-sans', 'sans-serif');
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    logLevel: 'fatal',
    look: 'classic',
    theme: 'base',
    darkMode: theme === 'dark',
    fontFamily: sans,
    fontSize: 15,
    themeVariables: {
      fontFamily: sans,
      fontSize: '15px',
      background: 'transparent',
      primaryColor: cssVar('--sd-bg-elevated', tone.surface),
      primaryTextColor: cssVar('--sd-fg', tone.ink),
      primaryBorderColor: cssVar('--sd-accent', tone.accent),
      secondaryColor: cssVar('--sd-mark', tone.goldSoft),
      secondaryTextColor: cssVar('--sd-fg', tone.ink),
      secondaryBorderColor: cssVar('--sd-mark-strong', tone.goldLine),
      tertiaryColor: cssVar('--green-soft', tone.greenSoft),
      tertiaryTextColor: cssVar('--sd-fg', tone.ink),
      tertiaryBorderColor: cssVar('--green-line', tone.greenLine),
      lineColor: cssVar('--sd-muted', tone.ink3),
      textColor: cssVar('--sd-fg', tone.ink),
      mainBkg: cssVar('--sd-bg-elevated', tone.surface),
      nodeBorder: cssVar('--sd-accent', tone.accent),
      clusterBkg: cssVar('--sd-bg', tone.sunken),
      clusterBorder: cssVar('--sd-border', tone.line),
      titleColor: cssVar('--sd-fg', tone.ink),
      edgeLabelBackground: cssVar('--sd-bg', tone.bg),
      noteBkgColor: cssVar('--sd-mark', tone.goldSoft),
      noteTextColor: cssVar('--sd-fg', tone.ink),
      noteBorderColor: cssVar('--sd-mark-strong', tone.goldLine),
      actorBkg: cssVar('--sd-bg-elevated', tone.surface),
      actorBorder: cssVar('--sd-muted', tone.ink3),
      actorTextColor: cssVar('--sd-fg', tone.ink),
      signalColor: cssVar('--sd-muted', tone.ink2),
      signalTextColor: cssVar('--sd-fg', tone.ink),
      labelBoxBkgColor: cssVar('--sd-bg-elevated', tone.surface),
      labelTextColor: cssVar('--sd-fg', tone.ink),
    },
  };
}

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return true;
  if (/^https?:/i.test(trimmed)) return true;
  return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;|,)/i.test(trimmed);
}

function sanitizeSvg(root: Element): void {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    if (DROP_TAGS.has(el.localName)) {
      el.remove();
      continue;
    }
    if (el.localName === 'style' && el.textContent) {
      el.textContent = el.textContent.replace(/javascript\s*:/gi, '').replace(/expression\s*\(/gi, '');
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name.endsWith(':href')) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function adoptSvg(svg: string): Element | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;
  const root = parsed.documentElement;
  if (root.localName !== 'svg') return null;
  sanitizeSvg(root);
  if (mermaidSvgLooksUnsafe(root.outerHTML)) return null;
  const node = document.importNode(root, true);
  return node.localName === 'svg' ? node : null;
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function nextRenderId(): string {
  renderSeq += 1;
  return `inwit-mermaid-${renderSeq.toString(36)}`;
}

/**
 * Live diagram for a mermaid block.
 * `onChange` runs after the async draw settles.
 * Click handlers from Mermaid are not bound; `securityLevel: 'strict'` stays on.
 */
export function createMermaidFrame(onChange: () => void): MermaidFrame {
  const figure = document.createElement('figure');
  figure.className = 'doc-mermaid';
  figure.setAttribute('contenteditable', 'false');
  figure.hidden = true;

  const stage = document.createElement('div');
  stage.className = 'doc-mermaid-stage';

  const status = document.createElement('p');
  status.className = 'doc-mermaid-status';
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  figure.append(stage, status);

  let paintState: MermaidPaintState = 'off';
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey = '';
  let pendingKey = '';

  const setState = (next: MermaidPaintState): void => {
    paintState = next;
  };

  const hideFigure = (): void => {
    figure.hidden = true;
    status.hidden = true;
    status.textContent = '';
    status.removeAttribute('title');
    stage.replaceChildren();
  };

  const cancel = (): void => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingKey = '';
    lastKey = '';
  };

  const applyStatus = (): void => {
    if (paintState === 'loading') status.textContent = t('editor.mermaid.drawing');
    else if (paintState === 'error') status.textContent = t('editor.mermaid.failed');
  };
  applyStatus();
  const unwatch = watchLocale(applyStatus);

  const showLoading = (): void => {
    if (stage.childElementCount > 0) return;
    setState('loading');
    status.hidden = false;
    applyStatus();
    status.removeAttribute('title');
    figure.hidden = false;
  };

  const showError = (detail: string): void => {
    stage.replaceChildren();
    status.hidden = false;
    setState('error');
    applyStatus();
    if (detail) status.title = detail;
    else status.removeAttribute('title');
    figure.hidden = false;
  };

  const showSvg = (svg: Element): void => {
    stage.replaceChildren(svg);
    status.hidden = true;
    status.textContent = '';
    status.removeAttribute('title');
    figure.hidden = false;
    setState('drawn');
  };

  const draw = async (token: number, source: string, theme: ThemeName, key: string): Promise<void> => {
    const id = nextRenderId();
    try {
      const svg = await enqueue(async () => {
        const api = await loadMermaid();
        api.initialize(themeConfig(theme));
        try {
          const rendered = await api.render(id, source);
          return rendered.svg;
        } finally {
          document.getElementById(id)?.remove();
        }
      });
      if (token !== generation) return;
      const node = adoptSvg(svg);
      if (!node) {
        lastKey = key;
        showError('');
        onChange();
        return;
      }
      lastKey = key;
      showSvg(node);
      onChange();
    } catch (error) {
      if (token !== generation) return;
      lastKey = key;
      showError(errorDetail(error));
      onChange();
    }
  };

  const sync = (source: string, options?: { debounce?: boolean }): void => {
    if (!source.trim()) {
      if (paintState !== 'empty') {
        cancel();
        setState('empty');
        hideFigure();
      }
      return;
    }
    const theme = documentTheme();
    const key = `${theme}\0${source}`;
    if (key === lastKey && (paintState === 'drawn' || paintState === 'error')) return;
    if (key === pendingKey) return;
    pendingKey = key;
    showLoading();
    if (timer !== null) clearTimeout(timer);
    const token = ++generation;
    timer = setTimeout(() => {
      timer = null;
      void draw(token, source, theme, key);
    }, options?.debounce ? 280 : 0);
  };

  const onTheme = (): void => {
    onChange();
  };
  const themeObserver = new MutationObserver(onTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  return {
    figure,
    state: () => paintState,
    sync,
    destroy: () => {
      unwatch();
      cancel();
      themeObserver.disconnect();
    },
  };
}
