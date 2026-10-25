/**
 * @jest-environment node
 */

const mockReportMessage = jest.fn();

jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: (...a: unknown[]) => mockReportMessage(...a),
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  getStreamVideoClient: jest.fn(),
}));

import {
  detectStreamControlPlaneDrift,
  type ControlPlaneReader,
} from "../../lib/stream/control-plane-drift";
import {
  CO_PRESENTER_GRANTS,
  desiredEventTypesByProduct,
  expectedWebhookUrl,
} from "../../lib/stream/control-plane-contract";

const APP_URL = "https://familiarisenow.com";

type Grants = Record<string, string[]>;

function compliantState() {
  const byProduct = desiredEventTypesByProduct();
  const hookFor = (id: string, product: "chat" | "video") => ({
    id,
    hook_type: "webhook",
    enabled: true,
    product,
    webhook_url: expectedWebhookUrl(APP_URL),
    event_types: [...byProduct[product]],
  });
  const unused: Grants = {
    user: ["read-call", "send-audio"],
    guest: ["read-call"],
    call_member: ["read-call"],
    admin: ["create-call", "join-call", "start-recording"],
  };
  return {
    app: {
      guest_user_creation_disabled: true,
      event_hooks: [hookFor("hook_1", "video"), hookFor("hook_chat", "chat")],
      reminders_interval: 1800,
      channel_configs: { messaging: { reminders: true, read_events: true } },
    },
    roles: [{ name: "co_presenter" }],
    messaging: {
      user: ["read-channel", "remove-own-channel-membership-owner"],
      admin: ["truncate-channel", "update-channel-members-owner"],
    } as Grants,
    types: {
      default: {
        grants: {
          user: ["read-call", "remove-call-member-owner"],
          call_member: ["join-call", "update-call-member-owner"],
          co_presenter: [...CO_PRESENTER_GRANTS],
          admin: ["create-call", "end-call"],
        } as Grants,
        settings: { session: { inactivity_timeout_seconds: 300 } },
      },
      livestream: { grants: structuredClone(unused) },
      audio_room: { grants: structuredClone(unused) },
      development: { grants: structuredClone(unused) },
    } as Record<
      string,
      {
        grants: Grants;
        settings?: { session: { inactivity_timeout_seconds: number } };
      }
    >,
  };
}

function readerFor(
  state: ReturnType<typeof compliantState>,
): ControlPlaneReader {
  return {
    getApp: async () => ({ app: state.app }),
    listRoles: async () => ({ roles: state.roles }),
    video: {
      getCallType: async ({ name }) => state.types[name],
    },
    getMessagingGrants: async () => state.messaging,
  };
}

async function detect(state: ReturnType<typeof compliantState>) {
  return detectStreamControlPlaneDrift({
    client: readerFor(state),
    appUrl: APP_URL,
  });
}

beforeEach(() => jest.clearAllMocks());

describe("detectStreamControlPlaneDrift", () => {
  it("reports nothing and stays silent when Stream matches the contract", async () => {
    const result = await detect(compliantState());
    expect(result).toMatchObject({ drifted: false, findings: [] });
    expect(mockReportMessage).not.toHaveBeenCalled();
  });

  it("flags a disabled hook", async () => {
    const state = compliantState();
    state.app.event_hooks[0].enabled = false;
    expect((await detect(state)).findings).toContain("webhook:hook_1:disabled");
  });

  it("flags a hook redirected to another URL", async () => {
    const state = compliantState();
    state.app.event_hooks[0].webhook_url =
      "https://evil.example/api/stream/webhooks";
    const { findings } = await detect(state);
    expect(findings).toContain("webhook:hook_1:url");
    expect(JSON.stringify(findings)).not.toContain("evil.example");
  });

  it("flags a missing event type", async () => {
    const state = compliantState();
    state.app.event_hooks[0].event_types =
      state.app.event_hooks[0].event_types.slice(1);
    expect(
      (await detect(state)).findings.some((f) => f.includes(":missing:")),
    ).toBe(true);
  });

  it("requires a chat hook for the unread reminder and reminders on messaging", async () => {
    expect(desiredEventTypesByProduct().chat).toEqual([
      "user.unread_message_reminder",
    ]);
    const state = compliantState();
    state.app.event_hooks = state.app.event_hooks.slice(0, 1);
    state.app.reminders_interval = 300;
    state.app.channel_configs.messaging.reminders = false;
    expect((await detect(state)).findings).toEqual(
      expect.arrayContaining([
        "webhook:unplaceable:chat:user.unread_message_reminder",
        "channel_type:messaging:reminders",
        "app:reminders_interval",
      ]),
    );
  });

  it("flags create-call granted to the user role on livestream", async () => {
    const state = compliantState();
    state.types.livestream.grants.user.push("create-call");
    expect((await detect(state)).findings).toContain(
      "call_type:livestream:grant:user:create-call",
    );
  });

  it("flags a user role still holding an owner-scoped member or history grant on messaging", async () => {
    const state = compliantState();
    state.messaging.user.push("update-channel-members-owner");
    expect((await detect(state)).findings).toEqual([
      "channel_type:messaging:grant:user:update-channel-members-owner",
    ]);
  });

  it("flags a missing co_presenter grant and a missing role", async () => {
    const state = compliantState();
    state.types.default.grants.co_presenter = CO_PRESENTER_GRANTS.slice(1);
    state.roles = [];
    const { findings } = await detect(state);
    expect(findings).toContain("call_type:default:grant:co_presenter:differs");
    expect(findings).toContain("role:co_presenter:missing");
  });

  it("flags broad member grants, the inactivity timeout and guest creation", async () => {
    const state = compliantState();
    state.types.default.grants.user.push("remove-call-member");
    state.types.default.settings = {
      session: { inactivity_timeout_seconds: 60 },
    };
    state.app.guest_user_creation_disabled = false;
    const { findings } = await detect(state);
    expect(findings).toContain(
      "call_type:default:grant:user:remove-call-member",
    );
    expect(findings).toContain("call_type:default:inactivity_timeout");
    expect(findings).toContain("app:guest_user_creation_disabled");
  });

  it("sends exactly one Sentry message per run, listing keys only", async () => {
    const state = compliantState();
    state.app.event_hooks[0].enabled = false;
    state.types.livestream.grants.user.push("create-call");

    await detect(state);

    expect(mockReportMessage).toHaveBeenCalledTimes(1);
    const [message, opts] = mockReportMessage.mock.calls[0];
    expect(message).toContain("2 finding");
    expect(opts.extra.findings).toEqual(
      expect.arrayContaining([
        "webhook:hook_1:disabled",
        "call_type:livestream:grant:user:create-call",
      ]),
    );
  });

  it("never calls a Stream write", async () => {
    const reader = readerFor(compliantState());
    const writes = jest.fn();
    const guarded = new Proxy(reader, {
      get: (t, k) =>
        typeof k === "string" && /^(update|create|delete)/.test(k)
          ? writes
          : Reflect.get(t, k),
    });
    await detectStreamControlPlaneDrift({ client: guarded, appUrl: APP_URL });
    expect(writes).not.toHaveBeenCalled();
  });
});
