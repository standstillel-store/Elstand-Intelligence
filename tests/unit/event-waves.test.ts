import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countdownText,
  isWaveEligible,
  WAVE_HEIGHT,
  WAVE_HORIZON_MS,
  WAVE_SETTLE_MS,
  WAVE_WIDTH,
  wavePath,
  waveProximity,
} from '../../src/core/event-waves.js';

/**
 * A wave is a picture of one thing: how close a scheduled event is. These tests pin that it
 * reads nothing but a stated time and the clock, that it is bounded and deterministic, and that
 * an event with no stated time, or a cancelled one, never gets one.
 */

const EVENT = Date.UTC(2026, 0, 6, 13, 30, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('which events get a wave', () => {
  it('draws an event whose time the source stated', () => {
    assert.equal(isWaveEligible({ timeMs: EVENT, timePrecision: 'exact' }), true);
    assert.equal(isWaveEligible({ timeMs: EVENT }), true);
    assert.equal(
      isWaveEligible({ timeMs: EVENT, timePrecision: 'exact', status: 'scheduled' }),
      true,
    );
  });

  it('does not draw a date-only event: its instant is a placeholder, not a time', () => {
    assert.equal(isWaveEligible({ timeMs: EVENT, timePrecision: 'date' }), false);
  });

  it('does not draw a cancelled event: it is not going to happen', () => {
    assert.equal(
      isWaveEligible({ timeMs: EVENT, timePrecision: 'exact', status: 'cancelled' }),
      false,
    );
  });
});

describe('proximity', () => {
  it('is 0 when the event is the horizon away or further', () => {
    assert.equal(waveProximity(EVENT, EVENT - WAVE_HORIZON_MS), 0);
    assert.equal(waveProximity(EVENT, EVENT - WAVE_HORIZON_MS - HOUR), 0);
    assert.equal(waveProximity(EVENT, EVENT - 30 * 24 * HOUR), 0);
  });

  it('rises linearly to 1 at the scheduled instant', () => {
    assert.equal(waveProximity(EVENT, EVENT), 1);
    assert.equal(waveProximity(EVENT, EVENT - WAVE_HORIZON_MS / 2), 0.5);
    assert.equal(waveProximity(EVENT, EVENT - WAVE_HORIZON_MS / 4), 0.75);
  });

  it('never falls while the event comes closer', () => {
    let previous = -1;
    for (let ahead = WAVE_HORIZON_MS; ahead >= 0; ahead -= 15 * MINUTE) {
      const value = waveProximity(EVENT, EVENT - ahead);
      assert.ok(value >= previous, `at ${ahead / MINUTE} minutes ahead: ${value} < ${previous}`);
      previous = value;
    }
  });

  it('settles back to 0 over the hour after the event', () => {
    assert.equal(waveProximity(EVENT, EVENT + WAVE_SETTLE_MS / 2), 0.5);
    assert.equal(waveProximity(EVENT, EVENT + WAVE_SETTLE_MS), 0);
    assert.equal(waveProximity(EVENT, EVENT + 6 * HOUR), 0);
  });

  it('stays within 0 and 1 whatever the clock says', () => {
    for (const offset of [-1e12, -WAVE_HORIZON_MS, -1, 0, 1, WAVE_SETTLE_MS, 1e12]) {
      const value = waveProximity(EVENT, EVENT + offset);
      assert.ok(value >= 0 && value <= 1, `offset ${offset} gave ${value}`);
    }
  });

  it('is 0, not NaN, when a time is not a number', () => {
    assert.equal(waveProximity(Number.NaN, EVENT), 0);
    assert.equal(waveProximity(EVENT, Number.NaN), 0);
    assert.equal(waveProximity(EVENT, Number.POSITIVE_INFINITY), 0);
  });
});

describe('the countdown', () => {
  it('counts down to the event and up from it, in the notation the product uses for ages', () => {
    assert.equal(countdownText(EVENT, EVENT - (2 * HOUR + 5 * MINUTE)), 'in 2h 05m');
    assert.equal(countdownText(EVENT, EVENT - 45_000), 'in 45s');
    assert.equal(countdownText(EVENT, EVENT + (12 * MINUTE + 3_000)), '12m 03s ago');
  });

  it('says now within a second of the event', () => {
    assert.equal(countdownText(EVENT, EVENT), 'now');
    assert.equal(countdownText(EVENT, EVENT - 999), 'now');
    assert.equal(countdownText(EVENT, EVENT + 999), 'now');
  });

  it('says nothing it cannot know', () => {
    assert.equal(countdownText(Number.NaN, EVENT), '—');
    assert.equal(countdownText(EVENT, Number.NaN), '—');
  });
});

describe('the drawn wave', () => {
  const ys = (path: string): number[] =>
    path.split(' ').map((segment) => Number(segment.slice(1).split(',')[1]));

  it('is the same picture for the same proximity, every time', () => {
    assert.equal(wavePath(0.6), wavePath(0.6));
  });

  it('is a straight line when the event is far away', () => {
    const values = ys(wavePath(0));
    assert.ok(values.length > 10);
    assert.ok(
      values.every((y) => y === WAVE_HEIGHT / 2),
      'every point is on the middle line',
    );
  });

  it('grows with proximity and never leaves its box', () => {
    const spread = (amplitude: number): number => {
      const values = ys(wavePath(amplitude));
      return Math.max(...values) - Math.min(...values);
    };
    assert.ok(spread(0.25) < spread(0.5));
    assert.ok(spread(0.5) < spread(1));
    for (const y of ys(wavePath(1))) assert.ok(y >= 0 && y <= WAVE_HEIGHT, `y ${y} is in the box`);
  });

  it('runs the full width, from x = 0', () => {
    const path = wavePath(1);
    assert.match(path, /^M0,/);
    const last = path.split(' ').at(-1) ?? '';
    assert.equal(Number(last.slice(1).split(',')[0]), WAVE_WIDTH);
  });

  it('treats an amplitude outside 0 to 1, or not a number, as the nearest valid one', () => {
    assert.equal(wavePath(-3), wavePath(0));
    assert.equal(wavePath(7), wavePath(1));
    assert.equal(wavePath(Number.NaN), wavePath(0));
  });
});
