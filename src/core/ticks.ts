/** Round axis values shared by the chart and the macro modules. */

function niceNumber(value: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

export interface Ticks {
  readonly ticks: readonly number[];
  readonly step: number;
}

/** Round tick values (1, 2, 5 times a power of ten) covering `[min, max]`, about `target` of them. */
export function niceTicks(min: number, max: number, target: number): Ticks {
  if (!(max > min) || target < 2) return { ticks: [], step: 0 };
  const step = niceNumber((max - min) / (target - 1), true);
  const first = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max + step * 1e-9; value += step) {
    // Strip floating-point residue (0.30000000000000004) so labels and equality stay clean.
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 200) break;
  }
  return { ticks, step };
}
