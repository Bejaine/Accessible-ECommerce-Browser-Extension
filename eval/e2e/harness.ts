// Helpers for the persona runs: a backend client over node:http (the test DOM's fetch would apply
// CORS; the real extension calls the backend from its background script), MockMart pages loaded
// the way Track B's tests do, and waits that keep fake timers moving.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';
import type { PageContext } from '../../shared/generated/ts';
import type { BackendClient } from '../../extension/src/core/backend';
import { extractPageContext } from '../../extension/src/extract';

const STORE = resolve(__dirname, '../../mock-store');
const STORE_JS = readFileSync(join(STORE, 'store.js'), 'utf8');

export interface Timed {
  path: string;
  ms: number;
}

/** A BackendClient that talks to the real backend and records each call's latency. */
export function nodeBackend(base: string): BackendClient & { calls: Timed[] } {
  const calls: Timed[] = [];
  const post = (path: string, body?: unknown) =>
    new Promise<never>((ok, fail) => {
      const started = Date.now();
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        `${base}${path}`,
        {
          method: data ? 'POST' : 'GET',
          headers: data ? { 'Content-Type': 'application/json' } : {},
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            calls.push({ path, ms: Date.now() - started });
            const json = text ? JSON.parse(text) : null;
            if ((res.statusCode ?? 500) >= 400) fail(json);
            else ok(json as never);
          });
        },
      );
      req.on('error', fail);
      if (data) req.write(data);
      req.end();
    });
  return {
    calls,
    health: () => post('/health'),
    prepareProduct: (r) => post('/product/prepare', r),
    turn: (r) => post('/turn', r),
    asr: (r) => post('/speech/asr', r),
    tts: (r) => post('/speech/tts', r),
    translate: (r) => post('/translate', r),
    ocr: (r) => post('/ocr', r),
    describeImage: (r) => post('/vision/describe', r),
    summarizeReviews: (r) => post('/reviews/summarize', r),
    extractFallback: (r) => post('/extract/fallback', r),
  };
}

type HappyWindow = Window & { happyDOM: { setURL(url: string): void }; MOCK_TODAY?: number };

/** Load a MockMart page (store.js runs in the test DOM) and return what the extractor sees. */
export function openMockMart(path: string): PageContext {
  const win = window as unknown as HappyWindow;
  win.happyDOM.setURL(`http://localhost:8080/${path}`);
  win.MOCK_TODAY = Date.parse('2026-10-10T12:00:00Z');
  const html = readFileSync(join(STORE, path.split('?')[0] ?? ''), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '');
  const body = html.match(/<body([^>]*)>([\s\S]*)<\/body>/);
  document.head.innerHTML = html.match(/<head>([\s\S]*)<\/head>/)?.[1] ?? '';
  document.body.innerHTML = body?.[2] ?? '';
  document.body.setAttribute('data-page', body?.[1]?.match(/data-page="(\w+)"/)?.[1] ?? '');
  new Function(STORE_JS)();
  return extractPageContext(document);
}

export function resetMockMart(): void {
  localStorage.clear();
}

/** MockMart's cart, from its own storage. */
export function cart(): { id: string; qty: number }[] {
  const raw = localStorage.getItem('asl-mock-store-v1');
  return raw ? (JSON.parse(raw).cart ?? []) : [];
}

/** Real-time pause (fake timers don't touch setImmediate or Date). */
export async function realSleep(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((r) => setImmediate(r));
}

/** Wait (real time) for a condition, advancing fake timers so the app keeps running. */
export async function until(
  cond: () => boolean,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    vi.advanceTimersByTime(50);
    await new Promise((r) => setImmediate(r));
  }
}

export function key(code: string, keyName = code === 'Space' ? ' ' : code): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { code, key: keyName, bubbles: true, cancelable: true }),
  );
}
