'use client';

import { useEffect } from 'react';

/** Registers the PWA service worker (offline app shell + installability). */
export default function SwRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Non-fatal: the app still works as a regular web page.
      });
    }
  }, []);
  return null;
}
