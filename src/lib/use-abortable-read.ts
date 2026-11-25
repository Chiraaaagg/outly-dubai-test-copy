"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One small abortable read (doc 29 §6.6, 40-ui-flow §4): the one hook the
 * plan allows instead of a query library. `key` names what is read; when it
 * changes, the read in flight is aborted and a late answer for an old key is
 * ignored. Answers are kept per key in memory for `ttlMs` (default 60 s), so
 * stepping back to a date already seen costs no request. A null key reads
 * nothing. After `slowMs` (default 8 s) `slow` turns true, so the page can
 * say "This is taking longer than usual" and offer the other routes.
 *
 * The keeping and aborting live in `createAbortableReader`, which has no
 * React or DOM in it and is unit-tested on its own.
 */

export type ReadState<T> =
  | { status: "idle"; data: null; slow: false }
  | { status: "loading"; data: null; slow: boolean }
  | { status: "ready"; data: T; slow: false }
  | { status: "error"; data: null; slow: false };

export interface AbortableReader<T> {
  /** Starts (or answers from memory) the read for `key`; aborts the previous one. `onDone` is never called for a superseded key. */
  read(key: string, fetcher: (signal: AbortSignal) => Promise<T>, onDone: (r: { ok: true; value: T } | { ok: false }) => void): void;
  /** The remembered answer for `key`, when still fresh. */
  peek(key: string): T | undefined;
  /** Aborts whatever is in flight. */
  cancel(): void;
}

export function createAbortableReader<T>(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): AbortableReader<T> {
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.maxEntries ?? 50;
  const now = opts.now ?? Date.now;
  const memory = new Map<string, { at: number; value: T }>();
  let current: { key: string; controller: AbortController } | null = null;

  const peek = (key: string) => {
    const hit = memory.get(key);
    if (!hit) return undefined;
    if (now() - hit.at >= ttl) {
      memory.delete(key);
      return undefined;
    }
    return hit.value;
  };

  return {
    peek,
    cancel() {
      current?.controller.abort();
      current = null;
    },
    read(key, fetcher, onDone) {
      current?.controller.abort();
      current = null;
      const hit = peek(key);
      if (hit !== undefined) {
        onDone({ ok: true, value: hit });
        return;
      }
      const controller = new AbortController();
      const mine = { key, controller };
      current = mine;
      fetcher(controller.signal).then(
        (value) => {
          if (current !== mine) return;
          current = null;
          memory.delete(key);
          memory.set(key, { at: now(), value });
          while (memory.size > max) {
            const oldest = memory.keys().next().value;
            if (oldest === undefined) break;
            memory.delete(oldest);
          }
          onDone({ ok: true, value });
        },
        () => {
          if (current !== mine) return;
          current = null;
          onDone({ ok: false });
        },
      );
    },
  };
}

export function useAbortableRead<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, opts: { ttlMs?: number; slowMs?: number } = {}): ReadState<T> {
  // One reader per component instance; state (not a ref) so render may ask it for a remembered answer.
  const [reader] = useState(() => createAbortableReader<T>({ ttlMs: opts.ttlMs }));
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const [state, setState] = useState<{ key: string | null; read: ReadState<T> }>({ key: null, read: { status: "idle", data: null, slow: false } });
  const slowMs = opts.slowMs ?? 8_000;

  useEffect(() => {
    if (key === null) {
      reader.cancel();
      return;
    }
    let live = true;
    let answered = false;
    const timer = window.setTimeout(() => {
      if (live && !answered) setState({ key, read: { status: "loading", data: null, slow: true } });
    }, slowMs);
    reader.read(key, (signal) => fetcherRef.current(signal), (res) => {
      answered = true;
      window.clearTimeout(timer);
      if (!live) return;
      setState({ key, read: res.ok ? { status: "ready", data: res.value, slow: false } : { status: "error", data: null, slow: false } });
    });
    return () => {
      live = false;
      window.clearTimeout(timer);
      reader.cancel();
    };
  }, [key, slowMs, reader]);

  if (key === null) return { status: "idle", data: null, slow: false };
  // Until this key's answer arrives, the page sees "loading" (or the remembered answer), never the previous key's answer.
  if (state.key !== key) {
    const hit = reader.peek(key);
    return hit !== undefined ? { status: "ready", data: hit, slow: false } : { status: "loading", data: null, slow: false };
  }
  return state.read;
}
