/**
 * Pins the storage defences on the verification upload path: the per-user
 * byte quota, the outstanding-unlinked cap, and the per-request cap.
 */

import {
  decideUploadAdmission,
  MAX_DOCS_PER_VERIFICATION,
  MAX_OUTSTANDING_UPLOADS,
  VERIFICATION_STORAGE_QUOTA_BYTES,
} from "../../lib/verification/documents";

const MB = 1024 * 1024;

describe("decideUploadAdmission", () => {
  it("admits a first upload", () => {
    expect(
      decideUploadAdmission({
        incomingBytes: 5 * MB,
        ownedBytes: 0,
        outstandingUnlinked: 0,
        linkedToTarget: 0,
        linkingToRequest: false,
      }),
    ).toBeNull();
  });

  it("refuses when the lifetime quota would be exceeded, exactly at the edge", () => {
    expect(
      decideUploadAdmission({
        incomingBytes: 1,
        ownedBytes: VERIFICATION_STORAGE_QUOTA_BYTES,
        outstandingUnlinked: 0,
        linkedToTarget: 0,
        linkingToRequest: false,
      })?.code,
    ).toBe("QUOTA_EXCEEDED");
    expect(
      decideUploadAdmission({
        incomingBytes: 1 * MB,
        ownedBytes: VERIFICATION_STORAGE_QUOTA_BYTES - 1 * MB,
        outstandingUnlinked: 0,
        linkedToTarget: 0,
        linkingToRequest: false,
      }),
    ).toBeNull();
  });

  it("caps outstanding unlinked uploads", () => {
    expect(
      decideUploadAdmission({
        incomingBytes: 1,
        ownedBytes: 0,
        outstandingUnlinked: MAX_OUTSTANDING_UPLOADS,
        linkedToTarget: 0,
        linkingToRequest: false,
      })?.code,
    ).toBe("TOO_MANY_OUTSTANDING");
  });

  it("caps documents per request when linking directly", () => {
    expect(
      decideUploadAdmission({
        incomingBytes: 1,
        ownedBytes: 0,
        outstandingUnlinked: 0,
        linkedToTarget: MAX_DOCS_PER_VERIFICATION,
        linkingToRequest: true,
      })?.code,
    ).toBe("TOO_MANY_PER_REQUEST");
  });

  it("the quota is checked before the count caps", () => {
    expect(
      decideUploadAdmission({
        incomingBytes: VERIFICATION_STORAGE_QUOTA_BYTES + 1,
        ownedBytes: 0,
        outstandingUnlinked: MAX_OUTSTANDING_UPLOADS,
        linkedToTarget: 0,
        linkingToRequest: false,
      })?.code,
    ).toBe("QUOTA_EXCEEDED");
  });
});
