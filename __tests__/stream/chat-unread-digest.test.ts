/**
 * @jest-environment node
 */

const claims = new Set<string>();
const mockStageBell = jest.fn();
const mockStagePrepared = jest.fn();
const mockFlush = jest.fn();
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();

jest.mock("../../lib/prisma", () => {
  const tx = {
    idempotencyRecord: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: { scope: string; key: string; userId: string };
        }) => {
          const k = `${data.scope}|${data.key}|${data.userId}`;
          if (claims.has(k))
            throw Object.assign(new Error("dup"), { code: "P2002" });
          claims.add(k);
        },
      ),
    },
  };
  return {
    __esModule: true,
    default: {
      user: {
        findUnique: (...a: unknown[]) => mockFindUnique(...a),
        findMany: (...a: unknown[]) => mockFindMany(...a),
      },
      appointmentOccurrence: {
        findFirst: jest.fn(async () => ({
          startsAt: new Date("2026-11-12T11:30:00Z"),
          appointment: { organizationId: null },
        })),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBells: (...a: unknown[]) => mockStageBell(...a),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...a: unknown[]) => mockFlush(...a),
}));
// @react-email/render needs --experimental-vm-modules under Jest; static markup is the same tree.
jest.mock("../../lib/email/render", () => ({
  renderEmail: async (el: import("react").ReactElement) => {
    const html = jest
      .requireActual("react-dom/server")
      .renderToStaticMarkup(el);
    return { html, text: html.replace(/<[^>]+>/g, " ") };
  },
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  ...jest.requireActual("../../lib/email/send-to-recipients"),
  stagePreparedEmails: (...a: unknown[]) => mockStagePrepared(...a),
}));

import { handleUnreadMessageReminder } from "../../lib/stream/chat/unread-digest";
import { SUPPORT_STREAM_USER_ID } from "../../lib/stream/support-user";
import { streamUnreadMessageReminderSchema } from "../../schemas/webhooks/stream";
import type { PreparedRecipientEmails } from "../../lib/email/send-to-recipients";

const SECRET = "my private question about dosage";

function rawEvent(recipient = "u_client") {
  return {
    type: "user.unread_message_reminder",
    created_at: "2026-11-10T09:10:00.000Z",
    user: { id: recipient, name: "Client", role: "user" },
    channels: {
      "messaging:dm-u_client-u_expert": {
        channel: {
          id: "dm-u_client-u_expert",
          type: "messaging",
          cid: "messaging:dm-u_client-u_expert",
          members: [
            { user_id: "u_client", user: { id: "u_client", name: "Client" } },
            { user_id: "u_expert", user: { id: "u_expert", name: "Asha" } },
            { user_id: SUPPORT_STREAM_USER_ID },
          ],
        },
        messages: [
          { id: "m2", text: SECRET, type: "regular", user: { id: "u_expert" } },
          { id: "m1", text: SECRET, type: "regular", user: { id: "u_expert" } },
        ],
      },
    },
  };
}

const parse = (recipient?: string) =>
  streamUnreadMessageReminderSchema.parse(rawEvent(recipient));

function liveUser(over: Record<string, unknown> = {}) {
  return { banned: false, erasedAt: null, timezone: "Asia/Kolkata", ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  claims.clear();
  mockFindUnique.mockResolvedValue(liveUser());
  mockStageBell.mockResolvedValue([{ id: "bell" }]);
  mockStagePrepared.mockResolvedValue([]);
  mockFindMany.mockImplementation(
    async ({ select }: { select: Record<string, unknown> }) =>
      select.email
        ? [
            {
              id: "u_client",
              email: "c@example.com",
              name: "Client",
              timezone: "Asia/Kolkata",
              notificationPreferences: null,
            },
          ]
        : [{ id: "u_expert", name: "Asha" }],
  );
});

function preparedEmail(): PreparedRecipientEmails {
  return mockStagePrepared.mock.calls[0][1];
}

describe("chat unread digest", () => {
  it("stages one digest per user per window when the same event arrives twice", async () => {
    await handleUnreadMessageReminder(parse());
    await handleUnreadMessageReminder(parse());

    expect(mockStageBell).toHaveBeenCalledTimes(1);
    expect(mockStagePrepared).toHaveBeenCalledTimes(1);
    expect(mockStageBell.mock.calls[0][1]).toMatchObject({
      recipients: ["u_client"],
      dedupeKey: "chat-digest:u_client:2026-11-10T09:00:00.000Z",
    });
  });

  it("never puts message text in the email, the bell or the stored payload", async () => {
    const parsed = parse();
    expect(JSON.stringify(parsed)).not.toContain(SECRET);

    await handleUnreadMessageReminder(parsed);

    const [message] = preparedEmail().messages;
    expect(message.html).toContain("2 new messages from Asha");
    expect(message.html).toContain("12 Nov 2026");
    expect(`${message.html}${message.text}`).not.toContain(SECRET);
    expect(JSON.stringify(mockStageBell.mock.calls[0][1])).not.toContain(
      SECRET,
    );
  });

  it("skips the support user and ids with no user row", async () => {
    await handleUnreadMessageReminder(parse(SUPPORT_STREAM_USER_ID));
    mockFindUnique.mockResolvedValueOnce(null);
    await handleUnreadMessageReminder(parse("system-bot"));

    expect(mockStageBell).not.toHaveBeenCalled();
    expect(mockStagePrepared).not.toHaveBeenCalled();
  });

  it.each([
    ["banned", { banned: true }],
    ["erased", { erasedAt: new Date() }],
  ])("skips a %s recipient", async (_label, over) => {
    mockFindUnique.mockResolvedValueOnce(liveUser(over));
    await handleUnreadMessageReminder(parse());
    expect(mockStageBell).not.toHaveBeenCalled();
  });

  it("stages no email for a user who opted out", async () => {
    mockFindMany.mockImplementation(
      async ({ select }: { select: Record<string, unknown> }) =>
        select.email
          ? [
              {
                id: "u_client",
                email: "c@example.com",
                name: "Client",
                timezone: null,
                notificationPreferences: {
                  allNotifications: true,
                  emailEnabled: false,
                },
              },
            ]
          : [{ id: "u_expert", name: "Asha" }],
    );
    await handleUnreadMessageReminder(parse());
    expect(preparedEmail().messages).toHaveLength(0);
  });

  it.each([
    ["no user id", { user: {} }],
    ["channels as a list", { channels: [] }],
    [
      "a channel without members",
      {
        channels: {
          x: { channel: { id: "a", type: "messaging", cid: "messaging:a" } },
        },
      },
    ],
  ])("rejects a malformed event: %s", (_label, patch) => {
    expect(
      streamUnreadMessageReminderSchema.safeParse({ ...rawEvent(), ...patch })
        .success,
    ).toBe(false);
  });
});
