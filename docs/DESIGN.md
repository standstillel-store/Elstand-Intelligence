# Design

Elstand Intelligence is a market workstation, not a landing page and not a generic SaaS dashboard.
It is dense, quiet and exact: a watchlist, a chart, a depth panel and a reasoning workspace, with
numbers in monospace and color reserved for meaning. Nothing is there to look busy.

Most of the rules below are not aspirations. They are checked by tests
(`tests/unit/design-tokens.test.ts`, `tests/unit/contrast.test.ts`, `tests/unit/macro-ramp.test.ts`),
so a later change cannot quietly break them.

## Palette

All colors are declared once, in `src/styles/tokens.css`. No other stylesheet contains a hex, `rgb()`,
`hsl()` or other color literal, and every `var(--token)` must name a token that exists.

| Token           | Value     | Role                                                                                                                                       |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--bg`          | `#070907` | Page and canvas background                                                                                                                 |
| `--surface`     | `#0d120f` | Panels                                                                                                                                     |
| `--surface-2`   | `#121a15` | Raised and highlighted elements: buttons, the selected timeframe, hovered and selected watchlist rows, depth bars, the surface tooltip     |
| `--border`      | `#243329` | Dividers and grid lines. Decorative only.                                                                                                  |
| `--green-muted` | `#4a805b` | Graphics only: borders, dots, the DELAYED badge, bubbles. Never text.                                                                      |
| `--neon`        | `#8cff4d` | The accent. Reserved, see below.                                                                                                           |
| `--text`        | `#e8f0e9` | Primary text                                                                                                                               |
| `--text-2`      | `#89968c` | Secondary text                                                                                                                             |
| `--down`        | `#ff626c` | Negative                                                                                                                                   |
| `--caution`     | `#d9a441` | **Added to the brand palette** for the two states it has no color for: STALE data and a missing connection. Never used for price movement. |

`--caution` is the only color added to the brief's palette, and `tokens.css` says why.

### Measured contrast

WCAG 2 contrast ratios, computed from the tokens by `tests/unit/contrast.test.ts`. Everything that
carries text meets 4.5:1 on every background it can sit on.

| Token                      | on `--bg` | on `--surface` | on `--surface-2` |
| -------------------------- | --------- | -------------- | ---------------- |
| `--text`                   | 17.19:1   | 16.27:1        | 15.26:1          |
| `--text-2`                 | 6.47:1    | 6.13:1         | 5.75:1           |
| `--neon`                   | 15.72:1   | 14.88:1        | 13.95:1          |
| `--down`                   | 6.86:1    | 6.50:1         | 6.09:1           |
| `--caution`                | 8.88:1    | 8.41:1         | 7.88:1           |
| `--green-muted` (graphics) | 4.31:1    | 4.08:1         | 3.82:1           |
| `--border`                 | 1.50:1    | 1.42:1         | 1.33:1           |

`--green-muted` clears 3:1 as a graphic everywhere, but it is below 4.5:1 on some backgrounds, so a
test enforces that it never colors text. `--border` is deliberately not held to a ratio: it is a
hairline, never the only thing that separates or identifies something.

The volatility surface's color ramp is one hue in seven stops (`#256f3a` to `#d4ffdc`), with lightness
rising monotonically so the order survives grayscale and color-vision deficiency. Its darkest stop
is **3.25:1** on `--bg` and **3.07:1** on `--surface`, the two backgrounds the surface is drawn on. It is
not held to 3:1 on `--surface-2`, which it is never drawn on. The stop was lightened from `#206133`
because the first value measured 2.68:1.

## Where the neon green may appear

The brief reserves `--neon` for the active navigation item, the selected instrument, important
interactions and verified positive states. A test lists every use in the stylesheets, with a reason
for each, and fails on any use that is not on the list, so adding one is a deliberate act. Today:

- **Interaction and focus:** the keyboard focus ring, the skip link, a toggled button, the selected
  timeframe, a selected, focused or hovered bubble.
- **Navigation and selection:** the active navigation item, the active Macro tab, the selected watchlist
  row and the selected instrument in the header.
- **Verified positive states:** a LIVE badge, a price rise on verified data, an ELVOID result that is
  available, an ELVOID conclusion that passed validation, and a module that is implemented.
- **Identity:** the brand mark.

It is never a background and never a fill behind text.

## Direction and state

A price rise is neon and a fall is `--down`, **only on verified data** (LIVE or DELAYED). On STALE
data, on a flat change and where there is no change, the figure is `--text-2`. The color of a move
therefore cannot suggest a current price that the data does not support. Color is never the only
signal: signed numbers and the ▲, ▼ and – glyphs always accompany it.

| Data state  | Badge                                  |
| ----------- | -------------------------------------- |
| LIVE        | `--neon` text and border               |
| DELAYED     | `--text` with a `--green-muted` border |
| STALE       | `--caution` text and border            |
| UNAVAILABLE | `--text-2`                             |

Each badge also carries its word, so the state reads without color.

## Density and type

- Numbers, prices and times are set in the monospace face. Sans-serif is for labels and prose. Both
  are system font stacks: no web font is loaded, which the CSP (`font-src 'self'`) and the build
  would otherwise have to allow.
- A short type scale (11, 12, 13, 15 and 22 px) and a 4, 8, 12, 16 and 24 px spacing scale, as tokens.
- Fixed dimensions are tokens too: a 48 px header, a 320 px watchlist and a 340 px depth panel.
- The Forex page is one column below 1100 px, two columns (chart, depth and ELVOID beside a sticky
  watchlist) from 1100 px, and three (chart and depth side by side) from 1500 px. At 700 px and below
  the header compacts. The browser tests run at 1920, 1440, 1024, 700, 600 and 390 px wide.

## What is deliberately absent

No gradients. No blur, glow or text shadow. No soft drop shadows: there is exactly one box shadow,
the underline of the selected timeframe. No animation and no transition: nothing moves to look busy.
Rounding is for the status dot only; panels and buttons are square. No illustrations, no decorative
icons, no cards that exist only to frame a number, and no sparkline or metric that is not a real
measurement. The tests assert each of these.

## States are explicit

A panel is never blank and never decorative. It is in one of these, and says which, in words:
checking, **ENV NOT CONNECTION** (with what is missing), **SERVER ERROR** (with a Retry), loading,
failed (with the reason and a Retry), unavailable (with the reason), or ready. Ready data that is
stale says so beside the data. A bold lead word carries the meaning (CHART FAILED, DEPTH UNAVAILABLE,
SERIES REJECTED), so a state reads without its color. Every timestamp is UTC unless it says otherwise.

## Accessibility

What the interface does:

- A skip link, one visually hidden `h1` per page, and `header`, `nav`, `main` and `footer` landmarks. The current page, instrument and tab are marked with `aria-current`.
- Every interactive element has an accessible name, and ids are unique. The browser tests audit both.
- A visible focus ring on everything that can take focus, in the neon accent.
- The chart, the 3D surface and the bubble chart are keyboard operable, and each has a data table
  that carries every value. Status regions that change (`role="status"`, `aria-live`) announce it.
- Nothing animates, so there is no motion to reduce. The color scheme is dark only.

What it has not had: a review with a screen reader, a check at 200% and 400% zoom for reflow, or an
audit against the full WCAG criteria. The automated checks catch the regressions that are easiest to
introduce. They are not a substitute for that review, and none was done for this build.
