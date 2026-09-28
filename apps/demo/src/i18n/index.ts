/**
 * The page's language: Japanese (default) or English. One message catalog per language (ja.ts, en.ts; en is
 * typed against ja, so a missing translation is a type error). `?lang=en|ja` overrides the choice stored in
 * localStorage for that page; the header's switch stores it (and rewrites `?lang=` if the URL has one).
 *
 * The key is outside the `ps-demo.` prefix on purpose: "デモを初期化" wipes the demo's data, not this preference.
 */
import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ja, type Messages } from './ja';

export type { Messages } from './ja';

export const LANGS = ['ja', 'en'] as const;
export type Lang = (typeof LANGS)[number];

const CATALOG: Record<Lang, Messages> = { ja, en };
const KEY = 'ps-demo-lang';

const isLang = (v: unknown): v is Lang => v === 'ja' || v === 'en';

function fromUrl(): Lang | undefined {
  const v = new URLSearchParams(window.location.search).get('lang');
  return isLang(v) ? v : undefined;
}

function stored(): Lang | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

let current: Lang = fromUrl() ?? stored() ?? 'ja';
const listeners = new Set<() => void>();

function apply(): void {
  document.documentElement.lang = current;
  document.title = CATALOG[current].app.title;
}

function notify(): void {
  apply();
  for (const fn of listeners) fn();
}

export const getLang = (): Lang => current;

/** The current language's messages, for code outside React (runtimes, the guide's scenarios, errors). */
export const msg = (): Messages => CATALOG[current];

export const messagesFor = (l: Lang): Messages => CATALOG[l];

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Switch the language (the header's switch): stored for next time, and the URL's `?lang=` follows. */
export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // Storage may be unavailable; the switch still applies to this page.
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', l);
    window.history.replaceState(window.history.state, '', url);
  }
  if (l === current) return;
  current = l;
  notify();
}

/** Call once at startup: sets <html lang> and the title, and follows switches made in other windows. */
export function initLang(): void {
  apply();
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || fromUrl() || !isLang(e.newValue) || e.newValue === current) return;
    current = e.newValue;
    notify();
  });
}

/** The current language (re-renders on a switch). */
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang);
}

/** The current language's messages (re-renders on a switch). */
export function useT(): Messages {
  return CATALOG[useLang()];
}

/** A label from a keyed table, or the key itself when the table does not know it (e.g. a new status). */
export function label<T extends object>(table: T, key: string | undefined): string {
  if (key === undefined) return '';
  return (table as Record<string, string>)[key] ?? key;
}
