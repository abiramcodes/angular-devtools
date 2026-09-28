import { Pipe, PipeTransform, signal } from '@angular/core';

/** Pure, but reads a signal directly in transform() instead of taking it as
 * an argument: a memoization hazard, since a pure pipe only recomputes when
 * its own arguments change, not when a signal it reads changes. Flagged by
 * the "signal read in pure pipe" lint rule. */
@Pipe({ name: 'appScaled' })
export class ScaledPipe implements PipeTransform {
  factor = signal(2);
  transform(value: number): number {
    return value * this.factor();
  }
}
