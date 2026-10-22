# Stride UI design system

Stride is a local-first note workspace, not a marketing site. The interface should feel like a well-made desktop tool: quiet navigation, compact controls, readable dense information, and a generous paper-like editor. The editor is the only visually expressive surface; the surrounding chrome stays neutral and precise.

The working metaphor is the writing desk (案头纸墨): the note page is the protagonist, and the tools around it recede. Four laws follow from it.

## Design principles

- **Content before chrome.** Use spacing, alignment, and subtle surface changes to create hierarchy. Do not wrap every region in a card.
- **Three planes, no boxes.** Plane 0 is the workbench (`--sd-bg`: rails, strips, tool rows); plane 1 is paper (`--sd-surface`: reading/writing surfaces); plane 2 is floating (`--sd-bg-elevated`: transient overlays and raised thumbs only). Controls never get their own white boxes — inputs are carved into the workbench with `--sd-inset` (a 4–6% foreground tint), a transparent border, and on focus they rise to paper with an accent ring.
- **Tonal steps, not hairlines.** Neighboring planes are separated by their luminance step alone. No 1px rules between columns, under header bands, atop the status bar, or beneath the editor toolbar — whitespace and plane changes do the work. Borders are reserved for floating layers (menus, dialogs, toasts), in-document structure (tables, callouts, code blocks), and control outlines.
- **One accent, used semantically.** Moss green is ink: it marks the single primary action per view, focus rings, wikilinks, and active icon marks. It is never decorative, never large fills, never green text on a green tint.
- **Two voices.** Avenir Next/system sans for UI; Iowan Old Style/system serif for note titles, note body, and the Stride wordmark — the brand reads as a publication name.
- **Predictable interaction.** Every control has default, hover, active/selected, focus-visible, disabled, and (where relevant) destructive states.
- **Compact but comfortable.** Base spacing is 4px. Common controls are 32px high, dense controls 28px, and primary standalone actions 36px.
- **Accessible by default.** Keyboard focus is always visible, icon-only buttons have accessible names, overlays trap/restore focus, and reduced motion is respected.

## Core palette

| Token role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#EBEDE6` | `#171A18` | App background and navigation rail (plane 0) |
| Nav list | `#F0F1EA` | `#1C201D` | Note-list column: half step up from canvas so the two nav columns separate without a hairline |
| Surface | `#F4F5EF` | `#202421` | Editor, paper, focused inputs (plane 1) |
| Elevated | `#FAFBF7` | `#272C28` | Menus, dialogs, segmented thumbs (plane 2) |
| Text | `#252A26` | `#EDF0EB` | Primary copy |
| Muted | `#697169` | `#9CA59C` | Secondary copy and inactive icons |
| Border | `#D9DDD3` | `#353C36` | Floating-layer edges and in-document structure |
| Accent | `#356854` | `#94BFA7` | Primary action, focus, selection |

Use semantic tokens (`--sd-bg`, `--sd-bg-elevated`, `--sd-fg`, `--sd-muted`, `--sd-border`, `--sd-accent`) rather than literal values. `--sd-inset` / `--sd-inset-hover` are the resting/hover fills for embedded controls (inputs, segmented tracks). Keep syntax, diff, mark, and note-type colors theme-aware.

## Type, spacing, shape, motion

- UI font: `"Avenir Next", Avenir, "Segoe UI", sans-serif`.
- Note font: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`.
- Mono: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`.
- UI scale: 12px metadata, 13px dense controls, 14px default UI, 16px section title, 20px dialog title, 32–36px note title.
- Spacing tokens follow 4 / 8 / 12 / 16 / 20 / 24 / 32px.
- Radius tokens: 6px controls, 8px panels and menus, 12px dialogs. Pills are reserved for badges and compact status indicators.
- Use `--sd-shadow-sm` for menus/popovers and `--sd-shadow-lg` for dialogs. Shadows should be subtle in light mode and stronger only where dark-mode layering needs them.
- Motion: 120ms hover/color, 160ms menus, 180ms dialogs. Animate opacity and transform only; disable nonessential animation under `prefers-reduced-motion`.
- Focus: a 2px accent ring with a 2px offset, plus a non-color selected indicator where selection is persistent.

## Shared component contracts

Shared primitives live in `src/ui/primitives` and use the `sd-` prefix. Feature panels live in their own directories under `src/ui`. Existing test IDs and accessible behavior must remain stable.

### Button

`Button` supports `tone="primary" | "secondary" | "quiet" | "danger"`, `size="sm" | "md" | "lg"`, and optional `icon`. `secondary` is the default bordered action; `quiet` is borderless until hover; `danger` is reserved for destructive actions. `IconButton` accepts a Lucide icon and an accessible `label`, plus `active` for persistent selected state.

### Input and Textarea

Inputs are embedded in the workbench, not boxed: `--sd-inset` fill, transparent border, 32px default height, 8px horizontal minimum padding. On hover the fill deepens (`--sd-inset-hover`); on focus the control rises to paper (`--sd-surface`) with an accent border/ring. `Input` keeps the existing optional-label wrapper pattern and supports hint/error content without changing native input behavior. Search fields may visually contain icons, but the input retains its accessible name.

### Select

Use the Radix-backed `Select` from `src/ui/primitives/select.tsx`, not a raw native `<select>` in product UI. Its simple options API is:

```tsx
<Select
  label="Type"
  value={value}
  onValueChange={setValue}
  options={[{ value: 'note', label: 'Note' }]}
  data-testid="example-select"
/>
```

Unknown trigger props such as `data-testid`, `aria-label`, `id`, and `className` apply to the trigger. It also supports `placeholder` and `disabled`. The content uses Lucide chevron/check icons, keyboard navigation, and the shared menu visual language.

### Tabs

Use the Radix-backed wrappers from `src/ui/primitives/tabs.tsx`: `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent`. Two idioms, chosen by metaphor:

- **Panel-switch tabs** (the default `sd-tabs*` styling): a quiet text row, the active item marked by a crisp 2px accent underline and primary text. No pills, no inset shadow edges, no hairline under the row.
- **Value pickers** (chat session tabs, agent mode): the track-and-thumb segmented idiom — an `--sd-inset` track with 2px padding, the selected thumb raised to `--sd-bg-elevated` with a crisp 1px ambient shadow and primary text. Inactive items are muted text only.

Note editor tabs are quiet pills centered in the strip: the active pill takes the editor paper surface, so it reads as the page's label without corner notches or a strip hairline. Same size, hover, selected, and focus tokens as other tabs.

### Dialog, Menu, Toast, Tooltip

Use the existing Radix wrappers (`Modal`, `Menu`, `Notice`, `Tooltip`) rather than creating new overlay behavior. `ModalContent` owns title, description, close control, overlay, focus management, and size. Use `ModalClose asChild` with `Button` for footer actions. Editor prompt/link dialogs must use this same primitive. Never call `window.alert`, `window.prompt`, or `window.confirm`.

### Icons

All new and migrated UI icons come from `lucide-react`, rendered through `Mark` or directly when a primitive requires it. Use 16px for common controls, 14px for dense/status UI, 18–20px for empty states. Stroke width is consistent. Do not use `+`, `×`, `▸`, `▾`, `✓`, or emoji as standalone UI icons; text may still contain those characters when they are actual content.

## Layout and state treatment

```text
┌──────────────────── top bar: identity / vault / search ───────────────────┐
│ navigation rail │ note list │ tabs + centered paper editor │ inspector  │
│  compact groups │ filters   │ generous readable measure    │ tabs/forms │
├────────────────────────────── quiet status bar ────────────────────────────┤
```

- Align headers and control baselines across columns. Avoid arbitrary vertical gaps.
- Navigation selected state: accent-tinted surface and primary text; hover uses a weaker neutral surface. Never a solid accent edge bar — selection is expressed by tint, weight, and accent icon color only.
- Row-level actions (add instance, edit view) stay hidden until their row is hovered or focus lands inside it; persistent state affordances (collapse chevrons) stay visible.
- Note-list selected state: subtle accent surface, clear title, no heavy outline. Hover and selected must remain distinguishable.
- Editor tabs: 32–36px high, compact close affordance, active surface connected to the editor.
- Menus and dialog surfaces share border, radius, elevation, item height, and selected/hover treatment.
- Empty states pair a quiet inset icon disc with a serif title, explain the next useful action with concise copy, and offer at most one primary action.

## Engineering rules

- Preserve service logic, virtualization row heights, command manifests, keyboard shortcuts, and existing `data-testid` attributes.
- Keep component CSS next to the component. `src/styles/` holds only the global base (reset, scrollbars, bare inputs) and the workspace column grid.
- No hard-coded colors in component CSS; consume semantic tokens.
- Avoid global element selectors for new component styles. Style shared classes explicitly and scope product-specific overrides.
- Do not add font downloads or external runtime dependencies for visual effects.
- Verify light and dark themes, keyboard focus, reduced motion, and narrow layouts.
