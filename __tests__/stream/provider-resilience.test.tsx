/**
 * StreamProviderImpl keeps the chat surface up through reconnects: a recovered
 * connect clears the failure, a dropped socket is a grace window rather than an
 * instant disconnect, and overlapping connects never downgrade a live client.
 */
import { act, render } from "@testing-library/react";

type Handler = (event: { type: string; online?: boolean }) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const USER = { id: "u1", name: "U One", image: null, role: "CONSULTEE" };
const mockUserData = { current: { userDetails: { ...USER } } };

const mockChat = {
  userID: undefined as string | undefined,
  wsConnection: null as { isHealthy: boolean; isConnecting?: boolean } | null,
  wsFallback: undefined,
  _hasConnectionID: () => mockChat.wsConnection?.isHealthy === true,
  connectUser: jest.fn(),
  openConnection: jest.fn(),
  listeners: new Set<Handler>(),
  on(handler: Handler) {
    mockChat.listeners.add(handler);
    return { unsubscribe: () => mockChat.listeners.delete(handler) };
  },
  emit(event: { type: string; online?: boolean }) {
    mockChat.listeners.forEach((h) => h(event));
  },
};

const videoConnects: Array<ReturnType<typeof deferred<void>>> = [];
const mockVideoCtor = jest.fn();

jest.mock("stream-chat", () => ({
  StreamChat: { getInstance: () => mockChat },
}));
jest.mock("@stream-io/video-react-sdk", () => ({
  StreamVideoClient: class {
    streamClient = {
      wsConnection: { isHealthy: true, isConnecting: false },
      _hasConnectionID: () => true,
      openConnection: jest.fn(),
    };
    constructor() {
      mockVideoCtor();
    }
    connectUser = jest.fn(() => {
      const d = deferred<void>();
      videoConnects.push(d);
      return d.promise;
    });
    disconnectUser = jest.fn(() => Promise.resolve());
    on = jest.fn(() => () => undefined);
  },
}));
jest.mock("../../actions/stream/chat/stream.action", () => ({
  chatTokenProvider: jest.fn(() => Promise.resolve({ ok: true, data: "tok" })),
  tokenProvider: jest.fn(() => Promise.resolve({ ok: true, data: "tok" })),
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn(() => Promise.resolve()),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  syncUserEventChannels: jest.fn(() => Promise.resolve({ success: true })),
}));
jest.mock("../../hooks/useUserData", () => ({
  useUserData: () => ({
    userDetails: mockUserData.current.userDetails,
    isLoading: false,
    failure: null,
    retry: jest.fn(),
  }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, isPending: false }),
}));
jest.mock("../../lib/user", () => ({ mapRoleToStream: () => "user" }));
jest.mock("../../components/stream/StreamInitialTokens", () => ({
  useStreamInitialTokens: () => null,
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  getStreamConnectionSnapshot,
  resetStreamConnection,
} from "@/lib/stream/connection-store";
import {
  setCurrentStreamUserId,
  setGlobalChatClient,
  setGlobalVideoClient,
} from "@/lib/stream/disconnect";

type ProviderModule = typeof import("@/providers/StreamProviderImpl");
let Provider: ProviderModule["default"];

beforeAll(async () => {
  process.env.NEXT_PUBLIC_STREAM_API_KEY = "test-key";
  Provider = (await import("@/providers/StreamProviderImpl")).default;
});

beforeEach(() => {
  jest.useFakeTimers();
  mockChat.userID = undefined;
  mockChat.wsConnection = null;
  mockChat.listeners.clear();
  mockChat.connectUser.mockReset();
  mockChat.openConnection.mockReset();
  videoConnects.length = 0;
  mockVideoCtor.mockReset();
  mockUserData.current = { userDetails: { ...USER } };
  setGlobalChatClient(null);
  setGlobalVideoClient(null);
  setCurrentStreamUserId(null);
  resetStreamConnection();
});

afterEach(() => {
  jest.useRealTimers();
});

const succeedChatConnect = () =>
  mockChat.connectUser.mockImplementation(async () => {
    mockChat.userID = USER.id;
    mockChat.wsConnection = { isHealthy: true };
  });

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function settleVideoConnects() {
  await act(async () => {
    videoConnects.forEach((d) => d.resolve());
    await Promise.resolve();
  });
}

describe("a successful connect after a failure", () => {
  it("clears the failure the failed attempt set", async () => {
    // The first attempt fails, every later one connects.
    mockChat.connectUser.mockRejectedValueOnce(new Error("socket hung up"));
    mockChat.connectUser.mockImplementation(async () => {
      mockChat.userID = USER.id;
      mockChat.wsConnection = { isHealthy: true };
    });

    render(<Provider userId="u1" />);
    await advance(10);
    await settleVideoConnects();
    expect(getStreamConnectionSnapshot().failure?.kind).toBe("retryable");

    await advance(2_100);
    await settleVideoConnects();
    expect(getStreamConnectionSnapshot().chatConnected).toBe(true);
    expect(getStreamConnectionSnapshot().failure).toBeNull();
  });
});

describe("a dropped chat socket", () => {
  async function connected() {
    succeedChatConnect();
    render(<Provider userId="u1" />);
    await advance(10);
    await settleVideoConnects();
    expect(getStreamConnectionSnapshot().chatConnected).toBe(true);
  }

  it("stays a reconnect for the whole grace window, then counts as down", async () => {
    await connected();
    mockChat.openConnection.mockRejectedValue(new Error("offline"));

    mockChat.wsConnection = { isHealthy: false };
    act(() => mockChat.emit({ type: "connection.changed", online: false }));
    expect(getStreamConnectionSnapshot().chatReconnecting).toBe(true);

    await advance(14_000);
    const mid = getStreamConnectionSnapshot();
    expect(mid.chatReconnecting).toBe(true);
    expect(mid.failure).toBeNull();

    await advance(1_500);
    expect(getStreamConnectionSnapshot().chatReconnecting).toBe(false);
  });

  it("clears the reconnecting state when the SDK recovers in time", async () => {
    await connected();

    act(() => mockChat.emit({ type: "connection.changed", online: false }));
    await advance(3_000);
    act(() => mockChat.emit({ type: "connection.changed", online: true }));

    const snapshot = getStreamConnectionSnapshot();
    expect(snapshot.chatReconnecting).toBe(false);
    expect(snapshot.chatConnected).toBe(true);
  });
});

describe("overlapping connects", () => {
  it("never replace a live chat client with null", async () => {
    const chatConnect = deferred<void>();
    mockChat.connectUser.mockImplementation(async () => {
      await chatConnect.promise;
      mockChat.userID = USER.id;
      mockChat.wsConnection = { isHealthy: true };
    });

    const view = render(<Provider userId="u1" />);
    await advance(10);

    // A same-user profile refresh re-runs the connect while the first is in flight.
    mockUserData.current = { userDetails: { ...USER } };
    view.rerender(<Provider userId="u1" />);
    await advance(10);

    await act(async () => {
      chatConnect.resolve();
      await Promise.resolve();
    });
    await settleVideoConnects();
    await advance(10);
    await settleVideoConnects();

    expect(getStreamConnectionSnapshot().clients?.chat).toBe(mockChat);
    expect(mockChat.connectUser).toHaveBeenCalledTimes(1);
    expect(mockVideoCtor).toHaveBeenCalledTimes(1);
  });
});
