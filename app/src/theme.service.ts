import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';

type Theme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly current = signal<Theme>('dark');

  constructor() {
    const attr = document.documentElement.dataset.theme;
    if (attr === 'light' || attr === 'dark') {
      this.current.set(attr);
    } else {
      // Hub path: read from .devframes-color-root class when no explicit ?theme= param
      const hubTheme = readHubTheme();
      if (hubTheme) {
        this.current.set(hubTheme);
        document.documentElement.dataset.theme = hubTheme;
      } else {
        try {
          if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            this.current.set('light');
          }
        } catch {
          // environments without matchMedia (e.g. jsdom): default to dark
        }
      }
    }

    let bc: BroadcastChannel | undefined;
    try {
      bc = new BroadcastChannel('ng-devtools:theme');
    } catch {}
    effect(() => {
      const theme = this.current();
      try {
        bc?.postMessage(theme);
      } catch {}
      try {
        let w: Window = window;
        while (w !== w.parent) {
          w = w.parent;
          w.postMessage({ type: 'ng-devtools:theme-change', theme }, '*');
        }
      } catch {}
    });

    // Chrome extension: live theme changes via postMessage
    const handler = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const msg = e.data as { type?: unknown; theme?: unknown } | null;
      if (msg?.type !== 'ng-devtools:theme-change') return;
      const t: Theme = msg.theme === 'dark' ? 'dark' : 'light';
      this.current.set(t);
      document.documentElement.dataset.theme = t;
    };
    window.addEventListener('message', handler);

    // Hub path: watch .devframes-color-root class for live color mode changes
    const colorRoot = getHubColorRoot();
    let observer: MutationObserver | null = null;
    if (colorRoot) {
      observer = new MutationObserver(() => {
        const t: Theme = colorRoot.classList.contains('dark') ? 'dark' : 'light';
        this.current.set(t);
        document.documentElement.dataset.theme = t;
      });
      observer.observe(colorRoot, { attributes: true, attributeFilter: ['class'] });
    }

    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('message', handler);
      observer?.disconnect();
    });
  }
}

function readHubTheme(): Theme | null {
  try {
    const el = window.frameElement?.closest('.devframes-color-root');
    if (!el) return null;
    return el.classList.contains('dark') ? 'dark' : 'light';
  } catch {
    return null;
  }
}

function getHubColorRoot(): Element | null {
  try {
    return window.frameElement?.closest('.devframes-color-root') ?? null;
  } catch {
    return null;
  }
}
