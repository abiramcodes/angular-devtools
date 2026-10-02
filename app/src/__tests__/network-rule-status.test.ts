import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NetworkInspector } from '../pages/network-inspector';

let fixture: ComponentFixture<NetworkInspector>;

async function mount() {
  fixture = TestBed.createComponent(NetworkInspector);
  document.body.append(fixture.nativeElement);
  await fixture.whenStable();
  const host = fixture.nativeElement as HTMLElement;
  const pattern = host.querySelector<HTMLInputElement>('#rule-pattern')!;
  pattern.value = '/api/products';
  pattern.dispatchEvent(new Event('input'));
  await fixture.whenStable();
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-labelledby="rule-status-label"]',
  )!;
  const hint = () => host.querySelector('#rule-hint')!.textContent!.trim();
  return { host, trigger, hint, inspector: fixture.componentInstance };
}

describe('NetworkInspector rule status', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('labels the status dropdown and lists no 1xx statuses', async () => {
    const { host, trigger } = await mount();
    expect(host.querySelector('#rule-status-label')!.textContent!.trim()).toBe('Status');
    expect(trigger.textContent!.trim()).toBe('None');
    trigger.click();
    await fixture.whenStable();
    const labels = [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent!.trim());
    expect(labels[0]).toBe('None');
    expect(labels.some((l) => l.startsWith('1'))).toBe(false);
    expect(labels).toContain('499 Client Closed Request');
    expect(labels).toContain('524 A Timeout Occurred');
  });

  it('sets the rule status from the option picked in the dropdown', async () => {
    const { host, trigger, inspector } = await mount();
    trigger.click();
    await fixture.whenStable();
    const option = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent!.trim() === '503 Service Unavailable',
    )!;
    option.click();
    await fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent!.trim()).toBe('503 Service Unavailable');
    expect(inspector.draft().status).toBe('503');
    expect(inspector.draftRule()).toMatchObject({ pattern: '/api/products', status: 503 });
  });

  it('picks a status by typing its code', async () => {
    const { trigger, inspector } = await mount();
    trigger.focus();
    for (const key of '404') {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    await fixture.whenStable();
    expect(inspector.draft().status).toBe('404');
    expect(inspector.draftRule()).toMatchObject({ status: 404 });
  });

  it('refuses a status that is not in the list', async () => {
    const { hint, inspector } = await mount();
    for (const status of ['599', '101', '42', 'abc']) {
      inspector.setDraft('status', status);
      await fixture.whenStable();
      expect(inspector.draftRule()).toBeNull();
      expect(hint()).toBe('Pick a status from the list.');
    }
    inspector.setDraft('status', '520');
    await fixture.whenStable();
    expect(inspector.draftRule()).toMatchObject({ status: 520 });
    expect(hint()).toBe('');
  });
});
