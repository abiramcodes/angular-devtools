// @vitest-environment jsdom
import '@angular/compiler';
import {
  ChangeDetectorRef,
  Component,
  Pipe,
  inject,
  signal,
  type PipeTransform,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AsyncPipe, CurrencyPipe } from '@angular/common';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { BehaviorSubject } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { attachPipes } from '../pipes-collector.ts';
import type { PipePageReport } from '../rpc/pipes-tools.ts';

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
} catch {
  // already initialized in this worker
}

const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  TestBed.resetTestingModule();
  document.body.innerHTML = '';
});

async function mount<T>(type: new () => T) {
  const fixture = TestBed.createComponent(type);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

function ng(): any {
  return (globalThis as any).ng;
}

class Receipt {
  a = signal(1);
  b = signal(2);
}
Component({
  selector: 'app-receipt',
  imports: [CurrencyPipe],
  template: `<p>{{ a() | currency }}</p><p>{{ b() | currency }}</p>`,
})(Receipt);

// Pure by default (no `pure: false`), takes the array itself — not a
// derived primitive — so an in-place mutation is invisible by reference.
class JoinPipe implements PipeTransform {
  transform(value: string[]): string {
    return value.join(',');
  }
}
Pipe({ name: 'join' })(JoinPipe);

function harness(pageId = 'pg') {
  const calls: { name: string; args: unknown[] }[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const my = {
    rpc: {
      call: async (name: string, ...args: unknown[]) => {
        calls.push({ name, args });
      },
      register: (def: { name: string; handler: (...args: any[]) => unknown }) => {
        handlers.set(def.name, def.handler);
      },
    },
  };
  const collector = attachPipes(my, pageId, ng);
  stops.push(collector.stop);
  const reports = () =>
    calls.filter((c) => c.name === 'push-pipes').map((c) => c.args[0] as PipePageReport);
  return { calls, handlers, collector, reports };
}

describe('pipes collector', () => {
  it('reports instance count and owning component for each pipe, without instrumenting', async () => {
    await mount(Receipt);
    const h = harness();
    h.collector.push();
    await Promise.resolve();
    const report = h.reports().at(-1)!;
    expect(report.instrumented).toBe(false);
    const currency = report.pipes.find((p) => p.name === 'currency')!;
    expect(currency).toMatchObject({ className: 'CurrencyPipe', isPure: true, instanceCount: 2 });
    expect(currency.components).toEqual([{ name: 'Receipt', count: 2 }]);
    expect(currency.call).toBeUndefined();
  });

  it('tracks call count, last input/output and caller once instrumented', async () => {
    const fixture = await mount(Receipt);
    const h = harness();
    h.handlers.get('instrument-pipes')!(true);
    // The pure pipe already ran once before instrumenting; force a fresh
    // recompute so the (now-patched) transform actually runs again.
    fixture.componentInstance.a.set(5);
    fixture.detectChanges();
    await fixture.whenStable();
    h.collector.push();
    await Promise.resolve();

    const report = h.reports().at(-1)!;
    expect(report.instrumented).toBe(true);
    const currency = report.pipes.find((p) => p.name === 'currency')!;
    expect(currency.call?.callCount).toBeGreaterThan(0);
    expect(currency.call?.lastResult).toBe('$5.00');
  });

  it('stops instrumenting and the next report reflects it', async () => {
    await mount(Receipt);
    const h = harness();
    h.handlers.get('instrument-pipes')!(true);
    h.handlers.get('instrument-pipes')!(false);
    await Promise.resolve();
    const report = h.reports().at(-1)!;
    expect(report.instrumented).toBe(false);
  });

  it('reports the latest async value and flags a duplicate subscription', async () => {
    class Feed {
      shared$ = new BehaviorSubject('one');
      solo$ = new BehaviorSubject('solo');
    }
    Component({
      selector: 'app-feed',
      imports: [AsyncPipe],
      template: `<p>{{ shared$ | async }}</p><p>{{ shared$ | async }}</p><p>{{ solo$ | async }}</p>`,
    })(Feed);

    await mount(Feed);
    const h = harness();
    h.collector.push();
    await Promise.resolve();

    const report = h.reports().at(-1)!;
    const asyncUsages = report.async ?? [];
    expect(asyncUsages).toHaveLength(3);
    expect(asyncUsages.filter((a) => a.duplicate)).toHaveLength(2);
    expect(asyncUsages.filter((a) => !a.duplicate)).toHaveLength(1);
    for (const usage of asyncUsages) {
      expect(usage.hasSource).toBe(true);
      expect(usage.component).toBe('Feed');
    }
    expect(asyncUsages.some((a) => a.latestValue === 'one')).toBe(true);
    expect(asyncUsages.some((a) => a.latestValue === 'solo')).toBe(true);
  });

  it('flags a pure pipe fed a mutated-in-place argument (experimental stale check)', async () => {
    class ListView {
      items = signal<string[]>(['a', 'b']);
      cdr = inject(ChangeDetectorRef);
    }
    Component({
      selector: 'app-list',
      // Bound directly to the array reference (not a derived primitive), so
      // a mutation in place is genuinely invisible to Angular's `Object.is`
      // memoization check.
      imports: [JoinPipe],
      template: `<p>{{ items() | join }}</p>`,
    })(ListView);

    const fixture = await mount(ListView);
    const h = harness();
    h.handlers.get('instrument-pipes')!(true);
    h.collector.push();
    await Promise.resolve();
    expect(
      h
        .reports()
        .at(-1)!
        .pipes.find((p) => p.name === 'join')?.stale,
    ).toBeUndefined();

    fixture.componentInstance.items().push('c'); // same array reference, mutated in place
    fixture.componentInstance.cdr.markForCheck(); // force a recheck without changing any binding
    fixture.detectChanges();
    await fixture.whenStable();
    h.collector.push();
    await Promise.resolve();

    const stale = h
      .reports()
      .at(-1)!
      .pipes.find((p) => p.name === 'join')?.stale;
    expect(stale).toBeDefined();
    expect(stale?.detectedAt).toBeGreaterThan(0);
  });

  it('does not flag a normal, immutable update as stale', async () => {
    class ListView {
      items = signal<string[]>(['a', 'b']);
    }
    Component({
      selector: 'app-list2',
      imports: [JoinPipe],
      template: `<p>{{ items() | join }}</p>`,
    })(ListView);

    const fixture = await mount(ListView);
    const h = harness();
    h.handlers.get('instrument-pipes')!(true);
    h.collector.push();
    await Promise.resolve();

    fixture.componentInstance.items.set([...fixture.componentInstance.items(), 'c']);
    fixture.detectChanges();
    await fixture.whenStable();
    h.collector.push();
    await Promise.resolve();

    expect(
      h
        .reports()
        .at(-1)!
        .pipes.find((p) => p.name === 'join')?.stale,
    ).toBeUndefined();
  });

  it('does not run the stale check while not instrumented', async () => {
    class ListView {
      items = signal<string[]>(['a', 'b']);
      cdr = inject(ChangeDetectorRef);
    }
    Component({
      selector: 'app-list3',
      imports: [JoinPipe],
      template: `<p>{{ items() | join }}</p>`,
    })(ListView);

    const fixture = await mount(ListView);
    const h = harness();
    h.collector.push();
    await Promise.resolve();

    fixture.componentInstance.items().push('c');
    fixture.componentInstance.cdr.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
    h.collector.push();
    await Promise.resolve();

    expect(
      h
        .reports()
        .at(-1)!
        .pipes.find((p) => p.name === 'join')?.stale,
    ).toBeUndefined();
  });

  it('does nothing harmful when Angular has no debug API on the page', async () => {
    const my = {
      rpc: { call: async () => {}, register: () => {} },
    };
    const collector = attachPipes(my, 'pg', () => undefined);
    stops.push(collector.stop);
    expect(() => collector.push()).not.toThrow();
  });
});
