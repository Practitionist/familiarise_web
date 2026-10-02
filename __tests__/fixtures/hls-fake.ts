/**
 * A stand-in for `hls.js`, for `__tests__/meetings/livestream-player.test.tsx`.
 *
 * Lives in `fixtures/` rather than beside the test because Jest's default
 * matcher treats every `.ts` under `__tests__/` as a suite, and a module with
 * no `describe()` fails it with "must contain at least one test". `fixtures/`
 * is excluded by `testPathIgnorePatterns` for exactly this.
 *
 * ## Why a class and not a bag of mocks
 *
 * `lib/stream/hls-client.ts` reaches for the statics (`Hls.Events.ERROR`,
 * `Hls.ErrorTypes.NETWORK_ERROR`) and the instance methods the recovery ladder
 * uses, so a fake that omits any of them would test a shape the real library
 * does not have. The surface here is therefore the real one and nothing more —
 * every method is a spy, and every spy exists because the wrapper calls it.
 *
 * `emitError` is the one addition: `hls.js` pushes fatal errors at a listener
 * from inside its own loaders, and the only way to drive the ladder from a test
 * is to push one.
 */

type Listener = (event: string, data: unknown) => void;

export class FakeHls {
  /** Every instance built since the last `reset()`. */
  static instances: FakeHls[] = [];

  static isSupported(): boolean {
    return hlsControl.supported;
  }

  // Real values, not arbitrary strings: the wrapper compares `data.type`
  // against these, so a mismatch here would silently make the MEDIA branch
  // unreachable and the ladder test would pass for the wrong reason.
  static readonly Events = {
    ERROR: "hlsError",
    MANIFEST_PARSED: "hlsManifestParsed",
  } as const;

  static readonly ErrorTypes = {
    NETWORK_ERROR: "networkError",
    MEDIA_ERROR: "mediaError",
  } as const;

  readonly loadSource = jest.fn();
  readonly attachMedia = jest.fn();
  readonly detachMedia = jest.fn();
  readonly destroy = jest.fn();
  readonly startLoad = jest.fn();
  readonly stopLoad = jest.fn();
  readonly recoverMediaError = jest.fn();
  readonly swapAudioCodec = jest.fn();

  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    FakeHls.instances.push(this);
    hlsControl.instances.push(this);
  }

  on(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  off(event: string, listener?: Listener): void {
    if (!listener) {
      this.listeners.delete(event);
      return;
    }
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      existing.filter((l) => l !== listener),
    );
  }

  /**
   * Push a manifest-parsed event. The wrapper treats it as "the stream exists",
   * so a test that wants a healthy player calls this once.
   */
  emitManifestParsed(): void {
    for (const listener of this.listeners.get(FakeHls.Events.MANIFEST_PARSED) ??
      []) {
      listener(FakeHls.Events.MANIFEST_PARSED, {});
    }
  }

  /** Push a fatal or non-fatal error at every registered ERROR listener. */
  emitError(type: string, fatal: boolean): void {
    for (const listener of this.listeners.get(FakeHls.Events.ERROR) ?? []) {
      listener(FakeHls.Events.ERROR, { type, fatal, error: new Error("boom") });
    }
  }
}

/**
 * Mutable knobs the test flips.
 *
 * A module-level object rather than statics on the class, so `reset()` can put
 * them back without the class needing a test-only method on its public shape.
 */
export const hlsControl = {
  /** `Hls.isSupported()` — the "this browser has MSE" answer. */
  supported: true,
  /** Mirrors `FakeHls.instances`; kept for tests that want the same list. */
  instances: [] as FakeHls[],
  reset(): void {
    hlsControl.supported = true;
    hlsControl.instances = [];
    FakeHls.instances = [];
  },
};
