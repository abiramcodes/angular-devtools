import { callerFrom } from './forms-instrument.ts';

type AnyRecord = Record<string, any>;

export interface NgDebugApi {
  getComponent(el: Element): unknown;
  getOwningComponent?(el: Element): unknown;
  getDirectives?(el: Element): unknown[];
}

function read<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

interface PipeDefShape {
  name: string;
  type: new (...args: unknown[]) => unknown;
  pure: boolean;
}

/** A pipe's compiled definition, duck-typed: `PipeDef` shares `tView.data`
 * with `DirectiveDef`/`ComponentDef`, which have no `pure` flag. */
function isPipeDef(value: unknown): value is PipeDefShape {
  if (!value || typeof value !== 'object') return false;
  const def: Partial<PipeDefShape> = value;
  return (
    typeof def.name === 'string' && typeof def.pure === 'boolean' && typeof def.type === 'function'
  );
}

/** The LView an element belongs to, via the same `__ngContext__` monkey-patch
 * Angular's own `getComponent`/`getOwningComponent` read internally. Only
 * resolves once something (Angular itself, or us calling `ng.getComponent`
 * first) has "upgraded" `__ngContext__` from a bare numeric id to a real
 * `LContext` — a bare number can't be resolved from outside `@angular/core`. */
function lViewOf(el: Element): AnyRecord[] | null {
  const ctx = (el as AnyRecord)['__ngContext__'];
  if (!ctx || typeof ctx !== 'object') return null;
  const lView = read(() => ctx.lView, null);
  return Array.isArray(lView) ? lView : null;
}

export interface PipeSlot {
  name: string;
  className: string;
  isPure: boolean;
  instance: AnyRecord;
  /** Index into both `tView.data` and this `lView`. */
  index: number;
  lView: AnyRecord[];
}

/** Every pipe instance created in `lView`'s view, read straight off
 * `tView.data`/`lView` (see `ɵɵpipe` in `@angular/core`: it stores the
 * `PipeDef` and the live instance at the same index in each). Read-only;
 * never mutates the view. */
export function pipeSlotsIn(lView: AnyRecord[]): PipeSlot[] {
  const tView = read(() => lView[1], null) as { data?: unknown[] } | null;
  const data = tView?.data;
  if (!Array.isArray(data)) return [];
  const slots: PipeSlot[] = [];
  for (let i = 0; i < data.length; i++) {
    const def = data[i];
    if (!isPipeDef(def)) continue;
    const instance = lView[i];
    if (!instance || typeof instance !== 'object') continue;
    slots.push({
      name: def.name,
      className: def.type.name || 'Pipe',
      isPure: def.pure,
      instance,
      index: i,
      lView,
    });
  }
  return slots;
}

export interface PipeUsage {
  name: string;
  className: string;
  isPure: boolean;
  instance: AnyRecord;
  lView: AnyRecord[];
  /** The nearest component instance, for attributing the usage in the UI. */
  component: unknown;
}

/** Walks `elements`, finds every distinct view reachable from them, and
 * returns every pipe instance in use. Calling `ng.getOwningComponent`/
 * `ng.getComponent` is what upgrades `__ngContext__` so `lViewOf` can read
 * it — this mirrors `forms.ts`'s `findForms` DOM walk. */
export function findPipeUsages(ng: NgDebugApi, elements: Iterable<Element>): PipeUsage[] {
  const seenLViews = new Set<AnyRecord[]>();
  const usages: PipeUsage[] = [];
  for (const el of elements) {
    const component =
      read(() => ng.getComponent(el), null) ??
      read(() => ng.getOwningComponent?.(el) ?? null, null);
    if (component === null || component === undefined) continue;
    const lView = lViewOf(el);
    if (!lView || seenLViews.has(lView)) continue;
    seenLViews.add(lView);
    for (const slot of pipeSlotsIn(lView)) {
      usages.push({
        name: slot.name,
        className: slot.className,
        isPure: slot.isPure,
        instance: slot.instance,
        lView,
        component,
      });
    }
  }
  return usages;
}

export interface PipeCall {
  name: string;
  /** The instance that actually ran: several usages of the same pipe class
   * share one patched prototype, so this is how a caller tells them apart. */
  instance: AnyRecord;
  args: unknown[];
  result: unknown;
  caller?: string;
}

/** What `addPipe` needs: both `PipeSlot` and `PipeUsage` satisfy this. */
export interface PipeInstance {
  name: string;
  instance: AnyRecord;
}

export interface PipeInstrumentation {
  /** Patches `slot`'s prototype once; a no-op if already patched. */
  addPipe(slot: PipeInstance): void;
  stop(): void;
}

const WRAPPED = Symbol('ng-devtools-pipe-wrapped');

/** Patches each distinct pipe class's `transform` once, the same technique
 * `forms-instrument.ts`'s `instrumentForms` uses for `FormControl` methods:
 * since `pipeInstance.transform` is a live lookup at the `ɵɵpipeBind*` call
 * site, our wrapper is invoked whenever Angular actually calls it (i.e. for
 * an impure pipe every check, for a pure one only when memoization decided
 * the argument changed). */
export function instrumentPipes(
  onCall: (call: PipeCall) => void,
  preferred: ReadonlySet<string> = new Set(),
): PipeInstrumentation {
  const seenProtos = new WeakSet<object>();
  const restores: (() => void)[] = [];
  // A pipe instance is created by one template call site, so its caller
  // never changes: resolving it once per instance keeps the (costly) stack
  // capture off the hot path of every later `transform` call.
  const callers = new WeakMap<object, string | undefined>();

  const callerOf = (instance: AnyRecord): string | undefined => {
    if (callers.has(instance)) return callers.get(instance);
    // Drop the "Error" header and this wrapper's own frame.
    const stack = new Error().stack?.split('\n');
    const caller = stack ? callerFrom(['', ...stack.slice(3)].join('\n'), preferred) : undefined;
    callers.set(instance, caller);
    return caller;
  };

  return {
    addPipe(slot) {
      const proto = Object.getPrototypeOf(slot.instance);
      if (!proto || seenProtos.has(proto)) return;
      seenProtos.add(proto);
      const original = proto.transform;
      if (typeof original !== 'function' || (original as any)[WRAPPED]) return;
      const wrapper = function (this: AnyRecord, ...args: unknown[]) {
        const result = original.apply(this, args);
        try {
          onCall({
            name: slot.name,
            instance: this,
            args,
            result,
            caller: callerOf(this),
          });
        } catch {
          // never break the app
        }
        return result;
      };
      Object.defineProperty(wrapper, WRAPPED, { value: true });
      try {
        proto.transform = wrapper;
      } catch {
        return;
      }
      restores.push(() => {
        if (proto.transform === wrapper) proto.transform = original;
      });
    },
    stop() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}

/** What the stale-pipe check needs: satisfied by both `PipeSlot` and
 * `PipeUsage`. */
export interface PipeBinding {
  name: string;
  isPure: boolean;
  instance: AnyRecord;
  lView: AnyRecord[];
}

export interface StaleCheck {
  bindingRoot: number;
  slotOffset: number;
}

/**
 * EXPERIMENTAL. A pure pipe's `transform` is only ever called when Angular's
 * own memoization sees the bound argument's *reference* change — so patching
 * `transform` (as `instrumentPipes` does) can never observe a same-reference,
 * mutated-in-place argument. Catching that needs the raw LView slot Angular
 * itself compares against, which sits at `tView.bindingStartIndex +
 * slotOffset` — and `slotOffset` is a compile-time constant with no runtime
 * lookup, baked directly into the compiled template's `ɵɵpipeBind*` call.
 *
 * This recovers it by regex-scanning `tView.template.toString()` (available
 * in dev/unminified builds) for the pipe's own `ɵɵpipe(index, name)` call to
 * get its raw index, then for a call passing that same index as its first
 * argument to get the binding's `slotOffset`. The pipe-creation call is
 * matched by shape (`ident(N, 'name')`), but the binding call must be a
 * `pipeBind` instruction so an unrelated call sharing the same first numeric
 * argument can't supply the offset. It tolerates both AOT names
 * (`ɵɵpipeBind1`) and JIT names (`jit___pipeBind1_8`). Returns `null`
 * whenever anything doesn't match; never throws.
 */
export function staleCheckFor(slot: PipeBinding): StaleCheck | null {
  return read(() => {
    const tView = slot.lView[1] as { template?: Function; bindingStartIndex?: number } | null;
    const templateFn = tView?.template;
    const bindingRoot = tView?.bindingStartIndex;
    if (typeof templateFn !== 'function' || typeof bindingRoot !== 'number') return null;
    const src = templateFn.toString();
    const escapedName = slot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const create = new RegExp(`\\w+\\(\\s*(\\d+)\\s*,\\s*['"\`]${escapedName}['"\`]\\s*\\)`).exec(
      src,
    );
    if (!create) return null;
    const bind = new RegExp(
      `[\\w$\\u0275]*pipeBind\\w*\\(\\s*${create[1]}\\s*,\\s*(\\d+)\\s*[,)]`,
    ).exec(src);
    if (!bind) return null;
    const slotOffset = Number(bind[1]);
    return Number.isFinite(slotOffset) ? { bindingRoot, slotOffset } : null;
  }, null);
}

/** The raw argument value Angular last compared this binding against —
 * `undefined` if the slot isn't there (a stale/invalid `check`, or a view
 * shape this Angular version doesn't lay out the way `staleCheckFor` expects). */
export function readBoundArg(slot: PipeBinding, check: StaleCheck): unknown {
  return read(() => slot.lView[check.bindingRoot + check.slotOffset], undefined);
}
