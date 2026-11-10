# Macro bubbles

The bubble chart on the Macro Intelligence page puts one currency in one bubble and reads three
macro numbers off it. This document is the encoding to the formula. The same text is shown on the
page itself, whether or not data is present, so the chart can always be read without this file.

## What is drawn

| Channel             | Encodes                                              | Unit             |
| ------------------- | ---------------------------------------------------- | ---------------- |
| One bubble          | One currency (ISO 4217 code)                         |                  |
| Horizontal position | Policy rate, as published by the source named for it | percent          |
| Vertical position   | Consumer price inflation, year on year               | percent          |
| Size                | The absolute one-month price change of the currency  | percent          |
| Color and glyph     | The direction of that price change                   | up, down or flat |

The one-month price change states its basis (what it is measured against, for example "vs USD, close
to close"), per currency. A bubble is drawn only when **all three** numbers exist. A currency missing
any of them is not drawn and nothing is estimated or filled in.

## Size

```text
radius = RADIUS_MIN + (radiusMax - RADIUS_MIN) × √( |change| ÷ largest |change| )
```

- `RADIUS_MIN` is 5 px.
- `radiusMax` follows the plot: 9% of the shorter side of the plot area, kept between 14 px and 34 px.
- `largest |change|` is the largest absolute one-month change among the currencies drawn.

The square root makes the bubble's **area grow with the absolute change**. **Area is not strictly
proportional to it.** The minimum radius keeps a currency whose change is zero visible, so every
radius carries a constant offset. A worked example with `radiusMax` at 34 px: the currency with the
largest change is drawn at 34 px; a currency with a quarter of that change is drawn at 19.5 px, whose
area is about 33% of the largest bubble's, not 25%; a currency with no change is drawn at 5 px. Read
bubble size as "bigger means a larger move", and read the signed number for the value.

Bubbles are drawn largest first, so a small bubble is never hidden under a large one. Equal sizes are
ordered by currency code.

## Position

Both axes run over the data they show, padded by 14% of the data's span on each side (one percentage
point on each side if every value is equal), with round tick values. The axes are not forced to include
zero (a zero line is drawn when zero falls inside the range), and they are not shared between the two
measures: rates and inflation are different quantities that happen to share a unit. Each axis is
titled with its measure and unit.

## Color and glyph

| Direction | Rule       | Glyph | Color          |
| --------- | ---------- | ----- | -------------- |
| Up        | change > 0 | ▲     | muted green    |
| Down      | change < 0 | ▼     | red (`--down`) |
| Flat      | change = 0 | –     | grey           |

Color is never the only signal. The glyph and the signed number are always shown, so the direction
survives color-vision deficiency and grayscale. The neon green is not used here: it is reserved for
the active navigation item, the selected instrument, important interactions and verified positive
states ([DESIGN.md](DESIGN.md)).

## Attribution

Every one of the three values carries a source and times, and the detail of a selected bubble shows
each of them:

- the value;
- the **named source** (a link when the address is a plain `http` or `https` one);
- when it was **observed or published** at the source;
- when Elstand **retrieved** it.

The three numbers of one currency can come from different sources and different dates, and the page
says so. They are shown beside each other, not blended.

`validateBubblePoints` (`src/data/macro-bubbles.ts`) rejects the whole set if any of this is wrong:
a code that is not three letters, a currency that appears twice, a value that is not a finite
number, a value with no observation time or no named source, or a price change with no stated
basis. A set that fails validation is shown as SERIES REJECTED with the first problem found, and
nothing is drawn. A set with no currencies says so.

## Reading it without the picture

Under the chart, a data table lists every currency with the three values, the basis of the change and
the names of the sources. Each bubble can be focused with the keyboard, and selecting one opens its
detail, with every value's source, observation time and retrieval time.

## Where the values come from

The server builds the bubbles (`/api/bubbles`, `loadBubbles` in `server/macro-service.ts`) from real
inputs, and the interface draws what it returns. Nothing in the browser computes or supplies a value.

| Value                   | Input                                                                                                                                                                                   | Provider                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Policy rate             | The series named for the currency (euro area: the ECB deposit facility rate, `ECBDFR`), its newest observation.                                                                         | FRED                                                                              |
| Inflation, year on year | The monthly consumer-price index (euro area: the HICP, `CP0000EZ19M086NEST`). Elstand computes the year-on-year change from the newest observation and the one twelve months before it. | FRED                                                                              |
| One-month price change  | The pair's daily closes (EUR/USD), about 30 days apart, close to close, with the basis stated.                                                                                          | Twelve Data, with Alpha Vantage only as the documented fallback for daily candles |

Every bubble is therefore **CALCULATED**, and the detail of a selected bubble names each input and
its source. The three numbers of one currency can come from different providers and different dates;
the page says so.

Today only the **euro** is covered. USD is the base of every price change here, so it has no
one-month change to draw. GBP, JPY, CHF, CAD, AUD and NZD are listed as omitted, each with the reason:
no current policy-rate and consumer-price series is configured for them (the ones FRED offers are no
longer updated), and Elstand does not estimate missing values. A currency whose input could not be
retrieved is omitted the same way, with that reason.

When a provider is missing the module says so in words instead of drawing:

- Without `FRED_API_KEY`: **ENV NOT CONNECTION**, with ENV NOT CONNECTED — FRED_API_KEY is missing.
  Macro observations from FRED are unavailable.
- Without the daily candles (no Twelve Data key, or both it and the fallback failed), the euro is
  omitted with the provider's reason, and if nothing can be drawn the module says why.

The renderer, the encoding and the validation are exercised with test fixtures that live under
`tests/` and cannot reach the product. How each input is fetched, cached and labelled is in
[ENVIRONMENT.md](ENVIRONMENT.md) and [DATA-INTEGRITY.md](DATA-INTEGRITY.md). The inputs have not yet
been checked against the live FRED API (see [ENVIRONMENT.md](ENVIRONMENT.md#fred)).
