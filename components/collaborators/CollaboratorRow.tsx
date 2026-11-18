"use client";

/**
 * One invited or accepted collaborator of a plan. A manager can change a
 * pending invitation's terms, cancel it, or remove someone from the team;
 * everyone else reads the row. A share the viewer may not see is left out.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import {
  useReloadCollaborations,
  useUpdatePendingTerms,
  type PlanRef,
} from "@/hooks/use-collaborations";
import { INVITE_TTL_DAYS } from "@/lib/collaborators/rules";
import { EndCollaborationDialog } from "./EndCollaborationDialog";
import { TermsFields, maxShareBeside, parseShare } from "./InviteDialog";
import { RefusalNotice } from "./TermsSummary";
import {
  COLLABORATOR_STATUS_BADGE,
  formatDay,
  formatRole,
  sharePercentOf,
} from "./format";
import type { TeamMember } from "./types";

/**
 * For a row or card that can leave its list: if it holds the focus when it
 * goes, the focus moves to the nearest enclosing region that accepts it
 * (`tabIndex={-1}`) instead of being dropped.
 */
export function useFocusFallback<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (!node?.contains(document.activeElement)) return;
      node.parentElement?.closest<HTMLElement>("[tabindex='-1']")?.focus();
    };
  }, []);
  return ref;
}

const nameOf = (member: TeamMember) =>
  member.consultantProfile.user.name ?? "This expert";

function EditTermsDialog({
  member,
  planRef,
  others,
}: Readonly<{
  member: TeamMember;
  planRef: PlanRef;
  others: readonly TeamMember[];
}>) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(member.role);
  const [share, setShare] = useState("");
  const update = useUpdatePendingTerms(planRef);
  const reload = useReloadCollaborations();
  const { toast } = useToast();

  const current = sharePercentOf(member);
  const sharePercent = parseShare(share, maxShareBeside(others));
  const changed = role !== member.role || sharePercent !== current;

  const onOpenChange = (next: boolean) => {
    if (update.isPending) return;
    if (next) {
      setRole(member.role);
      setShare(current === null ? "" : String(current));
      update.reset();
    }
    setOpen(next);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-9">
          Change terms <span className="sr-only">for {nameOf(member)}</span>
        </Button>
      </ResponsiveModalTrigger>
      <ResponsiveModalContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            // A dialog opened from inside another form must not submit that form.
            e.stopPropagation();
            if (sharePercent === null || !changed || update.isPending) return;
            update.mutate(
              { collaboratorId: member.id, role, sharePercent },
              {
                onSuccess: () => {
                  toast({
                    title: "Invitation updated",
                    description: `${nameOf(member)} will be told the terms changed.`,
                  });
                  setOpen(false);
                },
              },
            );
          }}
        >
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              Change the invitation to {nameOf(member)}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {nameOf(member)} is told about the change, and the{" "}
              {INVITE_TTL_DAYS} days they have to answer start again. Terms
              cannot be changed once they accept.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <TermsFields
            planType={planRef.planType}
            role={role}
            onRoleChange={setRole}
            share={share}
            onShareChange={setShare}
            others={others}
          />
          <RefusalNotice
            refusal={update.error}
            onReload={() => {
              reload();
              update.reset();
              setOpen(false);
            }}
          />
          <ResponsiveModalFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={sharePercent === null || !changed || update.isPending}
            >
              {update.isPending && (
                <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save changes
            </Button>
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

export function CollaboratorRow({
  member,
  planRef,
  planTitle,
  team,
  canManage,
}: Readonly<{
  member: TeamMember;
  planRef: PlanRef;
  planTitle: string;
  /** The plan's invited and accepted collaborators, this one included. */
  team: readonly TeamMember[];
  canManage: boolean;
}>) {
  const ref = useFocusFallback<HTMLLIElement>();
  const share = sharePercentOf(member);
  const pending = member.status === "PENDING";
  const name = nameOf(member);

  return (
    <li ref={ref} className="rounded-xl border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar className="h-9 w-9 shrink-0">
          <AvatarImage
            src={member.consultantProfile.user.image ?? undefined}
            alt=""
          />
          <AvatarFallback className="text-xs">{name.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="text-xs text-muted-foreground">
            {formatRole(member.role)}
            {share !== null && ` · ${share}% of each seat`}
          </p>
        </div>
        <StatusBadge size="sm" {...COLLABORATOR_STATUS_BADGE[member.status]} />
      </div>

      {pending && member.expiresAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          Not answered yet. The invitation lapses on{" "}
          {formatDay(member.expiresAt)}, and they earn only on seats sold after
          they accept.
        </p>
      )}

      {canManage && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {pending && (
            <EditTermsDialog
              member={member}
              planRef={planRef}
              others={team.filter((c) => c.id !== member.id)}
            />
          )}
          <EndCollaborationDialog
            kind={pending ? "cancel" : "remove"}
            planRef={planRef}
            planTitle={planTitle}
            collaboratorId={member.id}
            personName={name}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9"
              >
                {pending ? "Cancel invitation" : "Remove"}
                <span className="sr-only">
                  {pending ? ` to ${name}` : ` ${name}`}
                </span>
              </Button>
            }
          />
          {!pending && (
            <p className="basis-full text-xs text-muted-foreground">
              Accepted terms are fixed. To change them, remove {name} and send a
              new invitation.
            </p>
          )}
        </div>
      )}
    </li>
  );
}
