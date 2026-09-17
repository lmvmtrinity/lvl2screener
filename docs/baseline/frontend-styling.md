# Frontend styling conventions

Implemented state as of September 15, 2026. This covers the Tailwind CSS and shared
component migration in `apps/web`; it is not a redesign and does not change product
behavior. Every mounted surface now uses `tw:` utilities and the shared components;
the retained legacy CSS is small and justified at the end of this document.

## Entry points and cascade ownership

- `apps/web/src/styles/globals.css` is the single stylesheet imported by
  `apps/web/src/main.tsx`. It declares the cascade layer order, imports Tailwind,
  imports the four retained legacy files and owns the shared state-badge chrome.
- Layer order is `theme, base, legacy, components, utilities` (low to high precedence).
  Put shared CSS that is still needed into `components`; never leave new author CSS
  unlayered, because unlayered rules beat every layer.
- Tailwind is imported selectively so Preflight stays disabled and `base.css` remains
  the reset: `@import "tailwindcss/theme.css" layer(theme) prefix(tw);` plus the
  utilities import. The `tw` prefix is part of every utility class.

## Tokens and theme aliases

- Values live in `apps/web/src/tokens.css` (`:root`). Change a color, radius or font
  there.
- `globals.css` maps those values into Tailwind theme names with `@theme inline`, for
  example `--color-surface: var(--surface)` and `--radius-panel: var(--radius-card)`.
  Utilities use them as `tw:bg-surface`, `tw:rounded-panel`, `tw:text-ink-400`.
- Do not create self-referencing aliases when names coincide
  (`--radius-card: var(--radius-card)`); add a distinct theme name instead.
- Breakpoints: `--breakpoint-sm: 480px`, `--breakpoint-md: 760px`,
  `--breakpoint-lg: 1050px` (the default Tailwind scale is cleared). Tailwind's `max-*`
  variants are exclusive, so every inclusive legacy boundary has a custom variant:
  `below-1100`, `below-lg` (1050), `below-1000`, `below-980`, `below-960`, `below-900`,
  `below-md` (760), `below-720`, `below-700`, `below-620`, `below-560`, `below-520`,
  `below-sm` (480). Use them as `tw:below-md:px-[14px]`.

## Writing styles

- Use `tw:` utilities in JSX for layout, spacing, typography and one-off presentation.
  Preflight is off, so provide reset behavior explicitly: `tw:m-0` on headings, borders
  need a color class, and form controls inherit only from `base.css` element rules.
- Never build class names dynamically (`bg-${tone}` never generates CSS). Use typed
  maps with complete class strings, as in `components/ui/Button.tsx`.
- Never assume the last class in a JSX string wins. Two utilities that set the same
  declaration are resolved by stylesheet order, not by JSX order. Prefer a component
  prop (`tone`, `variant`, `align`) over passing a conflicting override class. A legacy
  `font:` shorthand sets family/size/weight/line-height at once, so a migrated element
  needs `tw:font-mono`, `tw:text-[...]`, `tw:font-*` and `tw:leading-[...]` together.
- Keep classes out of `${...}` adjacency in template literals; Tailwind's scanner can
  miss a class immediately followed by an interpolation. Use `classes()` from
  `lib/classes.ts` to join class strings.
- Keep genuinely local CSS (complex descendant selectors, charts, animations) beside
  its owner inside `@layer components`, and document why it remains.

## Shared components

`apps/web/src/components/ui/` owns repeated visual patterns:

| Component                                                  | Use                                                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button.tsx`                                               | Native button with `primary`/`secondary`/`segmented`/`tab`/`profile`/`nav`/`control`/`link` variants; defaults to `type="button"`, forwards refs/submits |
| `Panel.tsx` (`PanelHeader`, `PanelMeta`)                   | Card surface, header layout, heading level, description/`descriptionClassName`, trailing actions; `tone`, `emphasis` and `divider` are explicit variants |
| `StatusBadge.tsx`                                          | Label plus `ok`/`warn`/`danger`/`neutral`/`muted` tone; `size="header"` matches panel-header typography, `default` matches table badges                  |
| `FactList.tsx` (`FactList`, `Fact`)                        | Two-column label/value lists used by card bodies                                                                                                         |
| `Text.tsx`                                                 | Paragraph copy with `body`/`note`/`danger` variants                                                                                                      |
| `Chip.tsx`                                                 | Small bordered status chip used by the automation strips                                                                                                 |
| `FormField.tsx` (`FormField`, `FieldSelect`, `FieldInput`) | Filter/form label and control presentation                                                                                                               |

Existing `ui.tsx` exports (`Tip`, `Popover`, `Drawer`, `CopyButton`) keep Floating UI
and their interactions; their presentation now comes from utilities in the component.

`stateClass()` in `lib/format.ts` still emits `badge badge-<state>`; the shared badge
chrome lives in `globals.css`. New status labels should prefer `StatusBadge`.

## Verification

Use the existing behavior tests plus screenshots:

```powershell
pnpm --filter @tsx-scanner/contracts build
pnpm --filter @tsx-scanner/web test
pnpm visual:fixtures
pnpm visual:screenshots
node scripts/visual/compare-shots.mjs <baseline-dir> scripts/visual/shots
```

Compare captures against a preserved pre-change set and inspect layout/error evidence;
a successful capture run is not a visual comparison. The harness anchors fixture data
and the browser clock to one fixed in-session time and disables animations and
transitions during capture, so two runs of the same state produce byte-identical PNGs.
The default matrix is `SCANNER`, `DETAIL`, `DAILY`, `DISCOVERY`, `BOT`, `PERFORMANCE`,
`LEARNING`, `LAB`, `BACKTESTS`; add fixture-backed coverage or a reproducible manual
check for surfaces and states it does not reach. `DETAIL` walks through the first
Scanner row and back. `DAILY` expands a warm-up timeline and submits a paste report.
`SCANNER` can open the alert popover; `--with-toast` additionally captures the toast
stack. `LAB` opens the editor and runs a comparison. `BACKTESTS` opens Results,
History, a selected result, the manual replay drawer and the automation settings
drawer. `BOT` opens Results and Diagnostics; `PERFORMANCE` switches projection.

## Migration status and retained CSS

All mounted surfaces are migrated: Scanner board/profile tabs/alerts, Detail, Daily
List, Discovery, Strategy Lab, Backtests and its automation/study/funded-replay/evidence
panels, Bot/Performance/diagnostics, Learning and the shared overlays/toasts. Retired
stylesheets: `discovery.css`, `alerts.css`, `overlays.css`, `profiles.css`,
`universe.css`, `scanner.css`, `backtests.css`, `journal.css`, `bot.css`,
`learning.css`, `header.css`, `calibration.css`, `models.css` and `responsive.css`.
`CalibrationView.css` / `ModelsView.css` moved beside the unmounted views, which are
not routes.

Retained legacy CSS (each with a named owner and reason):

| File          | Owner / reason                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`  | Theme values themselves; the source for the Tailwind aliases.                                                                                                                                                              |
| `base.css`    | Reset, page frame and shared element rules (`main` breakpoint, headings, `.error-banner`, `.context-list`).                                                                                                                |
| `panels.css`  | Shared `.panel`/`.panel-title` chrome still carried as hooks by active Bot/Backtests/Detail elements and needed by the unmounted Calibration/Models views; `.positive`/`.negative` tones; `.candidate-table` scroll owner. |
| `detail.css`  | Shared `.empty`/`.chart-empty`/`.loading` states and the SVG chart scroll container (SVG geometry is not utility-friendly).                                                                                                |
| `globals.css` | Entry point plus the shared `stateClass()` badge chrome (base and state tones merged from the retired panels/learning rules).                                                                                              |

Hard class-name contracts that must survive further refactors:
`lib/captured-history.ts` queries `.backtest-form`, `.run-backtest`,
`.backtest-metrics` and `.calibration-recommendation`; unit tests pin
`tone-*`/`bot-glance`/`bot-dot`/`bot-cohort`/`bot-quality` classes; e2e specs pin
`.system-pill`, `.error-banner`, `.nav-bot-status`, `.universe-health`,
`.universe-run`, `.candidate-table .operator-row`, `.profile-row`, `.bot-dot`,
`.bot-cohort`, `.bot-quality`; data-testids and `aria-*` are behavior contracts.

The migration was closed as a completed implementation package on September 15, 2026. Its acceptance criteria and dated verification live in
the Tailwind completion record.
