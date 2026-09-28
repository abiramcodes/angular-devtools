import {
  findPipeUsages,
  instrumentPipes,
  readBoundArg,
  staleCheckFor,
  type NgDebugApi,
  type PipeCall,
  type PipeInstrumentation,
  type PipeUsage,
  type StaleCheck,
} from './pipes-runtime.ts';
import type {
  AsyncUsageInfo,
  PipeComponentUsage,
  PipeInstanceCall,
  PipePageReport,
  PipeUsageInfo,
} from './rpc/pipes-tools.ts';

type AnyRecord = Record<string, any>;

interface Rpc {
  rpc: {
    call(name: string, ...args: unknown[]): Promise<unknown>;
    register(definition: {
      name: string;
      type: 'event' | 'action' | 'query';
      jsonSerializable: boolean;
      handler: (...args: any[]) => unknown;
    }): void;
  };
}

const HEARTBEAT_MS = 5000;

function read<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function componentName(component: unknown): string {
  return read(() => (component as { constructor?: Function })?.constructor?.name, undefined) || '?';
}

const MAX_DESCRIBE_CHARS = 200;

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    return value.length > MAX_DESCRIBE_CHARS ? `${value.slice(0, MAX_DESCRIBE_CHARS)}…` : value;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > MAX_DESCRIBE_CHARS ? `${json.slice(0, MAX_DESCRIBE_CHARS)}…` : json;
  } catch {
    return String(value);
  }
}

/** `AsyncPipe` keeps its subscribed source and latest value on plain (not
 * ECMAScript-private) fields — `_obj`/`_latestValue` — so this reads them
 * passively; no patching needed, unlike other pipes' call tracking. */
function asyncReportFor(usages: PipeUsage[]): AsyncUsageInfo[] {
  const asyncUsages = usages.filter((u) => u.name === 'async');
  const bySource = new Map<unknown, number>();
  for (const usage of asyncUsages) {
    const source = read(() => (usage.instance as { _obj?: unknown })._obj, undefined);
    if (source === undefined || source === null) continue;
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  return asyncUsages.map((usage) => {
    const source = read(() => (usage.instance as { _obj?: unknown })._obj, undefined);
    const latestValue = read(
      () => (usage.instance as { _latestValue?: unknown })._latestValue,
      undefined,
    );
    return {
      component: componentName(usage.component),
      hasSource: source !== undefined && source !== null,
      latestValue: latestValue === undefined ? undefined : describeValue(latestValue),
      duplicate: source !== undefined && source !== null && (bySource.get(source) ?? 0) > 1,
    };
  });
}

interface InstanceStats {
  callCount: number;
  /** Raw, not yet described: serializing is deferred to `reportFor` (at most
   * every few seconds) so the per-call hot path stays a couple of stores. */
  lastArgs: unknown[];
  lastResult: unknown;
  lastCaller?: string;
  lastAt: number;
}

const MAX_HASH_DEPTH = 2;
const MAX_HASH_ITEMS = 50;

/** A cheap, size-capped structural fingerprint — not a real hash, just
 * "different enough to notice" for detecting in-place mutation of an
 * argument whose reference stayed the same. Never throws. */
function shapeHash(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (depth >= MAX_HASH_DEPTH) return '…';
  return read(() => {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_HASH_ITEMS).map((v) => shapeHash(v, depth + 1));
      return `[${items.join(',')}${value.length > MAX_HASH_ITEMS ? ',…' : ''}]`;
    }
    const keys = Object.keys(value as object).slice(0, MAX_HASH_ITEMS);
    const entries = keys.map((k) => `${k}:${shapeHash((value as AnyRecord)[k], depth + 1)}`);
    return `{${entries.join(',')}}`;
  }, '?');
}

const MAX_INSTANCE_CALLS = 5;

function describeCall(s: InstanceStats) {
  return {
    lastArgs: s.lastArgs.map(describeValue),
    lastResult: describeValue(s.lastResult),
    lastCaller: s.lastCaller,
  };
}

interface StaleSnapshot {
  ref: unknown;
  hash: string;
}

/** EXPERIMENTAL: per-pipe-instance state for the stale-pure-pipe check.
 * `checks` caches the recovered binding slot (or the fact that recovery
 * failed) so the regex scan only ever runs once per instance. */
class StaleTracker {
  private readonly checks = new WeakMap<AnyRecord, StaleCheck | null>();
  private readonly snapshots = new WeakMap<AnyRecord, StaleSnapshot>();

  /** Returns true the moment a pure pipe's bound argument is found unchanged
   * by reference but different in shape from last time — i.e. Angular's own
   * memoization is about to (or already did) skip a re-render that a mutated
   * argument arguably deserved. */
  isStale(usage: PipeUsage): boolean {
    if (!usage.isPure) return false;
    let check = this.checks.get(usage.instance);
    if (check === undefined) {
      check = staleCheckFor(usage);
      this.checks.set(usage.instance, check);
    }
    if (!check) return false;
    const current = read(() => readBoundArg(usage, check!), undefined);
    const isObj = current !== null && typeof current === 'object';
    const prev = this.snapshots.get(usage.instance);
    const hash = isObj ? shapeHash(current) : '';
    this.snapshots.set(usage.instance, { ref: current, hash });
    if (!prev) return false;
    if (!Object.is(prev.ref, current)) return false;
    return isObj && hash !== prev.hash;
  }
}

export interface PipesCollector {
  push(): void;
  /** Stops pushing reports, e.g. on `pagehide`, so an in-flight or timed push
   * can't re-register a page the server was just told to forget. */
  pause(): void;
  /** Resumes after `pause` (a page restored from the back/forward cache). */
  resume(): void;
  stop(): void;
}

/** Live pipe usage: discovery (always on, cheap) plus, once instrumented,
 * per-call tracking via prototype patching. Mirrors `attachForms`'s shape. */
export function attachPipes(
  my: Rpc,
  pageId: string,
  getNg: () => NgDebugApi | undefined,
): PipesCollector {
  let instrumented = false;
  let instrumentation: PipeInstrumentation | null = null;
  const stats = new WeakMap<AnyRecord, InstanceStats>();
  const staleTracker = new StaleTracker();
  const ownerNames = new Set<string>();
  let lastPayload = '';
  let lastPushAt = 0;
  let paused = false;

  function onPipeCall(call: PipeCall) {
    const prev = stats.get(call.instance);
    stats.set(call.instance, {
      callCount: (prev?.callCount ?? 0) + 1,
      lastArgs: call.args,
      lastResult: call.result,
      lastCaller: call.caller,
      lastAt: Date.now(),
    });
  }

  function reportFor(usages: PipeUsage[]): PipeUsageInfo[] {
    const byName = new Map<string, PipeUsage[]>();
    for (const usage of usages) {
      const group = byName.get(usage.name);
      if (group) group.push(usage);
      else byName.set(usage.name, [usage]);
    }
    const out: PipeUsageInfo[] = [];
    for (const [name, group] of byName) {
      const componentCounts = new Map<string, number>();
      for (const usage of group) {
        const label = componentName(usage.component);
        componentCounts.set(label, (componentCounts.get(label) ?? 0) + 1);
      }
      const components: PipeComponentUsage[] = Array.from(componentCounts, ([label, count]) => ({
        name: label,
        count,
      }));

      let callCount = 0;
      const called: { usage: PipeUsage; stats: InstanceStats }[] = [];
      let stale = false;
      for (const usage of group) {
        const s = stats.get(usage.instance);
        if (s) {
          callCount += s.callCount;
          called.push({ usage, stats: s });
        }
        // Only while instrumented: the check has a real (capped) cost, and
        // establishing a baseline while not watching would just be noise.
        if (instrumented && staleTracker.isStale(usage)) stale = true;
      }

      called.sort((a, b) => b.stats.lastAt - a.stats.lastAt);
      const latest = called[0]?.stats;
      // Usages of one pipe can see different values (e.g. `x | p` and
      // `x | other | p`), so a single "last" would misrepresent them.
      const instances: PipeInstanceCall[] | undefined =
        called.length > 1
          ? called.slice(0, MAX_INSTANCE_CALLS).map(({ usage, stats: s }) => ({
              component: componentName(usage.component),
              callCount: s.callCount,
              ...describeCall(s),
            }))
          : undefined;

      out.push({
        name,
        className: group[0].className,
        isPure: group[0].isPure,
        instanceCount: group.length,
        components,
        call:
          callCount > 0 && latest
            ? {
                callCount,
                ...describeCall(latest),
                instances,
              }
            : undefined,
        stale: stale ? { detectedAt: Date.now() } : undefined,
      });
    }
    return out;
  }

  async function pushPipes() {
    if (paused) return;
    try {
      const ng = getNg();
      if (!ng?.getComponent) return;
      const usages = findPipeUsages(ng, document.querySelectorAll('*'));
      for (const usage of usages) ownerNames.add(componentName(usage.component));
      if (instrumentation) {
        for (const usage of usages) instrumentation.addPipe(usage);
      }
      const report: PipePageReport = {
        pageId,
        pipes: reportFor(usages),
        async: asyncReportFor(usages),
        instrumented,
      };
      const payload = JSON.stringify(report);
      const now = Date.now();
      if (payload === lastPayload && now - lastPushAt < HEARTBEAT_MS) return;
      lastPayload = payload;
      lastPushAt = now;
      if (paused) return;
      await my.rpc.call('push-pipes', report);
    } catch {
      return;
    }
  }

  function setInstrumented(on: boolean): { ok: true; message: string } {
    if (on && !instrumentation) {
      instrumentation = instrumentPipes(onPipeCall, ownerNames);
      instrumented = true;
      void pushPipes();
      return { ok: true, message: 'Recording pipe calls, inputs/outputs and callers.' };
    }
    if (!on && instrumentation) {
      instrumentation.stop();
      instrumentation = null;
      instrumented = false;
      void pushPipes();
    }
    return { ok: true, message: on ? 'Already recording.' : 'Stopped recording.' };
  }

  my.rpc.register({
    name: 'instrument-pipes',
    type: 'event',
    jsonSerializable: true,
    handler: (on: boolean) => setInstrumented(on !== false),
  });

  return {
    push: () => void pushPipes(),
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      lastPayload = '';
      void pushPipes();
    },
    stop() {
      paused = true;
      instrumentation?.stop();
      instrumentation = null;
      instrumented = false;
    },
  };
}
