import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import type { DevframeRpcClient } from 'devframe/client';

interface UsageSite {
  file: string;
  line: number;
}

interface PipeInfo {
  name: string;
  className: string;
  file: string;
  line: number;
  isStandalone: boolean;
  isPure: boolean;
  builtin?: boolean;
  usageCount?: number;
  usages?: UsageSite[];
}

interface PipeComponentUsage {
  name: string;
  count: number;
}

interface PipeInstanceCall {
  component: string;
  callCount: number;
  lastArgs?: unknown[];
  lastResult?: unknown;
}

interface PipeCallInfo {
  callCount: number;
  instances?: PipeInstanceCall[];
  lastArgs?: unknown[];
  lastResult?: unknown;
  lastCaller?: string;
}

interface StaleFinding {
  detectedAt: number;
}

interface LivePipeInfo {
  name: string;
  className: string;
  isPure: boolean;
  instanceCount: number;
  components: PipeComponentUsage[];
  call?: PipeCallInfo;
  stale?: StaleFinding;
}

interface AsyncUsageInfo {
  component: string;
  hasSource: boolean;
  latestValue?: string;
  duplicate: boolean;
}

interface PipeLintFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  pipe: string;
  file: string;
  line: number;
  message: string;
  fix: string;
}

interface PipesSnapshot {
  pipes: LivePipeInfo[];
  async: AsyncUsageInfo[];
  instrumented: string[];
}

@Component({
  selector: 'app-pipes-inspector',
  template: `
    <div class="toolbar">
      <input
        #filterInput
        type="text"
        placeholder="Filter pipes…"
        [value]="filter()"
        (input)="filter.set(filterInput.value)"
      />
      <button (click)="refresh()">Refresh</button>
      <button
        class="instrument"
        [class.on]="instrumenting()"
        [attr.aria-pressed]="instrumenting()"
        (click)="toggleInstrument()"
      >
        {{ instrumenting() ? 'Stop instrumenting' : 'Instrument' }}
      </button>
    </div>
    @if (instrumenting()) {
      <p class="muted instrument-hint">
        Recording live call counts, instance counts and last input/output. This patches pipe
        prototypes in the inspected page, so turn it off when you're done.
      </p>
    }

    @if (loading()) {
      <p class="muted">Scanning pipes…</p>
    } @else if (filtered().length === 0) {
      <p class="muted">No pipes found.</p>
    } @else {
      <ul class="pipe-list" role="list">
        @for (p of filtered(); track p.file + p.name) {
          <li class="pipe-item" [class.expanded]="isSelected(p)">
            <button class="pipe-toggle" [attr.aria-expanded]="isSelected(p)" (click)="select(p)">
              <div class="name-row">
                <span class="badge" [class.impure]="!p.isPure">{{
                  p.isPure ? 'pure' : 'impure'
                }}</span>
                <span class="name">{{ p.name }}</span>
                @if (!p.isStandalone) {
                  <span class="badge module">module</span>
                }
                @if (p.builtin) {
                  <span class="badge builtin">built-in</span>
                }
              </div>
              <div class="file">
                {{ p.file }}:{{ p.line }}
                @if (p.builtin && (p.usageCount ?? 0) > 1) {
                  <span class="usage-count">+{{ (p.usageCount ?? 1) - 1 }} more</span>
                }
              </div>
            </button>
            @if (isSelected(p)) {
              <div class="inline-detail">
                <dl>
                  <dt>Class</dt>
                  <dd>{{ p.className }}</dd>
                  <dt>Source</dt>
                  <dd>{{ p.builtin ? '@angular/common' : 'This project' }}</dd>
                  @if (!p.builtin) {
                    <dt>File</dt>
                    <dd>{{ p.file }}:{{ p.line }}</dd>
                  }
                  <dt>Standalone</dt>
                  <dd>{{ p.isStandalone ? 'Yes' : 'No' }}</dd>
                  <dt>Pure</dt>
                  <dd>{{ p.isPure ? 'Yes' : 'No' }}</dd>
                  @if (p.builtin && p.usages?.length) {
                    <dt>Used in ({{ p.usageCount }})</dt>
                    <dd>
                      <ul class="usage-list">
                        @for (u of p.usages; track u.file + ':' + u.line) {
                          <li>{{ u.file }}:{{ u.line }}</li>
                        }
                      </ul>
                    </dd>
                  }
                </dl>
                @if (liveFor(p.name); as live) {
                  <div class="live-section">
                    <div class="live-heading">Live</div>
                    @if (live.stale) {
                      <p class="stale-warning">
                        <span class="badge impure">experimental</span>
                        Fed an argument that changed contents without changing reference — this pure
                        pipe may be showing a stale value.
                      </p>
                    }
                    <dl>
                      <dt>Instances</dt>
                      <dd>{{ live.instanceCount }}</dd>
                      <dt>Used by</dt>
                      <dd>
                        <ul class="usage-list">
                          @for (c of live.components; track c.name) {
                            <li>{{ c.name }} ({{ c.count }})</li>
                          }
                        </ul>
                      </dd>
                      @if (live.call; as call) {
                        <dt>Calls</dt>
                        <dd>{{ call.callCount }}</dd>
                        <dt>Last input</dt>
                        <dd class="mono">{{ describe(call.lastArgs) }}</dd>
                        <dt>Last output</dt>
                        <dd class="mono">{{ describe(call.lastResult) }}</dd>
                        @if (call.instances?.length) {
                          <dt>Per instance</dt>
                          <dd>
                            <ul class="usage-list">
                              @for (i of call.instances; track $index) {
                                <li class="mono">
                                  {{ describe(i.lastArgs) }} → {{ describe(i.lastResult) }} ({{
                                    i.callCount
                                  }})
                                </li>
                              }
                            </ul>
                          </dd>
                        }
                        @if (call.lastCaller) {
                          <dt>Last caller</dt>
                          <dd class="mono">{{ call.lastCaller }}</dd>
                        }
                      } @else if (instrumenting()) {
                        <dt>Calls</dt>
                        <dd class="muted">None recorded yet.</dd>
                      }
                    </dl>
                  </div>
                } @else if (instrumenting()) {
                  <p class="muted live-hint">Not seen on the page yet.</p>
                }
              </div>
            }
          </li>
        }
      </ul>
    }

    @if (async().length > 0) {
      <div class="async-panel">
        <h3 class="async-heading">Async pipes ({{ async().length }})</h3>
        <ul class="async-list" role="list">
          @for (a of async(); track $index) {
            <li class="async-item">
              <div class="async-row">
                <span class="component">{{ a.component }}</span>
                @if (!a.hasSource) {
                  <span class="badge module">no source</span>
                }
                @if (a.duplicate) {
                  <span class="badge impure">duplicate subscription</span>
                }
              </div>
              <div class="mono async-value">{{ a.latestValue ?? '(none yet)' }}</div>
            </li>
          }
        </ul>
      </div>
    }

    <div class="lint-panel">
      <h3 class="async-heading">Lint</h3>
      @if (lintFailed()) {
        <p class="muted" role="alert">Couldn't run the lint check. Try Refresh.</p>
      } @else if (lint() === null) {
        <p class="muted">Checking…</p>
      } @else if (!lint()!.length) {
        <p class="muted">No problems found.</p>
      } @else {
        <ul class="findings" role="list">
          @for (f of lint(); track $index) {
            <li class="finding">
              <span
                class="tag"
                [attr.data-tone]="
                  f.severity === 'info' ? '' : f.severity === 'error' ? 'bad' : 'warn'
                "
                >{{ f.severity }}</span
              >
              <code class="finding-rule">{{ f.rule }}</code>
              <span class="finding-meta muted">on {{ f.pipe }} at {{ f.file }}:{{ f.line }}</span>
              <div class="finding-message">{{ f.message }}</div>
              <div class="finding-fix muted">Fix: {{ f.fix }}</div>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    input {
      flex: 1;
      padding: 8px 12px;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 6px;
      color: #e4e4e7;
      font-size: 14px;
      outline: none;
    }
    input:focus {
      border-color: var(--accent);
    }
    button {
      padding: 8px 16px;
      background: #3f3f46;
      border: none;
      border-radius: 6px;
      color: #e4e4e7;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover {
      background: #52525b;
    }
    button.instrument.on {
      background: #7c2d12;
      color: #fdba74;
    }
    .muted {
      color: #71717a;
      font-size: 14px;
    }
    .instrument-hint {
      margin: -8px 0 16px;
    }
    .live-section {
      padding: 12px 16px 4px;
      border-top: 1px solid #27272a;
    }
    .live-heading {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #71717a;
      margin-bottom: 8px;
    }
    .live-hint {
      padding: 0 16px 12px;
      margin: 0;
    }
    .stale-warning {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 12px;
      color: #fdba74;
      background: #431407;
      border-radius: 6px;
      padding: 8px 10px;
      margin: 0 0 12px;
    }
    .mono {
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .pipe-list {
      list-style: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pipe-item {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 0;
      transition: border-color 0.15s;
    }
    .pipe-item:has(.pipe-toggle:hover) {
      border-color: var(--accent);
    }
    .pipe-item.expanded {
      border-color: var(--accent);
    }
    .pipe-toggle {
      display: block;
      width: 100%;
      padding: 12px 16px;
      background: none;
      border: none;
      color: inherit;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .name-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .name {
      font-family: monospace;
      font-size: 15px;
      color: var(--accent);
      font-weight: 600;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: #14532d;
      color: #4ade80;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge.impure {
      background: #7c2d12;
      color: #fdba74;
    }
    .badge.module {
      background: #3f3f46;
      color: #a1a1aa;
    }
    .badge.builtin {
      background: #1e3a8a;
      color: #93c5fd;
    }
    .file {
      font-size: 12px;
      color: #71717a;
      margin-top: 2px;
    }
    .usage-count {
      margin-left: 6px;
      color: #52525b;
    }
    .usage-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .inline-detail {
      padding: 0 16px 12px;
      border-top: 1px solid #27272a;
      margin-top: 0;
      padding-top: 12px;
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      font-size: 13px;
    }
    dt {
      color: #71717a;
    }
    dd {
      color: #e4e4e7;
    }
    .async-panel {
      margin-top: 20px;
    }
    .async-heading {
      font-size: 13px;
      font-weight: 600;
      color: #a1a1aa;
      margin: 0 0 8px;
    }
    .async-list {
      list-style: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .async-item {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 10px 16px;
    }
    .async-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .component {
      font-family: monospace;
      font-size: 13px;
      color: var(--accent);
    }
    .async-value {
      margin-top: 4px;
      color: #a1a1aa;
    }
    .lint-panel {
      margin-top: 20px;
    }
    .findings {
      list-style: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
    }
    .finding {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 10px 16px;
    }
    .finding-rule {
      color: #c4b5fd;
    }
    .finding-meta,
    .finding-message,
    .finding-fix {
      display: block;
      margin-top: 0.5rem;
    }
    .tag {
      display: inline-block;
      margin: 0 4px 2px 0;
      padding: 0 5px;
      border: 1px solid #3f3f46;
      border-radius: 4px;
      color: #d4d4d8;
      font-size: 11px;
    }
    .tag[data-tone='warn'] {
      border-color: #a16207;
      color: #fef08a;
    }
    .tag[data-tone='bad'] {
      border-color: #b91c1c;
      color: #fca5a5;
    }
  `,
})
export class PipesInspector {
  private readonly destroyRef = inject(DestroyRef);

  rpc = input<DevframeRpcClient | null>(null);

  pipes = signal<PipeInfo[]>([]);
  filter = signal('');
  loading = signal(false);
  selected = signal<PipeInfo | null>(null);

  filtered = signal<PipeInfo[]>([]);

  live = signal<LivePipeInfo[]>([]);
  async = signal<AsyncUsageInfo[]>([]);
  lint = signal<PipeLintFinding[] | null>(null);
  lintFailed = signal(false);
  instrumentedPages = signal<string[]>([]);
  instrumenting = signal(false);

  private unsubscribe?: () => void;

  constructor() {
    effect(() => {
      const q = this.filter().toLowerCase();
      const all = this.pipes();
      this.filtered.set(
        q
          ? all.filter(
              (p) =>
                p.name.toLowerCase().includes(q) ||
                p.className.toLowerCase().includes(q) ||
                p.file.toLowerCase().includes(q),
            )
          : all,
      );
    });

    effect(() => {
      const client = this.rpc();
      if (client) {
        this.refresh();
        this.loadLive(client);
      }
    });

    this.destroyRef.onDestroy(() => this.unsubscribe?.());
  }

  async refresh() {
    const client = this.rpc();
    if (!client) return;
    this.loading.set(true);
    try {
      const my = client.scope('ng-devtools');
      const pipes = (await my.rpc.call('get-pipes')) as PipeInfo[];
      this.pipes.set(pipes);
      const sel = this.selected();
      if (sel) {
        const refreshed = pipes.find((p) => p.name === sel.name && p.file === sel.file);
        this.selected.set(refreshed ?? null);
      }
    } catch {
      // RPC not available
    } finally {
      this.loading.set(false);
    }
    this.loadLint(client);
  }

  async loadLint(client: DevframeRpcClient) {
    this.lintFailed.set(false);
    try {
      const findings = (await client
        .scope('ng-devtools')
        .rpc.call('pipe-lint')) as PipeLintFinding[];
      this.lint.set(findings);
    } catch {
      this.lintFailed.set(true);
    }
  }

  async loadLive(client: DevframeRpcClient) {
    try {
      const state = await client.scope('ng-devtools').rpc.sharedState('pipe-usage');
      if (this.destroyRef.destroyed) return;
      const apply = (value: unknown) => {
        const snapshot = value as PipesSnapshot | undefined;
        this.live.set(snapshot?.pipes ?? []);
        this.async.set(snapshot?.async ?? []);
        const pages = snapshot?.instrumented ?? [];
        this.instrumentedPages.set(pages);
        this.instrumenting.set(pages.length > 0);
      };
      apply(state.value());
      this.unsubscribe?.();
      this.unsubscribe = state.on('updated', apply);
    } catch {
      // RPC not available
    }
  }

  async toggleInstrument() {
    const client = this.rpc();
    if (!client) return;
    const on = !this.instrumenting();
    this.instrumenting.set(on);
    try {
      await client.scope('ng-devtools').rpc.call('request-instrument-pipes', on);
    } catch {
      this.instrumenting.set(!on);
    }
  }

  liveFor(name: string): LivePipeInfo | undefined {
    return this.live().find((p) => p.name === name);
  }

  describe(value: unknown): string {
    if (Array.isArray(value)) return value.map((v) => this.describe(v)).join(', ');
    if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
    try {
      const json = JSON.stringify(value);
      return json && json.length > 120 ? `${json.slice(0, 120)}…` : (json ?? String(value));
    } catch {
      return String(value);
    }
  }

  isSelected(pipe: PipeInfo): boolean {
    const sel = this.selected();
    return sel !== null && sel.name === pipe.name && sel.file === pipe.file;
  }

  select(pipe: PipeInfo) {
    this.selected.set(this.isSelected(pipe) ? null : pipe);
  }
}
