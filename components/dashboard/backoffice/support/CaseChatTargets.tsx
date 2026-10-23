"use client";

import type { ChatParty } from "@/schemas/support-chat";

const PARTY_ROLE: Record<ChatParty["role"], string> = {
  REPORTER: "Reporter",
  DELIVERING: "Delivering",
  ATTENDEE: "Attendee",
};

export const WITHHOLD_NOTICE_LABEL =
  "Don't tell the people in the case afterwards (only when telling would create risk)";

export function WithholdNoticeField({
  checked,
  onChange,
}: Readonly<{ checked: boolean; onChange: (next: boolean) => void }>) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{WITHHOLD_NOTICE_LABEL}</span>
    </label>
  );
}

/** Group-chat attendees the case is about; the reporter can't be their own target. */
export function CaseChatTargets({
  parties,
  required,
  value,
  onChange,
}: Readonly<{
  parties: readonly ChatParty[];
  required: boolean;
  value: readonly string[];
  onChange: (next: string[]) => void;
}>) {
  const candidates = parties.filter((party) => party.role !== "REPORTER");
  return (
    <fieldset className="space-y-1.5 text-sm">
      <legend className="font-medium">
        Who is the case about?{required ? " (required)" : " (optional)"}
      </legend>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No other people are in this chat.
        </p>
      ) : (
        candidates.map((party) => (
          <label key={party.userId} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.includes(party.userId)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, party.userId]
                    : value.filter((id) => id !== party.userId),
                )
              }
            />
            <span>
              {party.name} · {PARTY_ROLE[party.role]}
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}
