/**
 * A join that fails for any reason other than a typed refusal gets a designed
 * face with a Retry; the provider-unavailable face also retries by itself.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  JoinHttpError,
  MAX_PROVIDER_AUTO_RETRIES,
  VideoClientTimeoutError,
  classifyJoinFailure,
  providerRetryDelayMs,
} from "../../app/meetings/[id]/join-failure";
import { JoinFailureCard } from "../../app/meetings/[id]/components/JoinFailureCard";

const SFU_PARTICIPANT_LIMIT_REACHED = 301;

describe("classifyJoinFailure", () => {
  it("treats a Stream outage, a network drop and the client-wait timeout as provider unavailable", () => {
    expect(classifyJoinFailure(new JoinHttpError("down", 503))).toBe(
      "provider_unavailable",
    );
    expect(classifyJoinFailure(new JoinHttpError("slow", 504))).toBe(
      "provider_unavailable",
    );
    expect(classifyJoinFailure(new JoinHttpError("busy", 429))).toBe(
      "provider_unavailable",
    );
    expect(classifyJoinFailure(new TypeError("Failed to fetch"))).toBe(
      "provider_unavailable",
    );
    // The video SDK's own HTTP client words an offline request with a space.
    expect(classifyJoinFailure(new Error("Network Error"))).toBe(
      "provider_unavailable",
    );
    // A join retried while the network is still coming back cannot open the SFU socket.
    expect(
      classifyJoinFailure(
        new Error("SFU WS connection failed to open after 5000ms"),
      ),
    ).toBe("provider_unavailable");
    expect(classifyJoinFailure(new VideoClientTimeoutError())).toBe(
      "provider_unavailable",
    );
    expect(
      classifyJoinFailure({
        status: 502,
        message: "bad gateway",
      }),
    ).toBe("provider_unavailable");
  });

  it("leaves a programming TypeError as unknown, not an outage", () => {
    expect(
      classifyJoinFailure(
        new TypeError("Cannot read properties of null (reading 'callId')"),
      ),
    ).toBe("unknown");
  });

  it("maps the SFU participant-limit code, and the coordinator's wording, to a full room", () => {
    expect(
      classifyJoinFailure(
        Object.assign(new Error("Join Error"), {
          errorEvent: { error: { code: SFU_PARTICIPANT_LIMIT_REACHED } },
        }),
      ),
    ).toBe("room_full");
    expect(
      classifyJoinFailure(new Error("call participant limit reached")),
    ).toBe("room_full");
  });

  it("leaves a server fault and anything unrecognised as unknown", () => {
    expect(classifyJoinFailure(new JoinHttpError("boom", 500))).toBe("unknown");
    expect(classifyJoinFailure(new JoinHttpError("conflict", 409))).toBe(
      "unknown",
    );
    expect(classifyJoinFailure(new Error("something odd"))).toBe("unknown");
    expect(classifyJoinFailure("nope")).toBe("unknown");
  });
});

describe("providerRetryDelayMs", () => {
  it("backs off exponentially, jittered, and never past the cap", () => {
    expect(providerRetryDelayMs(0, () => 1)).toBe(2_000);
    expect(providerRetryDelayMs(0, () => 0)).toBe(1_000);
    expect(providerRetryDelayMs(1, () => 1)).toBe(4_000);
    expect(providerRetryDelayMs(20, () => 1)).toBe(30_000);
    expect(providerRetryDelayMs(20, () => 0)).toBe(15_000);
  });
});

describe("JoinFailureCard", () => {
  it.each([
    ["provider_unavailable", "Your session is protected"],
    ["room_full", "close that tab and try again"],
    ["unknown", "Try again"],
  ] as const)("shows guidance and a working Retry for %s", (kind, copy) => {
    const onRetry = jest.fn();
    render(
      <JoinFailureCard kind={kind} isRetrying={false} onRetry={onRetry} />,
    );

    expect(screen.getByTestId("join-failure-card").dataset.failureKind).toBe(
      kind,
    );
    expect(screen.getByRole("alert").textContent).toContain(copy);
    fireEvent.click(screen.getByTestId("join-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces the automatic retry only for the provider-unavailable face", () => {
    const { rerender } = render(
      <JoinFailureCard
        kind="provider_unavailable"
        isRetrying={false}
        autoRetryCount={1}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.getByTestId("join-failure-auto-retry").textContent).toContain(
      `2 of ${MAX_PROVIDER_AUTO_RETRIES}`,
    );

    rerender(
      <JoinFailureCard
        kind="provider_unavailable"
        isRetrying={false}
        autoRetryCount={MAX_PROVIDER_AUTO_RETRIES}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("join-failure-auto-retry")).toBeNull();

    rerender(
      <JoinFailureCard
        kind="room_full"
        isRetrying={false}
        autoRetryCount={0}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("join-failure-auto-retry")).toBeNull();
  });

  it("disables Retry while a retry is in flight", () => {
    render(<JoinFailureCard kind="unknown" isRetrying onRetry={jest.fn()} />);
    expect(
      (screen.getByTestId("join-retry") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
