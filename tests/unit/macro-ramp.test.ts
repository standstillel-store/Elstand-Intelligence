import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rampColor, rampGradient, RAMP_STOPS, relativeLuminance } from '../../src/ui/macro/ramp.js';
import { colorToken, contrastRatio } from '../support/css.js';

const HEX = /^#[0-9a-f]{6}$/;

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    assert.equal(relativeLuminance('#000000'), 0);
    assert.ok(Math.abs(relativeLuminance('#ffffff') - 1) < 1e-12);
  });

  it('weights the channels as WCAG does: green most, then red, then blue', () => {
    assert.ok(Math.abs(relativeLuminance('#ff0000') - 0.2126) < 1e-9);
    assert.ok(Math.abs(relativeLuminance('#00ff00') - 0.7152) < 1e-9);
    assert.ok(Math.abs(relativeLuminance('#0000ff') - 0.0722) < 1e-9);
  });

  it('uses the linear segment for very dark channels', () => {
    // 0x03 / 255 is below the 0.03928 threshold, so it is divided by 12.92 rather than powered.
    assert.ok(Math.abs(relativeLuminance('#030303') - 3 / 255 / 12.92) < 1e-12);
  });
});

describe('contrastRatio (the helper the checks below rely on)', () => {
  it('is 21 for black on white and 1 for a color on itself, whichever way round', () => {
    assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
    assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 1e-9);
    assert.equal(contrastRatio('#336699', '#336699'), 1);
  });
});

describe('the volatility color ramp', () => {
  it('has seven stops, each a lower-case #rrggbb', () => {
    assert.equal(RAMP_STOPS.length, 7);
    for (const stop of RAMP_STOPS) assert.match(stop, HEX);
  });

  it('is one hue: green always leads, and red and blue never overtake it', () => {
    for (const stop of RAMP_STOPS) {
      const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(stop.slice(index, index + 2), 16));
      assert.ok(r !== undefined && g !== undefined && b !== undefined);
      assert.ok(g > r && g > b, stop);
      // The surface e2e helper isolates the surface faces by `g - r > 40`.
      assert.ok(g - r > 40, `${stop} must stay isolable from grey ink`);
    }
  });

  it('rises in lightness at every stop, so the order survives grayscale', () => {
    const luminances = RAMP_STOPS.map(relativeLuminance);
    luminances.forEach((value, index) => {
      if (index > 0)
        assert.ok(
          value > (luminances[index - 1] ?? 0),
          `${RAMP_STOPS[index]} is not lighter than the stop before`,
        );
    });
  });

  it('keeps every step visible: no two neighbouring stops are closer than 1.2:1', () => {
    for (let index = 1; index < RAMP_STOPS.length; index += 1) {
      const ratio = contrastRatio(RAMP_STOPS[index] ?? '', RAMP_STOPS[index - 1] ?? '');
      assert.ok(ratio >= 1.2, `step ${index} is only ${ratio.toFixed(3)}:1`);
    }
  });

  it('keeps the darkest stop at least 3:1 against the canvas and the panel it is drawn on', () => {
    const darkest = RAMP_STOPS[0];
    assert.ok(darkest !== undefined);
    for (const background of ['--bg', '--surface']) {
      const ratio = contrastRatio(darkest, colorToken(background));
      assert.ok(ratio >= 3, `${darkest} against ${background} is ${ratio.toFixed(2)}:1`);
    }
  });

  it('keeps the lightest stop at least 7:1 against the background, so the top of the range never fades out', () => {
    const lightest = RAMP_STOPS[RAMP_STOPS.length - 1];
    assert.ok(lightest !== undefined);
    assert.ok(contrastRatio(lightest, colorToken('--bg')) >= 7);
  });
});

describe('rampColor', () => {
  it('returns the first stop at 0 and the last stop at 1', () => {
    assert.equal(rampColor(0), RAMP_STOPS[0]);
    assert.equal(rampColor(1), RAMP_STOPS[RAMP_STOPS.length - 1]);
  });

  it('returns each stop exactly at its own position', () => {
    RAMP_STOPS.forEach((stop, index) => {
      assert.equal(rampColor(index / (RAMP_STOPS.length - 1)), stop);
    });
  });

  it('clamps values outside [0, 1] and reads NaN as the low end', () => {
    assert.equal(rampColor(-0.5), RAMP_STOPS[0]);
    assert.equal(rampColor(-1e9), RAMP_STOPS[0]);
    assert.equal(rampColor(1.5), RAMP_STOPS[RAMP_STOPS.length - 1]);
    assert.equal(rampColor(1e9), RAMP_STOPS[RAMP_STOPS.length - 1]);
    assert.equal(rampColor(Number.NaN), RAMP_STOPS[0]);
  });

  it('always returns a valid lower-case #rrggbb', () => {
    for (let step = -5; step <= 105; step += 1) assert.match(rampColor(step / 100), HEX);
    for (const odd of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      1e-12,
      1 - 1e-12,
    ]) {
      assert.match(rampColor(odd), HEX);
    }
  });

  it('is monotone in lightness across the whole range, not only at the stops', () => {
    let previous = -1;
    for (let step = 0; step <= 1000; step += 1) {
      const luminance = relativeLuminance(rampColor(step / 1000));
      assert.ok(luminance >= previous - 1e-12, `lightness fell at t=${step / 1000}`);
      previous = luminance;
    }
  });

  it('blends the neighbouring stops between them: the midpoint of two stops lies between them in every channel', () => {
    const channels = (hex: string): number[] =>
      [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    for (let index = 0; index < RAMP_STOPS.length - 1; index += 1) {
      const a = channels(RAMP_STOPS[index] ?? '#000000');
      const b = channels(RAMP_STOPS[index + 1] ?? '#000000');
      const middle = channels(rampColor((index + 0.5) / (RAMP_STOPS.length - 1)));
      middle.forEach((value, channel) => {
        const low = Math.min(a[channel] ?? 0, b[channel] ?? 0);
        const high = Math.max(a[channel] ?? 0, b[channel] ?? 0);
        assert.ok(
          value >= low && value <= high,
          `channel ${channel} between stops ${index} and ${index + 1}`,
        );
      });
    }
  });
});

describe('rampGradient', () => {
  it('lists every stop, low to high, left to right', () => {
    assert.equal(rampGradient(), `linear-gradient(to right, ${RAMP_STOPS.join(', ')})`);
  });
});
