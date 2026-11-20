/**
 * Freezes `Date` alone, so a suite's fixed-date fixtures sit inside the
 * booking horizon while promises and real timers keep running. Pair with
 * `jest.useRealTimers()` in `afterEach`.
 */
export function freezeDateAt(iso: string): void {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
}
