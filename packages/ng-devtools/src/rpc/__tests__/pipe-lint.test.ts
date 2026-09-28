import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureDir } from './fixture-dir.ts';
import { describe, expect, it } from 'vitest';
import { lintPipes } from '../pipe-lint.ts';

function lintFor(source: string) {
  const dir = fixtureDir('ng-devtools-pipe-lint-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.ts'), source);
  return lintPipes(dir);
}

describe('lintPipes', () => {
  describe('impure-pipe-in-for', () => {
    it('flags a built-in impure pipe used inside @for', () => {
      const findings = lintFor(`
        @Component({
          selector: 'app-list',
          imports: [SlicePipe],
          template: \`
            @for (item of items; track item.id) {
              <p>{{ item.tail | slice:1 }}</p>
            }
          \`,
        })
        export class ListView {}
      `);
      const finding = findings.find((f) => f.rule === 'impure-pipe-in-for');
      expect(finding).toMatchObject({ pipe: 'slice', severity: 'warning' });
    });

    it('flags a custom impure pipe used inside @for', () => {
      const findings = lintFor(`
        @Pipe({ name: 'appLive', pure: false })
        export class LivePipe implements PipeTransform {
          transform(value: number) { return value; }
        }

        @Component({
          selector: 'app-list',
          imports: [LivePipe],
          template: \`
            @for (item of items; track item.id) {
              <p>{{ item.value | appLive }}</p>
            }
          \`,
        })
        export class ListView {}
      `);
      const finding = findings.find((f) => f.rule === 'impure-pipe-in-for');
      expect(finding).toMatchObject({ pipe: 'appLive', severity: 'warning' });
    });

    it('does not flag a pure pipe inside @for', () => {
      const findings = lintFor(`
        @Component({
          selector: 'app-list',
          imports: [CurrencyPipe],
          template: \`
            @for (item of items; track item.id) {
              <p>{{ item.price | currency }}</p>
            }
          \`,
        })
        export class ListView {}
      `);
      expect(findings.filter((f) => f.rule === 'impure-pipe-in-for')).toEqual([]);
    });

    it('does not flag an impure pipe used outside @for', () => {
      const findings = lintFor(`
        @Component({
          selector: 'app-list',
          imports: [SlicePipe],
          template: '<p>{{ items | slice:1 }}</p>',
        })
        export class ListView {}
      `);
      expect(findings.filter((f) => f.rule === 'impure-pipe-in-for')).toEqual([]);
    });
  });

  describe('json-pipe-in-template', () => {
    it('flags | json usage', () => {
      const findings = lintFor(`
        @Component({
          selector: 'app-debug',
          imports: [JsonPipe],
          template: '<pre>{{ data | json }}</pre>',
        })
        export class Debug {}
      `);
      const finding = findings.find((f) => f.rule === 'json-pipe-in-template');
      expect(finding).toMatchObject({ pipe: 'json', severity: 'info' });
    });

    it('does not flag a template with no json usage', () => {
      const findings = lintFor(`
        @Component({
          selector: 'app-debug',
          imports: [UpperCasePipe],
          template: '<p>{{ name | uppercase }}</p>',
        })
        export class Debug {}
      `);
      expect(findings.filter((f) => f.rule === 'json-pipe-in-template')).toEqual([]);
    });
  });

  describe('signal-read-in-pure-pipe', () => {
    it('flags a pure pipe reading a signal field in transform()', () => {
      const findings = lintFor(`
        @Pipe({ name: 'appScaled' })
        export class ScaledPipe implements PipeTransform {
          factor = signal(2);
          transform(value: number) {
            return value * this.factor();
          }
        }
      `);
      const finding = findings.find((f) => f.rule === 'signal-read-in-pure-pipe');
      expect(finding).toMatchObject({ pipe: 'appScaled' });
    });

    it('does not flag an impure pipe reading a signal field', () => {
      const findings = lintFor(`
        @Pipe({ name: 'appScaled', pure: false })
        export class ScaledPipe implements PipeTransform {
          factor = signal(2);
          transform(value: number) {
            return value * this.factor();
          }
        }
      `);
      expect(findings.filter((f) => f.rule === 'signal-read-in-pure-pipe')).toEqual([]);
    });

    it('does not flag a pure pipe that never reads a signal field', () => {
      const findings = lintFor(`
        @Pipe({ name: 'appPlain' })
        export class PlainPipe implements PipeTransform {
          transform(value: number) {
            return value * 2;
          }
        }
      `);
      expect(findings.filter((f) => f.rule === 'signal-read-in-pure-pipe')).toEqual([]);
    });

    it('does not flag a pure pipe with a signal field it never reads in transform()', () => {
      const findings = lintFor(`
        @Pipe({ name: 'appUnused' })
        export class UnusedPipe implements PipeTransform {
          unused = signal(2);
          transform(value: number) {
            return value;
          }
        }
      `);
      expect(findings.filter((f) => f.rule === 'signal-read-in-pure-pipe')).toEqual([]);
    });
  });
});
