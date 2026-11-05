# Stride skill CLI implementation plan

**Goal:** Distribute `skills/stride/` as a self-contained external-agent editing tool.
**Architecture:** A Node.js CLI and local modules use only built-in modules. No repository imports, npm dependencies, generated bundles, server, or network. Existing TipTap JSON is modified in place structurally.
**Runtime:** Node.js 18+ must be installed by the recipient; no platform-specific runtime is bundled.

## Scope and decisions

- Read/list notes; expose revision hashes and readable node references.
- Replace a unique text occurrence in one text leaf, retaining marks. Reject replacements crossing formatting boundaries rather than flattening content.
- Insert plain paragraphs, delete selected blocks with rich-content protection, and batch operations against one snapshot. Markdown parsing is outside this initial dependency-free interface; text input is literal.
- Add/remove/list property relations using explicit target IDs, title-first resolution compatible with core, and ambiguity detection. Derived relations are never persisted.
- All writes require the original revision. Validate, preview, use a cooperative lock, recheck source and relation catalog, atomically replace and read back. The editor does not honor the script lock, so simultaneous editor writes must be avoided.

## Tasks

- [x] Add `skills/stride/scripts/stride.test.mjs` CLI integration tests; run them before implementation.
- [x] Add `scripts/lib/document.mjs` for validation, node references and non-destructive editing, `scripts/lib/relations.mjs` for relation resolution, and `scripts/lib/vault.mjs` for bounded file access and persistence.
- [x] Add `scripts/stride.mjs` CLI with JSON output/errors, strict argument handling, single-note batch operations, and `--dry-run`.
- [x] Verify preservation of unknown nodes, marks and metadata; stale revisions; stable references within batches; atomic rejection; relation aliases/duplicates/ambiguity; path traversal/symlinks; lock conflicts.
- [x] Update SKILL.md and add `references/cli.md` with distributable layout, prerequisites, examples and limits.
- [x] Copy the skill to a temporary directory and run its tests there, independent of repository files and dependencies. Run skill validation and diff checks; obtain an independent review.

## Verification commands

`node --test skills/stride/scripts/stride.test.mjs`

`python3 /Users/ximing/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/stride`

`git diff --check`

## Results

- 14 portable CLI tests pass, including when the whole skill is copied outside the repository.
- Independent review identified H1 wikilink alias/target mismatch; regression reproduced and fixed to match core.
- Self-review regressions fixed: missing option value swallowing dry-run; nonexistent relation removal altering empty entries.
- Skill format, reference links, JSON examples, import containment and diff whitespace checks pass.
- `pnpm test` passes under the project login environment (Node 24.14.0), including all 738 desktop tests. An earlier non-login Node 26.7.0 run had 274 desktop failures, predominantly unavailable localStorage; no application code was changed to address that environment difference.
- Runtime is external Node.js 18+; all JavaScript dependencies are bundled or Node built-ins. New text insertion is literal, not Markdown. The CLI has no persistent undo and cannot lock the editor; both limits are documented.
