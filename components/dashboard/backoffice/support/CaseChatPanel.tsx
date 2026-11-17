"use client";

import { useState } from "react";
import { ReasonDialog } from "@/components/dashboard/backoffice/money/ReasonDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { OperatorTime } from "@/lib/time/operator-time";
import {
  SUPPORT_CHAT_READ_HOURS,
  type ChatGrant,
  type ChatStatus,
} from "@/schemas/support-chat";
import {
  errorText,
  liveIntervention,
  useChatAction,
  useChatStatus,
} from "./case-chat-data";
import { CaseChatIntervention } from "./CaseChatIntervention";
import { CaseChatTargets, WithholdNoticeField } from "./CaseChatTargets";
import { CaseChatTranscript } from "./CaseChatTranscript";

const when = (iso: string) => <OperatorTime value={iso} />;

/** "Support in chat" while any Familiarise Support intervention on the case is live. */
export function SupportInChatPill({ caseId }: Readonly<{ caseId: string }>) {
  const status = useChatStatus(caseId);
  if (!status.data || !liveIntervention(status.data)) return null;
  return <StatusBadge label="Support in chat" tone="info" size="sm" withDot />;
}

function OpenReadAction({
  caseId,
  status,
}: Readonly<{ caseId: string; status: ChatStatus }>) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [withholdNotice, setWithholdNotice] = useState(false);
  const action = useChatAction(caseId);
  const group = status.channel?.kind === "GROUP";
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setTargets([]);
      setWithholdNotice(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          action.reset();
          changeOpen(true);
        }}
      >
        Open chat (logged)
      </Button>
      <ReasonDialog
        open={open}
        onOpenChange={changeOpen}
        title="Open the booking chat?"
        description={`Reading is logged against this case and lasts ${SUPPORT_CHAT_READ_HOURS} hours. The people in the chat aren't told now; they're told after the case decision.`}
        confirmLabel="Open chat"
        pending={action.isPending}
        canConfirm={!status.requiresTargets || targets.length > 0}
        onConfirm={(reason) =>
          action.mutate(
            {
              action: "OPEN_READ",
              ...(group && targets.length > 0
                ? { targetUserIds: targets }
                : {}),
              withholdNotice,
              reason,
            },
            { onSuccess: () => changeOpen(false) },
          )
        }
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
    </>
  );
}

function ReadGrantBar({
  caseId,
  grant,
}: Readonly<{ caseId: string; grant: ChatGrant }>) {
  const [ending, setEnding] = useState(false);
  const action = useChatAction(caseId);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <p className="text-muted-foreground">
        You can read this chat until {when(grant.expiresAt)}.
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          action.reset();
          setEnding(true);
        }}
      >
        End access
      </Button>
      <ReasonDialog
        open={ending}
        onOpenChange={setEnding}
        title="End chat access?"
        description="The transcript closes for you. Reading it again needs a new reason."
        confirmLabel="End access"
        pending={action.isPending}
        onConfirm={(reason) =>
          action.mutate(
            { action: "END_READ", grantId: grant.id, reason },
            { onSuccess: () => setEnding(false) },
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

/** Case-linked, audited staff access to the booking chat; renders nothing for non-staff (403). */
export function CaseChatPanel({ caseId }: Readonly<{ caseId: string }>) {
  const query = useChatStatus(caseId);
  if (query.isPending)
    return (
      <p className="text-xs text-muted-foreground">Loading booking chat…</p>
    );
  if (query.isError)
    return (
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
        Retry booking chat
      </Button>
    );
  const status = query.data;
  if (!status) return null;
  const live = status.grants.filter((grant) => grant.live && grant.mine);
  const myRead = live.find((grant) => grant.kind === "READ");
  const myIntervention = live.find((grant) => grant.kind === "INTERVENE");
  const viewing = myIntervention ?? myRead;
  const intervening = liveIntervention(status);
  return (
    <section
      aria-label="Booking chat"
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Booking chat</h3>
          {intervening && (
            <StatusBadge
              label="Support in chat"
              tone="info"
              size="sm"
              withDot
            />
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh status
        </Button>
      </div>
      {!status.read.ok && (
        <p className="text-xs text-muted-foreground">{status.read.message}</p>
      )}
      {status.read.ok && !viewing && (
        <OpenReadAction caseId={caseId} status={status} />
      )}
      {myRead && <ReadGrantBar caseId={caseId} grant={myRead} />}
      {viewing && <CaseChatTranscript caseId={caseId} grantId={viewing.id} />}
      {status.canIntervene && (status.read.ok || intervening) && (
        <CaseChatIntervention caseId={caseId} status={status} />
      )}
    </section>
  );
}
