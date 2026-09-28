import { Pipe, PipeTransform } from '@angular/core';

/** Pure: the same text and limit always produce the same string. */
@Pipe({ name: 'appTruncate' })
export class TruncatePipe implements PipeTransform {
  transform(value: string, limit = 40): string {
    if (limit <= 0) return '';
    // A string's code point count never exceeds its UTF-16 length, so this skips the array copy.
    if (value.length <= limit) return value;
    const codePoints = Array.from(value);
    return codePoints.length > limit
      ? `${codePoints
          .slice(0, limit - 1)
          .join('')
          .trimEnd()}…`
      : value;
  }
}
