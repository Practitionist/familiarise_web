import { resolveInboxAuth } from "@/lib/novu/inbox-auth";

describe("resolveInboxAuth", () => {
  it("holds the Inbox back while the subscriber sync is pending", () => {
    expect(resolveInboxAuth("pending", undefined)).toEqual({ ready: false });
  });

  it("passes the hash through once the sync succeeds", () => {
    expect(
      resolveInboxAuth("success", { success: true, subscriberHash: "abc" }),
    ).toEqual({ ready: true, subscriberHash: "abc" });
  });

  it("mounts without a hash when the server has no key configured", () => {
    expect(resolveInboxAuth("success", { success: true })).toEqual({
      ready: true,
    });
  });

  it("mounts without a hash when the sync failed", () => {
    expect(resolveInboxAuth("error", undefined)).toEqual({ ready: true });
  });

  it("ignores a malformed hash", () => {
    expect(resolveInboxAuth("success", { subscriberHash: 5 })).toEqual({
      ready: true,
    });
  });
});
