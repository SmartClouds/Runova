# Website design

How the site at runovahq.com looks and moves. It should feel like the app: same accent and status
colors, same body font, same calm surfaces (a little lighter in Dark), with more room and a few
moments of motion that the app itself does not need. Specs: [E40W Website](../epics/40-website.md), [E42 Dashboard news](../epics/42-dashboard-news.md)
(the severity colors and badges are shared with the dashboard card).

## Themes

Dark is the default. Light is the other theme. The site follows `prefers-color-scheme` on the first
visit, and the header toggle remembers the visitor's choice in `localStorage` (key
`runova-theme`, values `dark` and `light`). An inline script in `<head>` sets the class before first
paint so there is never a flash of the wrong theme. The app's VS Code Dark and VS 2026 themes are
not offered on the site; they only appear in screenshots.

The tokens are HSL triplets, used as `hsl(var(--primary))` and exposed to Tailwind CSS 4 through an
`@theme inline` block exactly like `apps/desktop/src/renderer/src/index.css` does. The site defines
Light on `:root, .theme-light` and Dark on `.dark`, with the same names as the app. A unit test
(T011) reads the app's `index.css` and fails when any value differs, except the Dark surfaces
below, so the site can never drift from the app by accident.

In Dark the site uses a lighter, slightly cool charcoal for its surfaces than the app's near black,
because a page made for reading is heavy on `0 0% 4%`. The test checks that each site value stays
lighter than the app's and that page, card, raised surface and border keep that order. Everything
else in Dark (foreground, accents, status colors) is the app's.

| Surface token | Site Dark | App Dark |
|---|---|---|
| `--background` | `220 10% 9%` | `0 0% 4%` |
| `--card` | `220 9% 13%` | `0 0% 11%` |
| `--popover` | `220 9% 13%` | `0 0% 10%` |
| `--secondary`, `--muted` | `220 8% 16%` | `0 0% 15%` |
| `--muted-foreground` | `220 6% 68%` | `0 0% 62%` |
| `--accent` | `220 8% 19%` | `0 0% 18%` |
| `--border`, `--input` | `220 8% 21%` | `0 0% 17%` |

The app's tokens:

| Token | Dark | Light |
|---|---|---|
| `--background` | `0 0% 4%` | `0 0% 96%` |
| `--foreground` | `0 0% 95%` | `0 0% 9%` |
| `--card` | `0 0% 11%` | `0 0% 91%` |
| `--card-foreground` | `0 0% 95%` | `0 0% 9%` |
| `--popover` | `0 0% 10%` | `0 0% 94%` |
| `--popover-foreground` | `0 0% 95%` | `0 0% 9%` |
| `--primary` | `150 100% 45%` | `150 100% 23%` |
| `--primary-foreground` | `0 0% 4%` | `0 0% 100%` |
| `--secondary` | `0 0% 15%` | `0 0% 88%` |
| `--secondary-foreground` | `0 0% 95%` | `0 0% 12%` |
| `--muted` | `0 0% 15%` | `0 0% 88%` |
| `--muted-foreground` | `0 0% 62%` | `0 0% 40%` |
| `--accent` | `0 0% 18%` | `0 0% 84%` |
| `--accent-foreground` | `0 0% 95%` | `0 0% 12%` |
| `--destructive` | `4 72% 60%` | `4 78% 41%` |
| `--destructive-foreground` | `0 0% 4%` | `0 0% 100%` |
| `--success` | `150 100% 42%` | `150 100% 22%` |
| `--success-foreground` | `0 0% 4%` | `0 0% 100%` |
| `--warning` | `38 92% 50%` | `38 92% 27%` |
| `--warning-foreground` | `30 40% 10%` | `0 0% 100%` |
| `--border` | `0 0% 17%` | `0 0% 83%` |
| `--input` | `0 0% 17%` | `0 0% 83%` |
| `--ring` | `150 100% 45%` | `150 100% 23%` |
| `--radius` | `0.625rem` | `0.625rem` |

`--radius` is declared once in the app (on `:root`), so Dark inherits it. Derived radii follow the
app: `--radius-lg` is `var(--radius)`, `--radius-md` is 2px less and `--radius-sm` is 4px less.

The site adds tokens of its own only for things the app does not have, and only these:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--glow` | `150 100% 45%` | `150 100% 23%` | The light behind the hero workspace, the download card and the card spotlight (same as primary, kept separate so effects can be tuned without touching UI) |

### Severity colors

Used for news severity on the site (T019) and on the dashboard card (T024). Severity is never shown
by color alone: every level has its own icon (lucide) and its label in text. Each color below meets
WCAG AA (4.5:1 or more) as text and icon color on `--background`, `--card` and `--muted` in its
theme; the lowest ratio is given, measured on the site's surfaces (the app's darker Dark surfaces
only raise it). The badge is the color as text and icon on a 12% tint of the same
color, with a 1px border at 30%.

| Level | Icon | Label | Dark | Light | Lowest contrast (Dark / Light) |
|---|---|---|---|---|---|
| `info` | `Info` | Info | `210 90% 66%` | `212 85% 34%` | 5.93 / 5.85 |
| `low` | `ShieldCheck` | Low | `185 70% 48%` | `190 90% 24%` | 6.84 / 5.31 |
| `medium` | `ShieldAlert` | Medium | `38 92% 50%` | `38 92% 27%` | 6.93 / 4.83 |
| `high` | `TriangleAlert` | High | `24 95% 58%` | `22 90% 32%` | 5.76 / 5.17 |
| `critical` | `OctagonAlert` | Critical | `4 90% 67%` | `4 78% 38%` | 5.04 / 5.37 |

Tokens: `--severity-info`, `--severity-low`, `--severity-medium`, `--severity-high`,
`--severity-critical`. The site's token parity test skips these (the app gains the same values in
T024, and from then on the test compares them too).

Category chips use the neutral `--secondary` surface with a lucide icon per category: `security`
`Shield`, `release` `Tag`, `deprecation` `Archive`, `end-of-life` `CalendarX`, `ai` `Sparkles`,
`tooling` `Wrench`, `industry` `Newspaper`.

## Typography

All fonts are self-hosted through Fontsource packages (no request to a font CDN, so the CSP stays
`font-src 'self'`). Only the Latin subset is preloaded; other subsets load through `unicode-range`.

| Role | Family | Package | Weights | Author |
|---|---|---|---|---|
| Body and UI | Inter Variable | `@fontsource-variable/inter` | 100 to 900 | Rasmus Andersson (the same package the app uses) |
| Display (headlines, hero, big numbers) | Bricolage Grotesque Variable | `@fontsource-variable/bricolage-grotesque` | 200 to 800 | Mathieu Triay |
| Mono (code, commands, versions) | JetBrains Mono Variable | `@fontsource-variable/jetbrains-mono` | 100 to 800 | JetBrains |

- Stacks: body `"Inter Variable", system-ui, sans-serif`; display `"Bricolage Grotesque Variable",
  "Inter Variable", system-ui, sans-serif`; mono `"JetBrains Mono Variable", ui-monospace,
  SFMono-Regular, Menlo, Consolas, monospace`.
- Body text is 16px with a 1.6 line height, at most about 70 characters per line. Headlines use the
  display face at 600 to 700 with tight tracking (`-0.02em`), set with `clamp()` so they scale from
  phone width to desktop without breakpoints.
- `font-display: swap` for body and mono, `optional` for the display face, so a slow font never
  moves the hero text (CLS budget in T014).
- Numbers in tables, versions and sizes use `font-variant-numeric: tabular-nums`.

## Layout and surfaces

- Content width 1200px with a 16px side gutter on phones and 24px from 768px up. No horizontal
  scroll at 320px wide.
- Surfaces are flat: `--card` on `--background` with a 1px `--border`, `--radius` corners, and no
  drop shadows except on popovers, the sticky header (a 1px border plus a backdrop blur), and the
  soft `--glow` light under the hero workspace and the home page screenshots.
- Screenshots sit in a frame that matches the app window (rounded corners, a thin border, the title
  bar visible), always with width and height set and real alt text from the manifest.
- Links are never underlined. A link in running text is `--primary` at weight 500 (the `link`
  utility in `global.css`), so the weight sets it apart from the words around it without relying on
  color alone, and it turns `--foreground` on hover. Secondary links (feeds, footer columns, "clear
  filters") use `link-muted`. A card that is one big link shows focus as a ring around the card.
  `tests/noUnderline.test.ts` fails on any underline class or rule in `src/`. Buttons follow
  shadcn/ui's default and outline variants restyled with the tokens above.
- Focus is always visible: a 2px `--ring` outline with a 2px offset, never removed.

## Effects

Effects are there to show what the app does, not to decorate. A page has at most one strong effect
(the hero on the home page, nothing as strong elsewhere), and every effect must keep the Lighthouse
budgets in T014 and T022. The home page loads no framework, so effects are plain CSS and small
TypeScript modules in `src/components/effects/` and `src/components/home/`, with no runtime
dependency on the library that inspired them. When a component's source is copied in rather than
written from scratch, the task first checks its license and author against the working rules in
[E40W](../epics/40-website.md#working-rules) and records the source URL and license in a comment at
the top of the file. Each file names the library its idea came from either way.

The home page hero is a Runova workspace drawn in HTML and CSS (`HeroDemo.astro`, with the run in
`src/lib/heroDemo.ts`): four panes play one short scripted run. Claude Code finishes, Codex stops to
wait for approval, Gemini writes docs and a shell reruns the tests, while the status bar counts
agents, tokens and cost. The server renders the finished run, and `heroDemo.ts` replays it once when
the hero is first on screen. Its states on `[data-hero]` are `idle`, `playing` and `done`.

| Source | What it is | Used for |
|---|---|---|
| [shadcn/ui](https://ui.shadcn.com) | Radix-based React components | Every interactive control: admin forms, dialogs, the theme toggle, filters, tooltips, toasts |
| [React Bits](https://reactbits.dev) (David Haz) | Animated React components | The idea for the hero's rising headline, the one-time scroll reveals and the token count-up |
| [transitions.dev](https://transitions.dev) (Jakub Antalik) | Plain CSS transition snippets | Hover and press states (the header's hover pill, arrow nudges, the copy button), view transitions between pages |
| [beUI](https://github.com/starc007/ui-components) (Saurabh Chauhan) | shadcn registry components | The hover spotlight on the home page's "Why an ADE" cards; allowed for the features index cards and the download page platform picker too |
| [RareUI](https://rareui.in) (Codewithswappy) | React effect components | The one marquee of the supported AI CLIs on the home page |
| [Beautiful UI](https://beautifului.dev) | Component site | Not used until a task checks its author and license against the working rules |

Not allowed anywhere: scroll hijacking, parallax on text, cursor followers, autoplaying video with
sound, effects inside the admin area (it uses shadcn/ui only), and anything that moves while the
visitor reads body text.

## Motion

- Durations: 120ms for hover and press, 200ms for menus, sheets and toasts, 300ms for page view
  transitions, up to 800ms for a one-time entrance on the home page. Easing
  `cubic-bezier(0.2, 0, 0, 1)` for entrances and `cubic-bezier(0.4, 0, 1, 1)` for exits.
- Animate only `transform` and `opacity` (and `filter` for the hero glow). Never animate layout
  properties.
- Entrances run once, when the element first scrolls into view, and never again on the same page.
- The hero's run plays once, for about six seconds, and never again on the same page.
- Nothing loops forever except the agent CLI marquee, which pauses under the pointer or keyboard
  focus, and the shimmer of a loading state.

### Reduced motion

With `prefers-reduced-motion: reduce`:

- One global rule sets `animation: none` and `transition: none` on every element and pseudo-element,
  and turns off view transitions (`@view-transition { navigation: none; }`). T011 checks computed
  styles with Playwright.
- The hero shows the finished run at once (`data-state="done"`) and nothing in it moves.
- Count-ups show their final number, text reveals show the full text, the marquee is a static
  wrapped list.
- Smooth scrolling is off (`scroll-behavior: auto`).

Color changes on hover still happen, but instantly.
