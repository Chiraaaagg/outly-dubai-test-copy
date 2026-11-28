"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * Cloudflare Turnstile on /login (Group B; owner Q-B5). Explicit rendering,
 * Managed mode chosen in the Cloudflare dashboard (most visitors never see a
 * challenge). The token it produces is single use: the email form sends it
 * with the start request and resets the widget after every attempt. The
 * script and its iframe are allowed by the CSP on /login only
 * (src/proxy.ts). Action `login_email` is checked on the server.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_ACTION = "login_email";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_missing")));
    s.onerror = () => {
      loading = null;
      reject(new Error("turnstile_load_failed"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface TurnstileHandle {
  reset: () => void;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, { siteKey: string; onToken: (token: string | null) => void; onError: () => void }>(function TurnstileWidget({ siteKey, onToken, onError }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };

  useImperativeHandle(ref, () => ({
    reset: () => {
      callbacks.current.onToken(null);
      if (id.current && window.turnstile) window.turnstile.reset(id.current);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !el.current || id.current) return;
        id.current = api.render(el.current, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          appearance: "interaction-only",
          "response-field": false,
          callback: (token: string) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(null),
          "error-callback": () => {
            callbacks.current.onToken(null);
            callbacks.current.onError();
          },
        });
      })
      .catch(() => callbacks.current.onError());
    return () => {
      cancelled = true;
      if (id.current && window.turnstile) window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [siteKey]);

  // Empty until Cloudflare decides to show a challenge ("interaction-only"); never takes space otherwise.
  return <div ref={el} className="[&:empty]:hidden" />;
});
