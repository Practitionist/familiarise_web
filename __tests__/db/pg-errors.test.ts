import {
  isUniqueViolation,
  isExclusionViolation,
  isLockTimeout,
} from "@/lib/db/pg-errors";

// What Prisma 7 rethrows for an adapter-pg `kind: "postgres"` (unmapped) error.
const driverAdapterError = (code: string, msg: string) =>
  Object.assign(new Error(msg), {
    name: "DriverAdapterError",
    cause: { kind: "postgres", code, originalCode: code, message: msg },
  });

describe("pg-errors predicates", () => {
  describe("isUniqueViolation", () => {
    it("matches Prisma's P2002 code", () => {
      expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    });

    it("matches the raw SQLSTATE 23505 in meta.code", () => {
      expect(
        isUniqueViolation({ code: "P2010", meta: { code: "23505" } }),
      ).toBe(true);
    });

    it("matches 23505 on a raw DriverAdapterError cause", () => {
      expect(isUniqueViolation(driverAdapterError("23505", "dup"))).toBe(true);
    });

    it("ignores unrelated and non-object errors", () => {
      expect(isUniqueViolation(new Error("nope"))).toBe(false);
      expect(isUniqueViolation({ code: "P2025" })).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
      expect(isUniqueViolation(undefined)).toBe(false);
    });
  });

  describe("isExclusionViolation", () => {
    it("matches the structured SQLSTATE 23P01 in meta.code", () => {
      expect(
        isExclusionViolation({ code: "P2010", meta: { code: "23P01" } }),
      ).toBe(true);
    });

    it("matches 23P01 on a raw DriverAdapterError cause", () => {
      expect(
        isExclusionViolation(driverAdapterError("23P01", "conflicting key")),
      ).toBe(true);
    });

    it("matches the constraint name in the message (Prisma unmodelled-constraint gap)", () => {
      expect(
        isExclusionViolation({
          message:
            'conflicting key value violates exclusion constraint "occurrence_no_confirmed_overlap"',
        }),
      ).toBe(true);
    });

    it("matches the bare 23P01 SQLSTATE token in the message", () => {
      expect(isExclusionViolation({ message: "ERROR: 23P01: conflict" })).toBe(
        true,
      );
    });

    it("does not confuse a unique violation for an exclusion one", () => {
      expect(isExclusionViolation({ code: "P2002" })).toBe(false);
      expect(isExclusionViolation(new Error("unique constraint failed"))).toBe(
        false,
      );
      expect(isExclusionViolation(driverAdapterError("23505", "dup"))).toBe(
        false,
      );
      expect(isExclusionViolation(undefined)).toBe(false);
    });
  });
});

describe("isLockTimeout", () => {
  it("matches SQLSTATE 55P03 in a P2010 raw-query error's meta.code", () => {
    expect(isLockTimeout({ code: "P2010", meta: { code: "55P03" } })).toBe(
      true,
    );
  });

  it("matches 55P03 on a raw DriverAdapterError cause", () => {
    expect(
      isLockTimeout(
        driverAdapterError("55P03", "canceling statement due to lock timeout"),
      ),
    ).toBe(true);
  });

  it("ignores other lock and conflict codes and non-objects", () => {
    expect(isLockTimeout(driverAdapterError("40P01", "deadlock"))).toBe(false);
    expect(isLockTimeout({ code: "P2034", meta: { code: "40001" } })).toBe(
      false,
    );
    expect(isLockTimeout(new Error("Query read timeout"))).toBe(false);
    expect(isLockTimeout({ message: "55P03" })).toBe(false);
    expect(isLockTimeout(null)).toBe(false);
  });
});
