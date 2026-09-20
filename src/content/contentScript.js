/**
 * Keurweb — Keep Your Web — content script (self-contained, no imports).
 *
 * Injected by the service worker only into sites the user enabled.
 * Responsibilities:
 *  1. Report "I'm alive" pings so the worker knows the page is responsive.
 *  2. Simulate user activity on demand (defeats server/browser idle timers).
 *  3. Report network loss so the worker can schedule a reconnect.
 * It never modifies page data — it only dispatches benign synthetic events.
 */
(() => {
  'use strict';

  if (window.__keurwebInjected) return; // guard against double injection
  window.__keurwebInjected = true;

  const PING_EVERY_MS = 25_000;

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      /* extension context invalidated (e.g. mid-update) — ignore */
    }
  };

  // ------------------------------------------------ 1. liveness reporting

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      send({ type: 'activityPing' });
    }
  }, PING_EVERY_MS);
  send({ type: 'activityPing' });

  // --------------------------------------------- 2. activity simulation

  const ACTIVITY_EVENTS = ['keydown', 'keypress', 'mousemove', 'mousedown', 'wheel', 'touchstart'];

  /** Dispatches benign, untrusted activity events on the page surface. */
  function simulateActivity() {
    const target = document.body || document.documentElement;
    if (!target) return;
    for (const type of ACTIVITY_EVENTS) {
      let event;
      try {
        if (type.startsWith('key')) {
          event = new KeyboardEvent(type, { key: 'Shift', bubbles: true, cancelable: false });
        } else if (type === 'wheel') {
          event = new WheelEvent(type, { deltaY: -1, bubbles: true, cancelable: false });
        } else if (type === 'touchstart') {
          event = new TouchEvent(type, { bubbles: true, cancelable: false });
        } else {
          event = new MouseEvent(type, {
            clientX: 1 + Math.floor(Math.random() * 3),
            clientY: 1 + Math.floor(Math.random() * 3),
            button: 0,
            bubbles: true,
            cancelable: false,
          });
        }
        target.dispatchEvent(event);
      } catch {
        /* event constructor unavailable — skip this type */
      }
    }
    try {
      window.dispatchEvent(new Event('focus'));
    } catch {
      /* ignore */
    }
  }

  /** Focus-only mode for apps that misbehave with pointer/key events. */
  function simulateFocus() {
    try {
      window.dispatchEvent(new Event('focus'));
      document.documentElement.dispatchEvent(new Event('focusin'));
    } catch {
      /* ignore */
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.cmd === 'keurweb-simulate') {
      const mode = message.mode || 'events';
      if (mode === 'events' || mode === 'both') simulateActivity();
      if (mode === 'focus' || mode === 'both') simulateFocus();
    }
  });

  // -------------------------------------------------- 3. network watch

  window.addEventListener('offline', () => {
    send({ type: 'disconnectReport', detail: { kind: 'network' } });
  });
  window.addEventListener('online', () => {
    send({ type: 'activityPing' });
  });
})();
