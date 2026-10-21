# Stride UI design system

Stride is a local-first note workspace, not a marketing site. The interface should feel like a well-made desktop tool: quiet navigation, compact controls, readable dense information, and a generous paper-like editor. The editor is the only visually expressive surface; the surrounding chrome stays neutral and precise.

## Design principles

- **Content before chrome.** Use spacing, alignment, and subtle surface changes to create hierarchy. Do not wrap every region in a card.
- **One accent, used semantically.** Moss green marks selection, focus, and primary actions. It is not decorative.
- **Two voices.** Avenir Next/system sans for UI; Iowan Old Style/system serif for note titles and note body only.
- **Predictable interaction.** Every control has default, hover, active/selected, focus-visible, disabled, and (where relevant) destructive states.
- **Compact but comfortable.** Base spacing is 4px. Common controls are 32px high, dense controls 28px, and primary standalone actions 36px.
- **Accessible by default.** Keyboard focus is always visible, icon-only buttons have accessible names, overlays trap/restore focus, and reduced motion is respected.

## Core palette

| Token role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#F3F4F1` | `#171A18` | App background and navigation |
| Surface | `#FCFDFB` | `#202421` | Editor, inputs, raised surfaces |
| Elevated | `#FFFFFF` | `#272C28` | Menus, dialogs, popovers |
| Text | `#252A26` | `#EDF0EB` | Primary copy |
| Muted | `#697169` | `#9CA59C` | Secondary copy and inactive icons |
| Border | `#DDE1DA` | `#353C36` | Separators and control outlines |
| Accent | `#356854` | `#94BFA7` | Primary action, focus, selection |

Use semantic tokens (`--sd-bg`, `--sd-bg-elevated`, `--sd-fg`, `--sd-muted`, `--sd-border`, `--sd-accent`) rather than literal values. Add semantic derivatives for subtle hover, selected background, focus ring, danger, and overlays. Keep syntax, diff, mark, and note-type colors theme-aware.

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

Inputs have a visible bordered surface, 32px default height, 8px horizontal minimum padding, and a token-driven focus ring. `Input` keeps the existing optional-label wrapper pattern and supports hint/error content without changing native input behavior. Search fields may visually contain icons, but the input retains its accessible name.

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

Use the Radix-backed wrappers from `src/ui/primitives/tabs.tsx`: `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent`. They preserve Radix props, add `sd-tabs*` classes, and support icon + label content. Note editor tabs may keep their specialized close-button behavior but must use the same size, hover, selected, and focus tokens.

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
- Navigation selected state: accent-tinted surface and primary text; hover uses a weaker neutral surface.
- Note-list selected state: subtle accent surface, clear title, no heavy outline. Hover and selected must remain distinguishable.
- Editor tabs: 32–36px high, compact close affordance, active surface connected to the editor.
- Menus and dialog surfaces share border, radius, elevation, item height, and selected/hover treatment.
- Empty states explain the next useful action with concise copy and at most one primary action.

## Engineering rules

- Preserve service logic, virtualization row heights, command manifests, keyboard shortcuts, and existing `data-testid` attributes.
- No hard-coded colors in component CSS; consume semantic tokens.
- Avoid global element selectors for new component styles. Style shared classes explicitly and scope product-specific overrides.
- Do not add font downloads or external runtime dependencies for visual effects.
- Verify light and dark themes, keyboard focus, reduced motion, and narrow layouts.
