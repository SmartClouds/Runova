# E72 App shells and design system

Milestone: standalone (Mobile). Depends on: E69.

## Goal

Both apps launch into the same navigation with the same components, generated from the desktop's
own design tokens, with the harness that keeps them the same.

## Design

Tokens are generated from `apps/desktop/src/renderer/src/index.css` with a drift test. Fonts are
Inter and JetBrains Mono, bundled. Icons come from one generated FontAwesome solid set. Radius 10,
8 and 6, and the desktop's sizes and weights. Themes are light, dark and system.

## Tasks

- [x] T1 Token generator for Kotlin and Swift, drift test
- [x] T2 Fonts and generated icons
- [x] T3 Component kit on both OS: button, card, badge, input, list row, sheet, tabs, top bar,
  bottom bar, toast, empty state, skeleton
- [x] T4 Navigation shell and themes
- [ ] T5 Fixture format, Roborazzi and swift-snapshot-testing, Android and iOS comparison in CI
- [ ] T6 Memory measurement of the empty shell, and the final budgets

## Acceptance criteria

- AC1 Changing a token in `index.css` without regenerating fails a test.
- AC2 Every kit component has a fixture rendered on both OS, in light and dark, and the comparison
  passes.
- AC3 Budgets are recorded in `docs/mobile/architecture.md` from measured baselines.

## Not in this epic

Real data.
