import { t } from '../../i18n';

export type CodeLanguageChoice = {
  value: string;
  label: string;
};

/**
 * Picker order. `mermaid` is drawn as a diagram and highlighted as plain text.
 * The other ids are highlight.js languages from lowlight's common bundle.
 */
export const CODE_LANGUAGES = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'mermaid', label: 'Mermaid' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'sql', label: 'SQL' },
  { id: 'html', label: 'HTML' },
  { id: 'xml', label: 'XML' },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'less', label: 'Less' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'bash', label: 'Bash' },
  { id: 'shell', label: 'Shell' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'diff', label: 'Diff' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'lua', label: 'Lua' },
  { id: 'r', label: 'R' },
  { id: 'perl', label: 'Perl' },
  { id: 'makefile', label: 'Makefile' },
  { id: 'arduino', label: 'Arduino' },
  { id: 'objectivec', label: 'Objective-C' },
  { id: 'vbnet', label: 'Visual Basic' },
  { id: 'wasm', label: 'WebAssembly' },
  { id: 'ini', label: 'INI' },
  { id: 'php-template', label: 'PHP template' },
  { id: 'python-repl', label: 'Python REPL' },
] as const;

const KNOWN = new Set<string>(CODE_LANGUAGES.map((item) => item.id));

/**
 * Fence aliases mapped to the id stored when the user picks a language.
 * `html` stays its own entry: highlight.js already highlights it with the xml grammar.
 */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  javascriptreact: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  typescriptreact: 'typescript',
  py: 'python',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  htm: 'html',
  xhtml: 'html',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  golang: 'go',
  pl: 'perl',
  gql: 'graphql',
  mk: 'makefile',
  mmd: 'mermaid',
};

const MERMAID_LANGUAGES = new Set(['mermaid']);

/** `mermaid` and the `mmd` fence alias. */
export function isMermaidLanguage(language: unknown): boolean {
  if (typeof language !== 'string') return false;
  const resolved = resolveCodeLanguage(language);
  return resolved !== null && MERMAID_LANGUAGES.has(resolved);
}

/** Canonical highlight id, the original token when unknown, or null when empty. */
export function resolveCodeLanguage(language: string): string | null {
  const trimmed = language.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  const alias = ALIASES[key];
  if (alias) return alias;
  if (KNOWN.has(key)) return key;
  return trimmed;
}

/** Select value: empty string means auto-detect. */
export function codeLanguageValue(language: unknown): string {
  if (typeof language !== 'string') return '';
  return resolveCodeLanguage(language) ?? '';
}

type CodeAliasHost = {
  registerAlias: (aliases: Record<string, readonly string[]>) => void;
};

/** Aliases highlight.js common grammars do not register on their own. */
export function registerDocCodeAliases(lowlight: CodeAliasHost): void {
  lowlight.registerAlias({
    javascript: ['node', 'javascriptreact'],
    typescript: ['typescriptreact'],
    xml: ['htm'],
    plaintext: ['plain', 'mermaid', 'mmd'],
    objectivec: ['objective-c'],
  });
}

const TRANSLATED_LANGUAGE: Record<string, string> = {
  plaintext: 'editor.lang.plaintext',
  'php-template': 'editor.lang.phpTemplate',
};

/** Display label. Proper nouns stay as stored; plaintext, PHP template, and auto are catalog strings. */
export function codeLanguageLabel(id: string, fallback: string): string {
  if (id === '') return t('editor.lang.auto');
  const key = TRANSLATED_LANGUAGE[id];
  return key ? t(key) : fallback;
}

export function codeLanguageChoices(language: string | null | undefined): CodeLanguageChoice[] {
  const choices: CodeLanguageChoice[] = [
    { value: '', label: codeLanguageLabel('', '') },
    ...CODE_LANGUAGES.map((item) => ({ value: item.id, label: codeLanguageLabel(item.id, item.label) })),
  ];
  const extra = codeLanguageValue(language);
  if (extra !== '' && !choices.some((item) => item.value === extra)) {
    const label = language?.trim() || extra;
    choices.push({ value: extra, label });
  }
  return choices;
}

/** Label match, id prefix, or an exact fence alias such as `ts`. Case-insensitive. */
export function filterCodeLanguageChoices(
  choices: readonly CodeLanguageChoice[],
  query: string,
): CodeLanguageChoice[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...choices];
  const resolved = resolveCodeLanguage(q);
  return choices.filter((item) => {
    if (item.label.toLowerCase().includes(q)) return true;
    if (item.value.toLowerCase().startsWith(q)) return true;
    return resolved !== null && item.value === resolved;
  });
}
