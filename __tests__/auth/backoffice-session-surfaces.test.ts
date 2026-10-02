/**
 * @jest-environment node
 */

/**
 * The back-office permission table itself (#1856, review follow-up).
 *
 * The route suite asserts the doors ask for the right SURFACE, and the
 * audit row records that surface — but the gate's actual strength lives
 * in `BACKOFFICE_PERMISSIONS`, and nothing tested it. Flipping
 * `"users.moderate"` from `ADMIN_ONLY` to `OPERATORS` in that one line
 * would have handed every STAFF member a working "end someone's
 * sessions" button while both route suites stayed green.
 *
 * Read straight from the real table: no mocks, so this is the property
 * itself rather than a restatement of it.
 */

import {
  BACKOFFICE_PERMISSIONS,
  hasBackofficePermission,
  type BackofficeSurface,
} from "../../lib/auth/backoffice-permissions";

import type { UserRole } from "@prisma/client";

/** Every value of the real `UserRole` enum — no invented roles. */
const ROLES: UserRole[] = [
  "CONSULTANT",
  "CONSULTEE",
  "STAFF",
  "ADMIN",
  "ORG_WORKSPACE",
];

function allowedRoles(surface: BackofficeSurface): UserRole[] {
  return ROLES.filter((role) => hasBackofficePermission(role, surface));
}

describe("back-office session surfaces (#1856 review)", () => {
  it("lets operators SEE a user's devices", () => {
    // `users.read` is the visibility half. Staff need it to resolve
    // "is someone else in my account?" tickets.
    expect(allowedRoles("users.read")).toEqual(["STAFF", "ADMIN"]);
  });

  it("reserves ENDING someone else's sessions to ADMIN", () => {
    // ADR 35 §5: "Staff see, admin acts." Ending another person's
    // sessions is a destructive act on their account, and the
    // back-office matrix already separates seeing from destroying.
    expect(allowedRoles("users.moderate")).toEqual(["ADMIN"]);
  });

  it("keeps the two session surfaces at different strengths", () => {
    // The regression that matters: if these ever converge, the
    // "staff see, admin acts" split ADR 35 records has been undone.
    expect(allowedRoles("users.read")).not.toEqual(
      allowedRoles("users.moderate"),
    );
    expect(hasBackofficePermission("STAFF", "users.read")).toBe(true);
    expect(hasBackofficePermission("STAFF", "users.moderate")).toBe(false);
  });

  it("refuses the session surfaces to every non-staff role", () => {
    for (const role of ["CONSULTANT", "CONSULTEE", "ORG_WORKSPACE"] as const) {
      expect(hasBackofficePermission(role, "users.read")).toBe(false);
      expect(hasBackofficePermission(role, "users.moderate")).toBe(false);
    }
  });

  it("every surface maps to at least one role", () => {
    // A typo in a surface key would otherwise make a door unreachable
    // for everyone, which reads as "not a real permission" until
    // someone tries it in the UI.
    for (const [surface, roles] of Object.entries(BACKOFFICE_PERMISSIONS)) {
      expect(roles.size).toBeGreaterThan(0);
      expect(allowedRoles(surface as BackofficeSurface).length).toBe(
        roles.size,
      );
    }
  });
});
