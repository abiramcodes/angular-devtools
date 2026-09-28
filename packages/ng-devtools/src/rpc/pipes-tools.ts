// Pages heartbeat every few seconds, so a closed tab whose `forget` message
// never arrived drops out of the panel (and its `| async` entries with it) fast.
const PAGE_EXPIRES_MS = 15_000;
const MAX_MERGED_INSTANCES = 10;

function isRecord(value: unknown): value is object {
  return !!value && typeof value === 'object';
}

export interface PipeComponentUsage {
  /** Owning component's class name, best-effort (falls back to "?"). */
  name: string;
  count: number;
}

/** One pipe instance's most recent call, for when several usages of the same
 * pipe see different values. */
export interface PipeInstanceCall {
  component: string;
  callCount: number;
  lastArgs?: unknown[];
  lastResult?: unknown;
  lastCaller?: string;
}

export interface PipeCallInfo {
  callCount: number;
  /** Most recent call per instance (capped), present when more than one instance has been called. */
  instances?: PipeInstanceCall[];
  lastArgs?: unknown[];
  lastResult?: unknown;
  lastCaller?: string;
}

export interface StaleFinding {
  detectedAt: number;
}

export interface PipeUsageInfo {
  name: string;
  className: string;
  isPure: boolean;
  instanceCount: number;
  components: PipeComponentUsage[];
  /** Present only once instrumentation is on and at least one real call happened. */
  call?: PipeCallInfo;
  /** Present only once a stale-pure-pipe finding has fired for this pipe. Experimental. */
  stale?: StaleFinding;
}

export interface AsyncUsageInfo {
  /** Owning component's class name, best-effort. */
  component: string;
  hasSource: boolean;
  /** Best-effort, size-capped description of the latest emitted value. */
  latestValue?: string;
  /** Another `| async` usage on the page is subscribed to the same source. */
  duplicate: boolean;
}

export interface PipesState {
  pipes: PipeUsageInfo[];
  async: AsyncUsageInfo[];
  reportedAt: number;
  /** Page ids that currently have instrumentation switched on. */
  instrumented: string[];
}

export interface PipePageReport {
  pageId: string;
  pipes: PipeUsageInfo[];
  async?: AsyncUsageInfo[];
  instrumented?: boolean;
}

function isPipeComponentUsage(value: unknown): value is PipeComponentUsage {
  if (!isRecord(value)) return false;
  const usage: Partial<PipeComponentUsage> = value;
  return typeof usage.name === 'string' && typeof usage.count === 'number';
}

function isPipeUsageInfo(value: unknown): value is PipeUsageInfo {
  if (!isRecord(value)) return false;
  const info: Partial<PipeUsageInfo> = value;
  return (
    typeof info.name === 'string' &&
    typeof info.className === 'string' &&
    typeof info.isPure === 'boolean' &&
    typeof info.instanceCount === 'number' &&
    Array.isArray(info.components) &&
    info.components.every(isPipeComponentUsage)
  );
}

function isAsyncUsageInfo(value: unknown): value is AsyncUsageInfo {
  if (!isRecord(value)) return false;
  const usage: Partial<AsyncUsageInfo> = value;
  return (
    typeof usage.component === 'string' &&
    typeof usage.hasSource === 'boolean' &&
    typeof usage.duplicate === 'boolean' &&
    (usage.latestValue === undefined || typeof usage.latestValue === 'string')
  );
}

export function isPipePageReport(value: unknown): value is PipePageReport {
  if (!isRecord(value)) return false;
  const report: Partial<PipePageReport> = value;
  return (
    typeof report.pageId === 'string' &&
    Array.isArray(report.pipes) &&
    report.pipes.every(isPipeUsageInfo) &&
    (report.async === undefined ||
      (Array.isArray(report.async) && report.async.every(isAsyncUsageInfo))) &&
    (report.instrumented === undefined || typeof report.instrumented === 'boolean')
  );
}

type Pages = Map<string, PipePageReport & { reportedAt: number }>;

/** Same-named pipes reported by several pages collapse into one record so
 * consumers looking a pipe up by name see every page's data, not just the
 * first page's. */
function aggregatePipes(all: (PipePageReport & { reportedAt: number })[]): PipeUsageInfo[] {
  const byName = new Map<string, PipeUsageInfo>();
  const callAt = new Map<string, number>();
  for (const page of all) {
    for (const pipe of page.pipes) {
      const existing = byName.get(pipe.name);
      if (!existing) {
        byName.set(pipe.name, {
          ...pipe,
          components: pipe.components.map((c) => ({ ...c })),
          call: pipe.call && { ...pipe.call },
        });
        if (pipe.call) callAt.set(pipe.name, page.reportedAt);
        continue;
      }
      existing.instanceCount += pipe.instanceCount;
      for (const component of pipe.components) {
        const match = existing.components.find((c) => c.name === component.name);
        if (match) match.count += component.count;
        else existing.components.push({ ...component });
      }
      if (pipe.call) {
        if (!existing.call) {
          existing.call = { ...pipe.call };
          callAt.set(pipe.name, page.reportedAt);
        } else {
          const newer = page.reportedAt >= (callAt.get(pipe.name) ?? 0);
          existing.call = {
            ...(newer ? pipe.call : existing.call),
            callCount: existing.call.callCount + pipe.call.callCount,
            instances: [...(existing.call.instances ?? []), ...(pipe.call.instances ?? [])].slice(
              0,
              MAX_MERGED_INSTANCES,
            ),
          };
          if (newer) callAt.set(pipe.name, page.reportedAt);
        }
      }
      if (pipe.stale && (!existing.stale || pipe.stale.detectedAt > existing.stale.detectedAt)) {
        existing.stale = pipe.stale;
      }
    }
  }
  return Array.from(byName.values());
}

function stateOf(pages: Pages): PipesState {
  const all = Array.from(pages.values());
  return {
    pipes: aggregatePipes(all),
    async: all.flatMap((page) => page.async ?? []),
    reportedAt: all.length ? Math.min(...all.map((page) => page.reportedAt)) : 0,
    instrumented: all.filter((page) => page.instrumented).map((page) => page.pageId),
  };
}

export function currentPipes(pages: Pages): PipesState {
  return stateOf(pages);
}

export function expirePipePages(pages: Pages, now = Date.now()): PipesState | null {
  let expired = false;
  for (const [id, page] of pages) {
    if (now - page.reportedAt > PAGE_EXPIRES_MS) {
      pages.delete(id);
      expired = true;
    }
  }
  return expired ? stateOf(pages) : null;
}

export function mergePipePageReport(
  pages: Pages,
  report: PipePageReport,
  now = Date.now(),
): PipesState {
  pages.set(report.pageId, { ...report, reportedAt: now });
  expirePipePages(pages, now);
  return stateOf(pages);
}
