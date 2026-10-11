/**
 * The per-row doors on the Team page. Every one takes an audited reason, so
 * the page drives them all through one dialog.
 */

/** Mirrors GET /api/admin/team/members. */
export interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  role: "STAFF" | "ADMIN";
  banned: boolean | null;
  twoFactorEnabled: boolean;
  lastActiveAt: string | null;
}

export type RowAction = "setup-link" | "suspend" | "reactivate" | "reset-2fa";

interface RowActionSpec {
  label: string;
  description: string;
  done: string;
  /** Appended to /api/admin/team/members/{id}. */
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: Record<string, string>;
  destructive?: boolean;
}

export const ROW_ACTIONS: Record<RowAction, RowActionSpec> = {
  "setup-link": {
    label: "Resend setup link",
    description:
      "They get a link to set their password. It expires in 30 minutes.",
    done: "Setup link sent",
    path: "/setup-link",
    method: "POST",
  },
  suspend: {
    label: "Suspend",
    description:
      "They are signed out everywhere and cannot sign in until you reactivate them or the suspension ends.",
    done: "Suspended",
    path: "",
    method: "PATCH",
    body: { action: "suspend" },
    destructive: true,
  },
  reactivate: {
    label: "Reactivate",
    description:
      "They can sign in again with their password and authenticator.",
    done: "Reactivated",
    path: "",
    method: "PATCH",
    body: { action: "reactivate" },
  },
  "reset-2fa": {
    label: "Reset 2FA",
    description:
      "Their authenticator, backup codes and password stop working and they are signed out everywhere. They get an email to set a new password and enrol a new authenticator, so confirm who you are talking to before you do this.",
    done: "Two-factor reset",
    path: "/two-factor",
    method: "DELETE",
    destructive: true,
  },
};

/**
 * The doors that apply to a row. A setup link only until 2FA is enrolled
 * (after that it is just a password reset). Nobody is offered their own
 * suspension or 2FA reset: the API refuses both.
 */
export function actionsFor(row: MemberRow, viewerId: string): RowAction[] {
  const actions: RowAction[] = [];
  if (!row.twoFactorEnabled && !row.banned) actions.push("setup-link");
  if (row.id !== viewerId) actions.push(row.banned ? "reactivate" : "suspend");
  if (row.twoFactorEnabled && row.id !== viewerId) actions.push("reset-2fa");
  return actions;
}
