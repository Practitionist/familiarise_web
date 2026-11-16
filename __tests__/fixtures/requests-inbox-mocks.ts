/**
 * Module stand-ins for the Requests inbox render tests, each used as a
 * `jest.mock` factory through `jest.requireActual`. Nothing here imports app code.
 */

/** `lib/prisma`: the models the inbox read touches, for `serveInboxFixture`. */
export function inboxPrismaModule(): object {
  return {
    __esModule: true,
    default: {
      consultation: { findMany: jest.fn(), count: jest.fn() },
      subscription: { findMany: jest.fn(), count: jest.fn() },
      trial: { findMany: jest.fn(), count: jest.fn() },
      membership: { findMany: jest.fn() },
    },
  };
}

/** `next/navigation` on the consultant's Requests page, consultation tab. */
export function inboxNavigationModule(): object {
  return {
    usePathname: () => "/dashboard/consultant/cp-1/requests",
    useSearchParams: () => new URLSearchParams("type=consultation"),
    useRouter: () => ({
      push: jest.fn(),
      replace: jest.fn(),
      refresh: jest.fn(),
    }),
  };
}

/** `lib/payments/payouts/clawback-notifications`: its email stack cannot load in jsdom. */
export function clawbackNoticesModule(): object {
  return { stageClawbackNotice: jest.fn(), stageRaisedClawback: jest.fn() };
}

/** `lib/auth-client`: signed out, settled. */
export function signedOutAuthModule(): object {
  return {
    authClient: {},
    useSession: () => ({ data: null, isPending: false }),
  };
}

/** `lib/time/use-viewer-zone`: a viewer in Kolkata. */
export function kolkataViewerZoneModule(): object {
  return { useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }) };
}

/** `components/ui/use-toast`: a toast spy. */
export function toastModule(): object {
  return {
    toast: jest.fn(),
    useToast: () => ({ toast: jest.fn(), toasts: [] }),
  };
}
