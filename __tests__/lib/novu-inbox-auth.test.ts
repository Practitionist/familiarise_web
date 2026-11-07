import { resolveInboxAuth } from "@/lib/novu/inbox-auth";

describe("resolveInboxAuth", () => {
  const subscriberHash = "a".repeat(64);
  it("holds the Inbox back while the subscriber sync is pending", () => {
    expect(resolveInboxAuth("pending", undefined)).toEqual({ ready: false });
  });

  it("passes the hash through once the sync succeeds", () => {
    expect(
      resolveInboxAuth("success", { success: true, subscriberHash }),
    ).toEqual({ ready: true, subscriberHash });
  });

  it("refuses an unsuccessful response even if it contains a digest", () => {
    expect(
      resolveInboxAuth("success", { success: false, subscriberHash }),
    ).toEqual({ ready: false });
  });

  it("refuses an unsigned session when the server has no key configured", () => {
    expect(resolveInboxAuth("success", { success: true })).toEqual({
      ready: false,
    });
  });

  it("refuses an unsigned session when sync fails, including stale response data", () => {
    expect(resolveInboxAuth("error", undefined)).toEqual({ ready: false });
    expect(resolveInboxAuth("error", { subscriberHash })).toEqual({
      ready: false,
    });
  });

  it("ignores a malformed hash", () => {
    expect(resolveInboxAuth("success", { subscriberHash: 5 })).toEqual({
      ready: false,
    });
  });

  it.each(["", "abc", " ".repeat(64), "g".repeat(64)])(
    "refuses a malformed digest %p",
    (hash) => {
      expect(
        resolveInboxAuth("success", { success: true, subscriberHash: hash }),
      ).toEqual({
        ready: false,
      });
    },
  );
});
