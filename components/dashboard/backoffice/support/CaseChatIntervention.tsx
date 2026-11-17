"use client";

import { useId, useState } from "react";
import { z } from "zod";
import { ReasonDialog } from "@/components/dashboard/backoffice/money/ReasonDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OperatorTime } from "@/lib/time/operator-time";
import {
  SUPPORT_CHAT_DEFAULT_INTERVENTION_HOURS,
  SUPPORT_CHAT_INTERVENTION_BASES,
  SUPPORT_CHAT_INTERVENTION_HOURS,
  SUPPORT_CHAT_MESSAGE_MAX,
  type ChatGrant,
  type ChatStatus,
  type SupportChatInterventionBasis,
} from "@/schemas/support-chat";
import {
  ASSERTABLE_BASES,
  BASIS_LABEL,
  errorText,
  liveIntervention,
  newClientActionId,
  useChatAction,
  usePostSupportMessage,
} from "./case-chat-data";
import { CaseChatTargets, WithholdNoticeField } from "./CaseChatTargets";

type InterventionHours = (typeof SUPPORT_CHAT_INTERVENTION_HOURS)[number];

const when = (iso: string) => <OperatorTime value={iso} />;

const HOURS_LABEL: Record<InterventionHours, string> = {
  24: "24 hours",
  72: "72 hours (3 days)",
  168: "168 hours (7 days)",
};

const BasisChoice = z.union([
  z.enum(SUPPORT_CHAT_INTERVENTION_BASES),
  z.literal(""),
]);

export const VISIBILITY_NOTE =
  "Everyone in the chat sees the Familiarise Support banner and every message you post.";

function Composer({
  caseId,
  grantId,
  joined,
}: Readonly<{ caseId: string; grantId: string; joined: boolean }>) {
  const [text, setText] = useState("");
  // One id per draft: a retry of the same text replays instead of posting twice.
  const [clientActionId, setClientActionId] = useState<string | null>(null);
  const post = usePostSupportMessage(caseId);
  const send = () => {
    const id = clientActionId ?? newClientActionId();
    setClientActionId(id);
    post.mutate(
      { grantId, clientActionId: id, text: text.trim() },
      {
        onSuccess: () => {
          setText("");
          setClientActionId(null);
        },
      },
    );
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Textarea
        aria-label="Message as Familiarise Support"
        value={text}
        maxLength={SUPPORT_CHAT_MESSAGE_MAX}
        disabled={post.isPending}
        onChange={(event) => {
          setText(event.target.value);
          setClientActionId(null);
        }}
        placeholder="Write to everyone in the chat"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {text.length}/{SUPPORT_CHAT_MESSAGE_MAX}
        </span>
        <Button
          size="sm"
          type="submit"
          disabled={!joined || post.isPending || !text.trim()}
        >
          {post.isPending ? "Sending…" : "Send"}
        </Button>
      </div>
      {!joined && (
        <p className="text-xs text-muted-foreground">
          You can post once Familiarise Support has joined. Use Refresh status
          to check.
        </p>
      )}
      {post.isError && (
        <p role="alert" className="text-xs text-destructive">
          {errorText(post.error)}
        </p>
      )}
    </form>
  );
}

function LiveIntervention({
  caseId,
  grant,
}: Readonly<{ caseId: string; grant: ChatGrant }>) {
  const [leaving, setLeaving] = useState(false);
  const action = useChatAction(caseId);
  const joined = grant.streamJoinedAt !== null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge
          label={joined ? "Joined" : "Joining…"}
          tone={joined ? "success" : "caution"}
          size="sm"
        />
        <span className="text-muted-foreground">
          {BASIS_LABEL[grant.basis]} · Ends {when(grant.expiresAt)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{VISIBILITY_NOTE}</p>
      <Composer caseId={caseId} grantId={grant.id} joined={joined} />
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          action.reset();
          setLeaving(true);
        }}
      >
        Leave chat
      </Button>
      <ReasonDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Leave the chat?"
        description="Familiarise Support leaves the chat and your access to its transcript ends."
        confirmLabel="Leave chat"
        pending={action.isPending}
        onConfirm={(reason) =>
          action.mutate(
            { action: "END_INTERVENTION", grantId: grant.id, reason },
            { onSuccess: () => setLeaving(false) },
          )
        }
      >
        {action.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(action.error)}
          </p>
        )}
      </ReasonDialog>
    </div>
  );
}

function StartIntervention({
  caseId,
  status,
  verifiedBases,
}: Readonly<{
  caseId: string;
  status: ChatStatus;
  verifiedBases: readonly SupportChatInterventionBasis[];
}>) {
  const hoursName = useId();
  const verified = new Set(verifiedBases);
  const options = SUPPORT_CHAT_INTERVENTION_BASES.filter(
    (basis) => verified.has(basis) || ASSERTABLE_BASES.has(basis),
  );
  const [basis, setBasis] = useState<SupportChatInterventionBasis | "">(
    verifiedBases[0] ?? "",
  );
  const [hours, setHours] = useState<InterventionHours>(
    SUPPORT_CHAT_DEFAULT_INTERVENTION_HOURS,
  );
  const [targets, setTargets] = useState<string[]>([]);
  const [withholdNotice, setWithholdNotice] = useState(false);
  const [open, setOpen] = useState(false);
  const action = useChatAction(caseId);
  const group = status.channel?.kind === "GROUP";
  const asserted = basis !== "" && !verified.has(basis);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setTargets([]);
      setWithholdNotice(false);
    }
  };
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="font-medium">Basis</span>
        <select
          aria-label="Intervention basis"
          className="w-full rounded-md border bg-background p-2"
          value={basis}
          onChange={(event) => setBasis(BasisChoice.parse(event.target.value))}
        >
          <option value="">Select a basis</option>
          {options.map((value) => (
            <option key={value} value={value}>
              {BASIS_LABEL[value]}
              {verified.has(value) ? " (verified)" : ""}
            </option>
          ))}
        </select>
      </label>
      {asserted && (
        <p role="note" className="rounded border border-border p-2 text-xs">
          This basis isn&apos;t verified by the system. You are asserting it,
          and your reason is kept in the audit log.
        </p>
      )}
      <fieldset className="space-y-1">
        <legend className="font-medium">How long</legend>
        {SUPPORT_CHAT_INTERVENTION_HOURS.map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name={hoursName}
              checked={hours === value}
              onChange={() => setHours(value)}
            />
            <span>{HOURS_LABEL[value]}</span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          Access can&apos;t be extended; join again with a new reason.
        </p>
      </fieldset>
      <p className="text-xs text-muted-foreground">{VISIBILITY_NOTE}</p>
      <Button
        size="sm"
        disabled={basis === ""}
        onClick={() => {
          action.reset();
          changeOpen(true);
        }}
      >
        Join as Familiarise Support
      </Button>
      <ReasonDialog
        open={open}
        onOpenChange={changeOpen}
        title="Join the chat as Familiarise Support?"
        description={`${VISIBILITY_NOTE} Access ends after ${hours} hours.`}
        confirmLabel="Join the chat"
        pending={action.isPending}
        canConfirm={
          basis !== "" && (!status.requiresTargets || targets.length > 0)
        }
        onConfirm={(reason) => {
          if (basis === "") return;
          action.mutate(
            {
              action: "START_INTERVENTION",
              basis,
              durationHours: hours,
              ...(group && targets.length > 0
                ? { targetUserIds: targets }
                : {}),
              withholdNotice,
              reason,
            },
            { onSuccess: () => changeOpen(false) },
          );
        }}
      >
        {group && (
          <CaseChatTargets
            parties={status.parties}
            required={status.requiresTargets}
            value={targets}
            onChange={setTargets}
          />
        )}
        <WithholdNoticeField
          checked={withholdNotice}
          onChange={setWithholdNotice}
        />
        {action.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(action.error)}
          </p>
        )}
      </ReasonDialog>
    </div>
  );
}

function InterventionBody({
  caseId,
  status,
}: Readonly<{ caseId: string; status: ChatStatus }>) {
  const live = liveIntervention(status);
  if (live?.mine) return <LiveIntervention caseId={caseId} grant={live} />;
  if (live)
    return (
      <p className="text-xs text-muted-foreground">
        Familiarise Support is already in this chat
        {live.grantedByName
          ? `, joined by ${live.grantedByName},`
          : ""} until {when(live.expiresAt)}.
      </p>
    );
  if (!status.intervene.ok)
    return (
      <p className="text-xs text-muted-foreground">
        {status.intervene.message}
      </p>
    );
  return (
    <StartIntervention
      caseId={caseId}
      status={status}
      verifiedBases={status.intervene.verifiedBases}
    />
  );
}

/** The visible "Familiarise Support" seat: start it, post as it, or leave. */
export function CaseChatIntervention({
  caseId,
  status,
}: Readonly<{ caseId: string; status: ChatStatus }>) {
  return (
    <section
      aria-label="Intervene as Familiarise Support"
      className="space-y-2 border-t border-border pt-3"
    >
      <h4 className="font-medium">Intervene as Familiarise Support</h4>
      <InterventionBody caseId={caseId} status={status} />
    </section>
  );
}
