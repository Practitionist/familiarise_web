"use client";

/**
 * Inviting an expert onto a plan: find them, pick a role with what it grants,
 * set a share, then review the whole offer before it is sent. The role and
 * share fields are also what a manager edits on a pending invitation.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { CollaboratorRole } from "@prisma/client";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { useToast } from "@/hooks/use-toast";
import {
  useInviteCollaborator,
  useReloadCollaborations,
  type PlanRef,
} from "@/hooks/use-collaborations";
import { ROLE_INFO, isPresenterRole } from "@/lib/collaborators/roles";
import {
  MAX_COLLABORATORS_PER_PLAN,
  MAX_TEAM_SHARE_BPS,
  bpsToPercent,
  inviteExpiresAt,
} from "@/lib/collaborators/rules";
import {
  COLLABORATOR_ROLES_BY_PLAN_TYPE,
  MIN_SHARE_PERCENT,
} from "@/schemas/collaborators";
import {
  ConsultantSearchInput,
  type ExpertResult,
} from "./ConsultantSearchInput";
import { RefusalNotice, TermsSummary } from "./TermsSummary";
import { sharePercentOf, teamSharePercent } from "./format";
import type { PlanType, TeamMember } from "./types";

const CAP_PERCENT = bpsToPercent(MAX_TEAM_SHARE_BPS);

/** The largest whole percent one more share may take beside the plan's other live rows. */
export const maxShareBeside = (others: readonly TeamMember[]): number =>
  Math.floor(CAP_PERCENT - teamSharePercent(others));

/** A typed share as a whole percent within what the plan has left, or null. */
export function parseShare(text: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const percent = Number(text.trim());
  return percent >= MIN_SHARE_PERCENT && percent <= max ? percent : null;
}

/** Why this plan cannot take another invitation now, or null when it can. */
function inviteBlockedReason(team: readonly TeamMember[]): string | null {
  if (team.length >= MAX_COLLABORATORS_PER_PLAN) {
    return `This plan already has ${MAX_COLLABORATORS_PER_PLAN} invited or accepted collaborators, the most a plan can have.`;
  }
  if (maxShareBeside(team) < MIN_SHARE_PERCENT) {
    return `Collaborators already hold ${teamSharePercent(team)}% of this plan and the limit is ${CAP_PERCENT}%, so there is no share left to offer.`;
  }
  return null;
}

/** The role and share of an invitation. `others` are the plan's other live rows. */
export function TermsFields({
  planType,
  role,
  onRoleChange,
  share,
  onShareChange,
  others,
}: Readonly<{
  planType: PlanType;
  role: CollaboratorRole | null;
  onRoleChange: (role: CollaboratorRole) => void;
  share: string;
  onShareChange: (share: string) => void;
  others: readonly TeamMember[];
}>) {
  const groupLabelId = useId();
  const shareId = useId();
  const shareHintId = useId();
  const roles = COLLABORATOR_ROLES_BY_PLAN_TYPE[planType];
  const presenterTaken = others.some((c) => isPresenterRole(c.role));
  const othersPercent = teamSharePercent(others);
  const max = maxShareBeside(others);
  const percent = parseShare(share, max);
  const invalid = share.trim().length > 0 && percent === null;

  return (
    <div className="space-y-4">
      <div>
        <p id={groupLabelId} className="text-sm font-medium text-foreground">
          Role
        </p>
        <RadioGroup
          aria-labelledby={groupLabelId}
          value={role ?? ""}
          onValueChange={(value) => {
            const next = roles.find((r) => r === value);
            if (next) onRoleChange(next);
          }}
          className="mt-1.5 gap-1.5"
        >
          {roles.map((option) => {
            const info = ROLE_INFO[option];
            const taken = presenterTaken && isPresenterRole(option);
            const itemId = `${groupLabelId}-${option}`;
            return (
              <div
                key={option}
                className="flex min-h-11 items-start gap-3 rounded-lg border border-border p-2.5"
              >
                <RadioGroupItem
                  id={itemId}
                  value={option}
                  disabled={taken}
                  aria-describedby={`${itemId}-about`}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <Label htmlFor={itemId} className="font-medium">
                    {info.label}
                  </Label>
                  <p
                    id={`${itemId}-about`}
                    className="mt-0.5 text-xs text-muted-foreground"
                  >
                    {info.summary} {info.can.join(". ")}.
                    {taken &&
                      " Not available: this plan already has a co-presenter."}
                  </p>
                </div>
              </div>
            );
          })}
        </RadioGroup>
      </div>

      <div>
        <Label htmlFor={shareId}>Their share of each seat (%)</Label>
        <Input
          id={shareId}
          inputMode="numeric"
          autoComplete="off"
          value={share}
          onChange={(e) => onShareChange(e.target.value)}
          aria-invalid={invalid}
          aria-describedby={shareHintId}
          className="mt-1.5 w-28"
        />
        <p
          id={shareHintId}
          className={
            invalid
              ? "mt-1.5 text-xs text-destructive"
              : "mt-1.5 text-xs text-muted-foreground"
          }
        >
          {invalid ? "Enter a whole number" : "A whole number"} from{" "}
          {MIN_SHARE_PERCENT} to {max}.{" "}
          {percent === null
            ? `Other collaborators hold ${othersPercent}% of this plan; the limit for all of them together is ${CAP_PERCENT}%.`
            : `Collaborators would hold ${othersPercent + percent}% of this plan between them and you would keep ${100 - othersPercent - percent}%. The limit for collaborators is ${CAP_PERCENT}%.`}
        </p>
      </div>
    </div>
  );
}

export function InviteDialog({
  planRef,
  planTitle,
  planPricePaise,
  team,
}: Readonly<{
  planRef: PlanRef;
  planTitle: string;
  planPricePaise: number;
  /** The plan's invited and accepted collaborators. */
  team: readonly TeamMember[];
}>) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"terms" | "review">("terms");
  const [expert, setExpert] = useState<ExpertResult | null>(null);
  const [role, setRole] = useState<CollaboratorRole | null>(null);
  const [share, setShare] = useState("10");
  const [searchListOpen, setSearchListOpen] = useState(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const blockedId = useId();
  const { toast } = useToast();
  const invite = useInviteCollaborator(planRef);
  const reload = useReloadCollaborations();

  const blocked = inviteBlockedReason(team);
  const sharePercent = parseShare(share, maxShareBeside(team));
  const ready = expert !== null && role !== null && sharePercent !== null;
  const onTeam = new Map(
    team.map((c) => [c.consultantProfile.id, "Already on this plan"]),
  );

  // Each step is announced: focus moves to its heading when the step changes.
  useEffect(() => {
    if (open) stepHeading.current?.focus();
  }, [open, step]);

  const reset = () => {
    setStep("terms");
    setExpert(null);
    setRole(null);
    setShare("10");
    invite.reset();
  };

  const onOpenChange = (next: boolean) => {
    if (invite.isPending) return;
    if (!next) reset();
    setOpen(next);
  };

  const send = () => {
    if (!expert || !role || sharePercent === null) return;
    invite.mutate(
      { consultantProfileId: expert.id, role, sharePercent },
      {
        onSuccess: () => {
          toast({
            title: "Invitation sent",
            description: `${expert.user.name ?? "The expert"} has been asked to join “${planTitle}”.`,
          });
          reset();
          setOpen(false);
        },
      },
    );
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <div>
        <ResponsiveModalTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={blocked !== null}
            aria-describedby={blocked ? blockedId : undefined}
            className="min-h-11 w-full sm:w-auto"
          >
            <UserPlus aria-hidden className="mr-2 h-4 w-4" />
            Invite a collaborator
          </Button>
        </ResponsiveModalTrigger>
        {blocked && (
          <p id={blockedId} className="mt-1.5 text-xs text-muted-foreground">
            {blocked}
          </p>
        )}
      </div>
      <ResponsiveModalContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onEscapeKeyDown={(e) => {
          if (searchListOpen) e.preventDefault();
        }}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            // A dialog opened from inside another form must not submit that form.
            e.stopPropagation();
            if (!ready || invite.isPending) return;
            if (step === "terms") setStep("review");
            else send();
          }}
        >
          <ResponsiveModalHeader>
            <ResponsiveModalTitle
              ref={stepHeading}
              tabIndex={-1}
              className="outline-none"
            >
              {step === "terms"
                ? "Invite a collaborator"
                : "Review the invitation"}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {step === "terms"
                ? `Step 1 of 2. Who joins “${planTitle}”, as what, and for what share.`
                : "Step 2 of 2. Nothing is sent until you press Send invitation."}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          {step === "terms" ? (
            <>
              <ConsultantSearchInput
                label="Expert"
                selected={expert}
                onSelect={setExpert}
                unavailable={onTeam}
                onListOpenChange={setSearchListOpen}
              />
              <TermsFields
                planType={planRef.planType}
                role={role}
                onRoleChange={setRole}
                share={share}
                onShareChange={setShare}
                others={team}
              />
            </>
          ) : (
            expert &&
            role &&
            sharePercent !== null && (
              <>
                <p className="text-sm text-foreground">
                  You are inviting{" "}
                  <span className="font-semibold">
                    {expert.user.name ?? "this expert"}
                  </span>{" "}
                  to “{planTitle}”.
                </p>
                <TermsSummary
                  role={role}
                  sharePercent={sharePercent}
                  audience="manager"
                  planPricePaise={planPricePaise}
                  otherSharePercents={team.map((c) => sharePercentOf(c) ?? 0)}
                  expiresAt={inviteExpiresAt(new Date())}
                />
                <RefusalNotice
                  refusal={invite.error}
                  onReload={() => {
                    reload();
                    reset();
                  }}
                />
              </>
            )
          )}

          <ResponsiveModalFooter className="gap-2 sm:gap-0">
            {step === "terms" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!ready}>
                  Review invitation
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={invite.isPending}
                  onClick={() => {
                    invite.reset();
                    setStep("terms");
                  }}
                >
                  Back
                </Button>
                <Button type="submit" disabled={!ready || invite.isPending}>
                  {invite.isPending && (
                    <Loader2
                      aria-hidden
                      className="mr-2 h-4 w-4 animate-spin"
                    />
                  )}
                  Send invitation
                </Button>
              </>
            )}
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
