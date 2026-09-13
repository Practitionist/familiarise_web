/**
 * A failed Stream connect is classified before it is shown or retried: the
 * SDK's JSON-in-Error.message is never rendered, a disabled account offers
 * support rather than a Retry that cannot succeed, and the code table this
 * decision rests on matches the SDK's own `APIErrorCodes`.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  classifyConnectFailure,
  NON_RETRYABLE_STREAM_CODES,
} from "@/lib/stream/connect-failure";

const DEACTIVATED = "the user cmtv2qdw00000hryoehmkz335 was deactivated";

describe("classifyConnectFailure", () => {
  it("reads the chat client's WS payload out of Error.message", () => {
    // Verbatim shape captured by Sentry from stream-chat/src/connection.ts.
    const error = new Error(
      `{"code":16,"StatusCode":404,"message":"WS failed with code 16 and reason - ${DEACTIVATED}","isWSFailure":false}`,
    );
    const f = classifyConnectFailure(error);
    expect(f.kind).toBe("account-disabled");
    expect(f.code).toBe(16);
    expect(f.action).toBe("support");
    expect(f.detail).toBe(`WS failed with code 16 and reason - ${DEACTIVATED}`);
    expect(f.description).not.toContain("{");
  });

  it("reads the video coordinator's variant of the same payload", () => {
    const error = new Error(
      `{"code":16,"StatusCode":404,"message":"WS failed with code: 16: DoesNotExistError and reason: ${DEACTIVATED}","isWSFailure":false}`,
    );
    expect(classifyConnectFailure(error).kind).toBe("account-disabled");
  });

  it("reads a structured ErrorFromResponse by its code", () => {
    const error = Object.assign(
      new Error(
        `StreamChat error code 16: UpdateUsers failed with error: "${DEACTIVATED}"`,
      ),
      { code: 16, status: 404 },
    );
    const f = classifyConnectFailure(error);
    expect(f.kind).toBe("account-disabled");
    expect(f.title).toBe("Messaging is turned off for this account");
  });

  it("treats a bad token as not retryable but reloadable", () => {
    const f = classifyConnectFailure(
      Object.assign(new Error("token signature invalid"), { code: 43 }),
    );
    expect(f.kind).toBe("not-retryable");
    expect(f.action).toBe("reload");
  });

  it("keeps network and transient failures retryable, with the raw text as detail only", () => {
    const network = classifyConnectFailure(new TypeError("Failed to fetch"));
    expect(network.kind).toBe("retryable");
    expect(network.action).toBe("retry");
    expect(network.code).toBeNull();
    expect(network.detail).toBe("Failed to fetch");
    expect(network.description).not.toContain("Failed to fetch");

    const timeout = classifyConnectFailure(
      Object.assign(new Error("request timed out"), { code: 23 }),
    );
    expect(timeout.kind).toBe("retryable");

    expect(classifyConnectFailure("not even an Error").kind).toBe("retryable");
    expect(classifyConnectFailure(new Error("{not json")).kind).toBe(
      "retryable",
    );
  });

  it("mirrors the SDK's APIErrorCodes retryable:false set", () => {
    // stream-chat declares the table in its types but does not export it at
    // runtime, so read it from the shipped bundle: a bump that changes the
    // set fails here instead of silently retrying something new.
    const bundle = readFileSync(
      join(process.cwd(), "node_modules/stream-chat/dist/cjs/index.node.js"),
      "utf8",
    );
    const block = /APIErrorCodes = \{([\s\S]*?)\n\};/.exec(bundle)?.[1];
    expect(block).toBeDefined();
    const sdkNonRetryable = new Set(
      Array.from(
        block!.matchAll(/"(-?\d+)": \{ name: "[^"]+", retryable: false \}/g),
        (m) => Number(m[1]),
      ),
    );
    expect(sdkNonRetryable.size).toBeGreaterThan(10);
    expect(new Set(NON_RETRYABLE_STREAM_CODES)).toEqual(sdkNonRetryable);
  });
});
