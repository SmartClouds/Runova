# Website design

How the site at runovahq.com looks and moves. It should feel like the app: same accent and status
colors, same body font, same calm surfaces (a little lighter than the app's Dark), with more room and a few
moments of motion that the app itself does not need. Specs: [E40W Website](../epics/40-website.md), [E42 Dashboard news](../epics/42-dashboard-news.md)
(the severity colors and badges are shared with the dashboard card).

## Themes

The site is Dark only. There is no theme toggle, no theme script and no Light palette; it ignores
`prefers-color-scheme`. `<html>` always carries the `dark` class (so any `dark:` utility applies)
and the page declares `color-scheme: dark`. The app's other themes (Light, VS Code Dark and VS 2026)
only appear in screenshots.

The tokens are HSL triplets, used as `hsl(var(--primary))` and exposed to Tailwind CSS 4 through an
`@theme inline` block exactly like `apps/desktop/src/renderer/src/index.css` does. The site defines
its one palette on `:root`, with the same names and values as the app's Dark. A unit test (T011)
reads the app's `index.css` and fails when any value differs, except the Dark surfaces below, so the
site can never drift from the app by accident.

The site uses a lighter, slightly cool charcoal for its surfaces than the app's near black,
because a page made for reading is heavy on `0 0% 4%`. The test checks that each site value stays
lighter than the app's and that page, card, raised surface and border keep that order. Everything
else (foreground, accents, status colors) is the app's Dark.

| Surface token | Site Dark | App Dark |
|---|---|---|
| `--background` | `220 10% 9%` | `0 0% 4%` |
| `--card` | `220 9% 13%` | `0 0% 11%` |
| `--popover` | `220 9% 13%` | `0 0% 10%` |
| `--secondary`, `--muted` | `220 8% 16%` | `0 0% 15%` |
| `--muted-foreground` | `220 6% 68%` | `0 0% 62%` |
| `--accent` | `220 8% 19%` | `0 0% 18%` |
| `--border`, `--input` | `220 8% 21%` | `0 0% 17%` |

The app's Dark tokens:

| Token | Dark |
|---|---|
| `--background` | `0 0% 4%` |
| `--foreground` | `0 0% 95%` |
| `--card` | `0 0% 11%` |
| `--card-foreground` | `0 0% 95%` |
| `--popover` | `0 0% 10%` |
| `--popover-foreground` | `0 0% 95%` |
| `--primary` | `150 100% 45%` |
| `--primary-foreground` | `0 0% 4%` |
| `--secondary` | `0 0% 15%` |
| `--secondary-foreground` | `0 0% 95%` |
| `--muted` | `0 0% 15%` |
| `--muted-foreground` | `0 0% 62%` |
| `--accent` | `0 0% 18%` |
| `--accent-foreground` | `0 0% 95%` |
| `--destructive` | `4 72% 60%` |
| `--destructive-foreground` | `0 0% 4%` |
| `--success` | `150 100% 42%` |
| `--success-foreground` | `0 0% 4%` |
| `--warning` | `38 92% 50%` |
| `--warning-foreground` | `30 40% 10%` |
| `--border` | `0 0% 17%` |
| `--input` | `0 0% 17%` |
| `--ring` | `150 100% 45%` |
| `--radius` | `0.625rem` |

`--radius` is declared once in the app (on `:root`), so Dark inherits it; the site declares it on
its `:root` with the rest. Derived radii follow the
app: `--radius-lg` is `var(--radius)`, `--radius-md` is 2px less and `--radius-sm` is 4px less.

The site adds tokens of its own only for things the app does not have, and only these:

| Token | Value | Use |
|---|---|---|
| `--glow` | `150 100% 45%` | The hero beam, the light behind the hero workspace, the download card and the card spotlight (same as primary, kept separate so effects can be tuned without touching UI) |

### Severity colors

Used for news severity on the site (T019) and on the dashboard card (T024). Severity is never shown
by color alone: every level has its own icon (lucide) and its label in text. Each color below meets
WCAG AA (4.5:1 or more) as text and icon color on `--background`, `--card` and `--muted`; the
lowest ratio is given, measured on the site's surfaces (the app's darker Dark surfaces
only raise it). The badge is the color as text and icon on a 12% tint of the same
color, with a 1px border at 30%.

| Level | Icon | Label | Color | Lowest contrast |
|---|---|---|---|---|
| `info` | `Info` | Info | `210 90% 66%` | 5.93 |
| `low` | `ShieldCheck` | Low | `185 70% 48%` | 6.84 |
| `medium` | `ShieldAlert` | Medium | `38 92% 50%` | 6.93 |
| `high` | `TriangleAlert` | High | `24 95% 58%` | 5.76 |
| `critical` | `OctagonAlert` | Critical | `4 90% 67%` | 5.04 |

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
- Surfaces are flat: `--card` on `--background` with a 1px `--border`, box corners (see Shapes), and no
  drop shadows except on popovers, the sticky header and its menu (glass: a backdrop blur, a hairline
  and, on the menu, a soft shadow), and the
  soft `--glow` light under the hero workspace and the home page screenshots, and the open download
  menu.
- Screenshots sit in a frame that matches the app window (rounded corners, a thin border, the title
  bar visible), always with width and height set and real alt text from the manifest.
- Links are never underlined. A link in running text is `--primary` at weight 500 (the `link`
  utility in `global.css`), so the weight sets it apart from the words around it without relying on
  color alone, and it turns `--foreground` on hover. Secondary links (feeds, footer columns, "clear
  filters") use `link-muted`. A card that is one big link shows focus as a ring around the card.
  `tests/noUnderline.test.ts` fails on any underline class or rule in `src/`. Buttons follow
  shadcn/ui's default and outline variants restyled with the tokens above.
- Focus is always visible: a 2px `--ring` outline with a 2px offset, never removed.

### Shapes

Every button and box on the site has one of three shapes, set in `global.css`:

| Shape | Radius | Used for |
| --- | --- | --- |
| Pill | `rounded-full` (999px in plain CSS) | Every button (the `Button` component and anything styled like one), chips, tags, badges, filters, pagers, the copy command and the header's menu labels |
| Box | `rounded-box` / `--radius-box` (1rem) | Cards, panels, the header menu surface and the phone sheet, the download menu, dialogs, code blocks, callouts, screenshot frames and the hero workspace window |
| Inner | `rounded-inner` / `--radius-inner` (0.625rem) | Anything inside a box (menu rows, icon tiles, images in a card, the panes of the hero workspace) and form fields |

Text keeps its own small radius (inline code chips, the focus outline of a link), and the favicon
keeps the rounding of the app icon. `tests/shapes.test.ts` fails on any other radius in `src/`.

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
| [shadcn/ui](https://ui.shadcn.com) | Radix-based React components | Every interactive control: admin forms, dialogs, filters, tooltips, toasts |
| [React Bits](https://reactbits.dev) (David Haz) | Animated React components | The idea for the hero's rising headline, the one-time scroll reveals and the token count-up |
| [transitions.dev](https://transitions.dev) (Jakub Antalik) | Plain CSS transition snippets | Hover and press states (the header's hover pill, arrow nudges, the copy button), view transitions between pages |
| [beUI](https://github.com/starc007/ui-components) (Saurabh Chauhan) | shadcn registry components | The hover spotlight on the home page's "Why an ADE" cards; allowed for the features index cards and the download page platform picker too |
| [RareUI](https://rareui.in) (Codewithswappy) | React effect components | The one marquee of the supported AI CLIs on the home page |
| [openbot.run](https://openbot.run) | Landing page (PolyForm Noncommercial, so nothing is copied) | The idea and look of the hero beam, the split download button and the header menu, all written from scratch |
| [Beautiful UI](https://beautifului.dev) | Component site | Not used until a task checks its author and license against the working rules |

### Hero beam

The header's Download button (a filled pill on every page) is where the home page's light comes
from (`src/components/effects/beam.ts`, a WebGL2 fragment shader on one canvas, no library). The
pill lights up first (its `::after` ring, switched on by `data-beam-struck`; the rule is in
`global.css`), then a thin line of `--glow` light drops from it down the right side of the hero and
lands on the top edge of the workspace window with a short flash. From there the light flows like
poured water: it spreads along the top edge both ways, fast at first and then slower, stops short of
the far corner and pours over the nearer corner. There it leaves the edge as a sheet of thin streaks
that widens as it falls, the way water drifts out off a ledge. After that it keeps moving: a slow
pulse, ripples along the edge, streaks flowing down, haze drifting around the beam and a few specks
of dust. The falling tip is rounded (the wider the glow, the earlier it fades), so it never ends in a
flat line. The source sits in the sticky header, so the beam follows it while
the page scrolls. At the top of the home page the header is see-through (`data-clear`), so the light
shows behind it.

The beam is light added to the dark page. Every part of it changes smoothly across the page (no `step()` or cut at a
line outside the window), because a seam shows wherever the window does not cover it. The state is
on `#hero` as `data-beam`:

| State | When | What shows |
|---|---|---|
| `on` | WebGL2 and no reduced motion | The shader, live |
| `still` | Reduced motion | One still frame of the settled light |
| `fallback` | No WebGL2, software rendering only, or a lost context | A CSS line of light from the header button to the window |

It starts when the browser is idle, so it never delays the first paint. The pixel ratio is capped at
1.5 and the canvas at 2000 device pixels on its long side. Frames after the intro run at about
30fps, except for a moment after each scroll (so the beam keeps up with the header), and nothing is
drawn while the hero is off screen or the tab is hidden.

### Header menu

The header (`src/components/Header.astro`, behavior in `src/components/header/menu.ts`, styles in
`header.css`) is a glass bar: the logo, the menu labels on the bar itself, then Download (the filled
pill the hero beam falls from), and a glass GitHub button. The glass is a layer
behind the bar, not a backdrop filter on the header itself, so the phone sheet can cover the window
and the menu can blur the page under it. At the top of the home page that layer is hidden
(`data-clear`).

The menu has Features, News, Blog and Resources, which open panels, and Help, a plain link. News
and Blog show the three newest entries: the newest as a tall "Latest" card with a tinted art
background (a post's cover when it has one) and the other two as rows with a summary line. The
pages around the header are mostly prerendered, so the panels start as placeholders the size of
the real cards and the browser reads `/nav/latest.json` (rendered per request, cached for a
minute) the first time the visitor reaches for the menu. When the API is down a panel says so and
still links to the section. Features and Resources are fixed tiles from `src/lib/nav.ts`.

The Download button opens a panel the same way, on the same surface, so moving from Help to Download
slides the glass across: Windows, macOS for Apple silicon, macOS for Intel and Linux, each through
`/download/<os>/latest` (with the Mac's arch), plus "All builds and checksums". Clicking the button
itself still goes to /download. On a phone the systems are the first section of the sheet instead.

Hovering a label slides a pill behind it and opens its panel on one shared glass surface that grows
out of the label. Moving to another label slides the surface over and resizes it, while the old
panel slides out with a blur to one side and the new one slides in from the other, and on a fresh
open the cards rise in one after another. Clicking a label with a page still goes to that page.
From the keyboard, ArrowDown opens a panel and moves into it, Escape closes it and returns to the
label, and the panels are out of the tab order while closed. Below 900px the menu becomes a round
button that opens a full-screen glass sheet with the same panels stacked, each dropping in a moment
after the one above.

### Download button

The home page's closing call to action has a download button that is one pill split in two
(`src/components/home/DownloadSplit.astro`): the main link and a chevron that opens a menu of
Windows, macOS and Linux, plus "All builds and checksums" for /download. The server sends "Download
Runova" linking to /download; the browser then names the visitor's system ("Download for macOS")
and links it to `/download/<os>/latest`, which redirects to that system's file in the latest
release (the same pick as the main button on /download, or /download itself for a Mac of unknown
arch). Picking a system in the menu downloads it and makes it the main link. The menu works with
arrows, Home, End and Escape, and closes on a click outside. The pill is white with dark text.

Not allowed anywhere: scroll hijacking, parallax on text, cursor followers, autoplaying video with
sound, effects inside the admin area (it uses shadcn/ui only), and anything that moves while the
visitor reads body text.

## Motion

- Durations: 120ms for hover and press, 200ms for menus, sheets and toasts, 300ms for page view
  transitions, up to 800ms for a one-time entrance on the home page. Easing
  `cubic-bezier(0.2, 0, 0, 1)` for entrances and `cubic-bezier(0.4, 0, 1, 1)` for exits.
- Animate only `transform` and `opacity` (and `filter` for the hero glow). Never animate layout
  properties. One exception: the header menu's surface changes its width and height as it moves
  between panels (it is empty and absolutely placed, so nothing else reflows), over 460ms, and its
  panels blur in and out.
- A help article's "On this page" list follows the reader (`src/components/help/HelpToc.astro`
  and `toc.ts`). The entry for the section on screen gets a soft green highlight with a lit
  segment on the rail beside it, and the rail fills for the part already read. The highlight is a
  `clip-path` whose four edges are registered custom properties, so it moves without reflowing
  anything. Moving down, its bottom edge leads (260ms) and the top follows (440ms), so it stretches
  toward the next entry and settles; going up it is the other way round. It wipes in from the left
  the first time a section is reached, and a clicked entry is picked at once rather than stepping
  through the sections on the way. The active link has `aria-current="location"`.
- Entrances run once, when the element first scrolls into view, and never again on the same page.
- The hero's run plays once, for about six seconds, and never again on the same page.
- Nothing loops forever except the agent CLI marquee, which pauses under the pointer or keyboard
  focus, the hero beam, which pauses off screen and in a hidden tab, and the shimmer of a loading
  state.

### Reduced motion

With `prefers-reduced-motion: reduce`:

- One global rule sets `animation: none` and `transition: none` on every element and pseudo-element,
  and turns off view transitions (`@view-transition { navigation: none; }`). T011 checks computed
  styles with Playwright.
- The hero shows the finished run at once (`data-state="done"`) and nothing in it moves. The beam is
  one still frame of the settled light.
- Count-ups show their final number, text reveals show the full text, the marquee is a static
  wrapped list.
- Smooth scrolling is off (`scroll-behavior: auto`).

Color changes on hover still happen, but instantly.
