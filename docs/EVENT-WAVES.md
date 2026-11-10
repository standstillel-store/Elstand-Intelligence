# Surface VI: event proximity

Surface VI is the panel under the volatility surface (Macro Intelligence, `#/macro/vol-surface`)
that shows **how close the high-impact scheduled events are**. It is drawn from the economic
calendar and from nothing else. It needs no options data, so it works while the surface above it
still waits for a provider, and it adds to the page without changing the surface.

> **A wave is a picture of one thing: how close a scheduled event is.** It is not measured or
> implied volatility, and it is not a forecast of what any price will do. The panel says so in its
> own text.

## What it draws

| Part            | Rule                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events          | Real events from the calendar provider, for today and the next 6 days (UTC). Screened exactly like the lists (`screenCalendar`), so an unattributed item is rejected and the panel says why.                                                                                                                               |
| Who gets a wave | An event whose **time the source stated** and which is not cancelled. A date-only event has a placeholder instant, not a time, so it has no wave. By default only events the **source rated high**; a switch shows every event with a stated time. Elstand rates nothing: an event the source did not rate says NOT RATED. |
| The wave        | A small static line. It is flat when the event is 24 hours or more away, rises in proportion as the stated time comes nearer, is at its fullest at the stated time, and settles back to flat over the hour after. Nothing animates, and nothing random is in it.                                                           |
| Countdown       | `in 2h 05m`, `now`, `12m 03s ago`, from the stated time and the clock. It ticks every second and moves the wave with it, with no new request.                                                                                                                                                                              |
| Time            | The stated time is shown in UTC and in the viewer's zone, and the zone is named.                                                                                                                                                                                                                                           |
| Details         | Opening an event shows the figures the source gave and only those: Actual, Forecast and Previous when provided, who rated the impact, the source and when it was retrieved. A **surprise** (actual minus consensus) appears only when the calendar supplied both as numbers; otherwise there is none.                      |
| Source          | The panel states where the data came from, with the link its provider requires, and when it was retrieved.                                                                                                                                                                                                                 |

The proximity and the wave are computed in `src/core/event-waves.ts` (pure functions of the stated
time and the clock, tested in `tests/unit/event-waves.test.ts`); the panel is
`src/ui/macro/event-waves.ts`. No charting dependency was added: the wave is an SVG path.

## The clock

The countdown runs on **this device's clock**, and the panel says so. The server's clock is not
consulted, so a device whose clock is wrong shows a wrong countdown, and the wave with it. The stated
time itself comes from the provider and is shown in UTC beside the viewer's zone, so the two can be
compared.

## When there is no calendar

| Situation                              | What the panel says                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No calendar provider is connected      | ENV NOT CONNECTION, and exactly: ENV NOT CONNECTED — Economic calendar provider unavailable. Surface VI event waves are disabled. Nothing is drawn, not even an empty wave. |
| The provider was asked and failed      | CALENDAR FAILED, the reason, and a Retry button. The waves stay off.                                                                                                        |
| The calendar holds no high-rated event | "No event in the calendar’s window is rated high by its source. Elstand assigns no rating of its own."                                                                      |

The calendar's own state (CACHED, STALE, RATE LIMITED, ERROR) is shown above the list the same way it
is on the News and calendar page, with its provider and retrieval time.

## What is not claimed

- A wave does not say an event will move a market, or by how much.
- Elstand assigns no impact. The rating is the source's and is shown with its author.
- "Surface VI" is this panel. If the name was meant for something else, the panel is additive and
  can be renamed or moved without touching the volatility surface or the calendar page.

Tests: `tests/unit/event-waves.test.ts` (proximity, countdown, the drawn path) and
`tests/e2e/component-event-waves.test.ts` (the panel in a real browser, with a calendar supplied by
the test harness, including a phone-width layout). Those events are test fixtures served only by the
test-only harness, not market data.
