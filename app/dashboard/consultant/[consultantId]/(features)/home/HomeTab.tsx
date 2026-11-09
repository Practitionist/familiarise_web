"use client";

import { useMemo } from "react";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";
import type { HomeRequestsQuery } from "@/components/dashboard/shared/requests/RequestsInboxPreview";
// The Stream SDK stays off the Home bundle: the video client and the meeting
// helper load inside the Join handler, only when someone clicks Join.
import { useLazyJoinMeeting } from "@/hooks/scheduling/useLazyJoinMeeting";
import { useChatUnreadCount } from "@/hooks/useChatUnreadCount";
import { useNowTick } from "@/hooks/use-now-tick";
import { useSession } from "@/lib/auth-client";
import { resolveSponsoringOrgName } from "@/lib/labels/session-labels";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import type { TAppointment } from "@/types/appointment";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

import { AgendaLists } from "./Agenda";
import { LatestFeedback } from "./LatestFeedback";
import { SharePanel } from "./SharePanel";
import {
  ClientBookingsPanel,
  GlancePanel,
  OrgSessionsPanel,
  RequestsPanel,
} from "./HomeSidebar";
import { MoneyLine } from "./MoneyLine";
import { NeedsYou } from "./NeedsYou";
import { NextSession } from "./NextSession";
import {
  deriveAgenda,
  deriveGlanceRows,
  deriveHomeNeedsYou,
  deriveHomeSessions,
  deriveMoneyLine,
  deriveRatingParts,
  type HomeSession,
} from "./home-model";

interface HomeTabProps {
  appointments: TAppointment[];
  consultantId: string;
  orgSessions?: TConsultantDashboardResponse["orgSessions"];
  clientBookings?: TConsultantDashboardResponse["clientBookings"];
  payoutSetup: TConsultantDashboardResponse["payoutSetup"];
  /** Absent when that read failed. */
  needsYou?: TConsultantDashboardResponse["needsYou"];
  sessionsDelivered?: TConsultantDashboardResponse["sessionsDelivered"];
  /** The setup checklist; absent once every step is done. */
  firstRun?: TConsultantDashboardResponse["firstRun"];
  responseRate?: TConsultantDashboardResponse["responseRate"];
  /** From the RSC page, so server and client format one wall clock. */
  viewerZone: ViewerZone;
  performanceSnapshot?: TConsultantDashboardResponse["performanceSnapshot"];
  financialSummary?: TConsultantDashboardResponse["financialSummary"];
  latestReview?: TConsultantDashboardResponse["latestReview"];
  /** The expert's signed own-link URL, minted on the server; null for an inspector. */
  shareUrl: string | null;
  /** The Requests inbox read, shared by Needs you and the Requests panel. */
  requests: HomeRequestsQuery;
}

/**
 * Expert Home, action first: what is waiting, the session to prepare for, then
 * money. The sidebar holds the Requests list and a few plain numbers.
 */
export function HomeTab({
  appointments,
  consultantId,
  orgSessions = [],
  clientBookings = [],
  payoutSetup,
  needsYou,
  sessionsDelivered,
  firstRun,
  responseRate,
  viewerZone,
  performanceSnapshot,
  financialSummary,
  latestReview,
  shareUrl,
  requests,
}: Readonly<HomeTabProps>) {
  const joinMeeting = useLazyJoinMeeting();
  const now = useNowTick();
  const { data: session } = useSession();
  const unreadMessages = useChatUnreadCount();
  const basePath = `/dashboard/consultant/${consultantId}`;
  const memberships = useMemo(
    () => session?.user?.organizationMemberships ?? [],
    [session],
  );
  const memberOrgIds = useMemo(
    () => new Set(memberships.map((m) => m.organizationId)),
    [memberships],
  );
  const requestRows = requests.data?.rows;

  const sessions = useMemo(
    () => deriveHomeSessions(appointments, consultantId, now),
    [appointments, consultantId, now],
  );
  const needsItems = useMemo(
    () =>
      deriveHomeNeedsYou({
        requestRows,
        needsYou,
        payoutSetup,
        unreadMessages,
        basePath,
        viewerZone,
        now,
      }),
    [
      requestRows,
      needsYou,
      payoutSetup,
      unreadMessages,
      basePath,
      viewerZone,
      now,
    ],
  );
  const moneyLine = deriveMoneyLine({
    availablePaise: financialSummary?.availableEarnings ?? 0,
    payoutSetup,
    now,
  });
  const glanceRows = useMemo(
    () =>
      deriveGlanceRows({
        sessions,
        sessionsDelivered,
        responseRate,
        now,
      }),
    [sessions, sessionsDelivered, responseRate, now],
  );

  const agenda = useMemo(
    () => deriveAgenda(sessions, now, viewerZone.zone),
    [sessions, now, viewerZone.zone],
  );
  const next = sessions[0];
  const handleJoin = (target: HomeSession) =>
    void joinMeeting(target.appointment, target.occurrence);

  return (
    <DashboardContent>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-8">
          {firstRun && <SetupChecklist steps={firstRun.steps} />}
          <NeedsYou items={needsItems} />
          <NextSession
            sessions={sessions}
            consultantId={consultantId}
            viewerZone={viewerZone}
            now={now}
            sponsorName={
              next
                ? resolveSponsoringOrgName(
                    next.appointment.organizationId,
                    memberships,
                  )
                : null
            }
            showDevJoin={process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true"}
            onJoin={handleJoin}
          />
          <AgendaLists
            agenda={agenda}
            consultantId={consultantId}
            viewerZone={viewerZone}
          />
          <MoneyLine
            consultantId={consultantId}
            moneyLine={moneyLine}
            sessionsThisMonth={sessionsDelivered?.thisMonth ?? 0}
            ratingParts={deriveRatingParts(performanceSnapshot)}
          />
          <LatestFeedback
            review={latestReview}
            consultantId={consultantId}
            viewerZone={viewerZone}
          />
        </div>
        <aside aria-label="Requests and numbers" className="min-w-0 space-y-6">
          <RequestsPanel consultantId={consultantId} query={requests} />
          <GlancePanel rows={glanceRows} />
          <SharePanel shareUrl={shareUrl} />
          <OrgSessionsPanel
            sessions={orgSessions}
            memberOrgIds={memberOrgIds}
            viewerZone={viewerZone}
            now={now}
          />
          <ClientBookingsPanel
            bookings={clientBookings}
            viewerZone={viewerZone}
          />
        </aside>
      </div>
    </DashboardContent>
  );
}
