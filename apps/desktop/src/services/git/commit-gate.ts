import { t } from '../../i18n'

const MAX_OUTPUT = 8_000

/** Checker lines from a vault commit hook, including `ERROR path.stride.json: …`. */
const CHECK_LINE = /^(?:ERROR|WARN|WARNING)\s+\S/m
const CHECK_SUMMARY = /\d+\s+error\(s\)|\d+\s+warning\(s\)|\d+\s+errors?\b/i
const HOOK = /pre-commit|commit-msg|pre-push|hook (?:declined|failed|exited)|husky|lefthook/i

/** True when git output is a commit hook or note check, not a transport or setup error. */
export function isCommitGateOutput(output: string): boolean {
  const text = output.trim()
  if (!text) return false
  if (HOOK.test(text)) return true
  if (CHECK_LINE.test(text) && (CHECK_SUMMARY.test(text) || /\.stride\.json/.test(text))) return true
  return false
}

export function commitGatePrompt(output: string): string {
  const text = output.trim()
  const clipped = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text
  return t('git.solveGatePrompt', { output: clipped })
}

export function startCommitGateFix(
  output: string,
  deps: {
    running: boolean
    ask: (text: string) => void | Promise<void>
    openChat: () => void
  },
): void {
  if (deps.running || !isCommitGateOutput(output)) return
  deps.openChat()
  void deps.ask(commitGatePrompt(output))
}
