export type LinkClickModifiers = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export type ExternalLinkPart = {
  from: number;
  to: number;
  href: string | null;
};

const HTTP_URL = /^(https?:)?\/\//i;

/** Absolute http(s) URL for an external article link, or null when it should stay in-app. */
export function externalOpenUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!HTTP_URL.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, 'https://inwit.local');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/** Command-click (macOS) or Ctrl-click opens an external link. Plain click still edits or follows in-app. */
export function wantsExternalLinkOpen(input: LinkClickModifiers): boolean {
  if (input.button !== 0 || input.altKey) return false;
  return input.metaKey || input.ctrlKey;
}

export function externalLinkOpenHref(
  href: string | null | undefined,
  input: LinkClickModifiers,
): string | null {
  if (!wantsExternalLinkOpen(input)) return null;
  return externalOpenUrl(href);
}

/** Join adjacent text nodes that belong to one external link so the jump icon is drawn once. */
export function mergeExternalLinkRanges(
  parts: readonly ExternalLinkPart[],
): { from: number; to: number; href: string }[] {
  const ranges: { from: number; to: number; href: string }[] = [];
  for (const part of parts) {
    if (!part.href) continue;
    const prev = ranges[ranges.length - 1];
    if (prev && prev.to === part.from && prev.href === part.href) {
      prev.to = part.to;
      continue;
    }
    ranges.push({ from: part.from, to: part.to, href: part.href });
  }
  return ranges;
}
