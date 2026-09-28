import { createHostContext } from 'devframe/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ngDevtools from '../devframe.ts';
import type { PipePageReport } from '../rpc/pipes-tools.ts';

async function boot() {
  const host = {
    mountStatic: () => {},
    resolveOrigin: () => 'http://localhost',
    getStorageDir: () => '',
  };
  const ctx = await createHostContext({ cwd: process.cwd(), mode: 'dev', host: host as never });
  await ngDevtools.setup(ctx as never);
  const invoke = (name: string, ...args: unknown[]) =>
    ctx.rpc.invokeLocal(`ng-devtools:${name}` as never, ...(args as never));
  const explain = async () =>
    (
      (await ctx.agent.invoke('ng-devtools:explain-pipe', { name: 'async' })) as {
        markdown: string;
      }
    ).markdown;
  return { ctx, invoke, explain };
}

function page(pageId: string): PipePageReport {
  return {
    pageId,
    pipes: [
      {
        name: 'async',
        className: 'AsyncPipe',
        isPure: false,
        instanceCount: 3,
        components: [{ name: 'ExamplePage', count: 3 }],
      },
    ],
    async: [1, 2, 3].map(() => ({ component: 'ExamplePage', hasSource: true, duplicate: false })),
    instrumented: false,
  };
}

describe('pipe pages across tabs', () => {
  afterEach(() => vi.useRealTimers());

  it('drops a closed tab so reopening does not stack its instances', async () => {
    vi.useFakeTimers();
    const { invoke, explain } = await boot();

    await invoke('push-pipes', page('tab-1'));
    expect(await explain()).toContain('3 instance(s)');

    // tab-1 closes without a `forget`; a new tab opens 20s later.
    await vi.advanceTimersByTimeAsync(20_000);
    await invoke('push-pipes', page('tab-2'));
    expect(await explain()).toContain('3 instance(s)');
  });
});

describe('pipe pages and their connections', () => {
  it('drops a page the moment its connection closes', async () => {
    const { ctx, invoke, explain } = await boot();
    const host = ctx.rpc as unknown as {
      getCurrentRpcSession: () => unknown;
      _emitSessionDisconnected: (meta: { id: number }) => void;
    };

    host.getCurrentRpcSession = () => ({ meta: { id: 1 } });
    await invoke('push-pipes', page('tab-1'));
    host.getCurrentRpcSession = () => ({ meta: { id: 2 } });
    await invoke('push-pipes', page('tab-2'));
    expect(await explain()).toContain('6 instance(s)');

    host._emitSessionDisconnected({ id: 1 });
    expect(await explain()).toContain('3 instance(s)');

    // A reconnect re-binds the page to its new connection, so the old
    // connection closing afterwards must not drop it.
    host.getCurrentRpcSession = () => ({ meta: { id: 3 } });
    await invoke('push-pipes', page('tab-2'));
    host._emitSessionDisconnected({ id: 2 });
    expect(await explain()).toContain('3 instance(s)');
  });
});
