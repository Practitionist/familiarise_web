/**
 * Operator view of a learner's dashboard: the page greets and computes Needs
 * you for the viewed learner, the header names the operator by their own role,
 * and the owner-only "Your …" settings copy stays with the owner.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Prisma, User } from "@prisma/client";

import type { publicProfileUserSelect } from "../../lib/data/consultant-public";
import type { TConsulteeProfile } from "../../types/consultee";

const mockHomeTab = jest.fn((_props: Record<string, unknown>) => null);
jest.mock(
  "../../app/dashboard/consultee/[consulteeId]/(features)/home/HomeTab",
  () => ({
    __esModule: true,
    default: (props: Record<string, unknown>) => mockHomeTab(props),
  }),
);
let mockPathname = "/dashboard/consultee/cp_learner/settings/profile";
jest.mock("next/navigation", () => ({
  useParams: () => ({ consulteeId: "cp_learner" }),
  usePathname: () => mockPathname,
}));

import HomePageClient from "../../app/dashboard/consultee/[consulteeId]/(features)/home/HomePageClient";
import ConsulteeSettingsLayout from "../../app/dashboard/consultee/[consulteeId]/(features)/settings/layout";
import { UserProvider } from "../../app/dashboard/consultee/[consulteeId]/UserContext";
import { createConsulteeQueries } from "../../lib/dashboard-queries";
import {
  personalHomeTitle,
  personalShellPeople,
  viewedPerson,
} from "../../lib/dashboard/operator-view";

/** What `/api/user/consultees/[id]` answers STAFF: the public-field select. */
type StaffProfileRead = Prisma.ConsulteeProfileGetPayload<{
  select: {
    id: true;
    userId: true;
    user: { select: typeof publicProfileUserSelect };
  };
}>;

const staffRead: StaffProfileRead = {
  id: "cp_learner",
  userId: "u_learner",
  user: {
    id: "u_learner",
    name: "Patrick Anderson",
    image: "https://img/patrick.png",
    profileDisplayImage: null,
    bio: null,
    city: null,
    country: null,
    linkedinUrl: null,
    timezone: "Asia/Kolkata",
    workExperiences: [],
    education: [],
    certifications: [],
  },
};

const operator = {
  id: "u_operator",
  name: "Maria Brown",
  image: null,
  role: "STAFF",
  consulteeProfileId: "cp_operator",
  consultantProfileId: null,
} as unknown as User;
const learnerUser = {
  ...operator,
  id: "u_learner",
  name: "Patrick Anderson",
  role: "CONSULTEE",
  consulteeProfileId: "cp_learner",
} as unknown as User;
const learner = viewedPerson(staffRead);

describe("viewed learner", () => {
  it("reads the learner from the staff select and the owner/admin include alike", () => {
    expect(learner).toEqual({
      userId: "u_learner",
      name: "Patrick Anderson",
      image: "https://img/patrick.png",
    });
    const fullRead: Pick<TConsulteeProfile, "userId"> & {
      user: Pick<TConsulteeProfile["user"], "name" | "image">;
    } = {
      userId: "u_learner",
      user: { name: "Patrick Anderson", image: null },
    };
    expect(viewedPerson(fullRead)?.userId).toBe("u_learner");
    expect(viewedPerson(null)).toBeNull();
  });

  it("welcomes the owner back and names the learner for an operator", () => {
    expect(personalHomeTitle(learner, true)).toBe("Welcome back, Patrick");
    expect(personalHomeTitle(learner, false)).toBe("Patrick Anderson's home");
    expect(personalHomeTitle(null, false)).toBeNull();
  });

  it("keeps the operator in the avatar menu as Staff and the learner in the context bar", () => {
    const people = personalShellPeople({
      viewer: { name: "Maria Brown", image: null, role: "STAFF" },
      owner: { name: "Patrick Anderson", image: "https://img/patrick.png" },
      operatorView: true,
      sideLabel: "Learner",
    });
    expect(people.account).toEqual({
      name: "Maria Brown",
      image: null,
      roleLabel: "Staff",
    });
    expect(people.identity.name).toBe("Patrick Anderson");
    const own = personalShellPeople({
      viewer: { name: "Patrick Anderson", image: null, role: "CONSULTEE" },
      owner: { name: "Patrick Anderson", image: null },
      operatorView: false,
      sideLabel: "Learner",
    });
    expect(own.account.roleLabel).toBe("Learner");
  });
});

describe("HomePageClient in operator view", () => {
  it("hands Home the viewed learner, not the signed-in operator", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    qc.setQueryData(createConsulteeQueries("cp_learner").eventsHome.queryKey, {
      consultations: [],
      subscriptions: [],
    });
    render(
      <QueryClientProvider client={qc}>
        <UserProvider userDetails={operator} learner={learner}>
          <HomePageClient
            consulteeId="cp_learner"
            viewerZone={{ zone: "Asia/Kolkata", own: true }}
          />
        </UserProvider>
      </QueryClientProvider>,
    );
    expect(mockHomeTab).toHaveBeenCalled();
    const props = mockHomeTab.mock.calls.at(-1)?.[0];
    expect(props?.learner).toEqual(learner);
    expect(props?.viewerOwnsProfile).toBe(false);
    expect(props).not.toHaveProperty("userDetails");
  });
});

describe("Learner settings for a non-owner", () => {
  function renderSettings(user: User) {
    render(
      <UserProvider userDetails={user} learner={learner}>
        <ConsulteeSettingsLayout>
          <p>form</p>
        </ConsulteeSettingsLayout>
      </UserProvider>,
    );
  }

  it("drops the owner's 'Your …' subtitle for an operator", () => {
    renderSettings(operator);
    expect(
      screen.getByRole("heading", { name: "Learning profile" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Your /)).toBeNull();
  });

  it("keeps it for the learner", () => {
    renderSettings(learnerUser);
    expect(
      screen.getByText("Your goals, background and what you want to learn"),
    ).toBeInTheDocument();
  });

  it("lists no 'Your …' section descriptions on the hub for an operator", () => {
    mockPathname = "/dashboard/consultee/cp_learner/settings";
    renderSettings(operator);
    expect(screen.getByText("Learning profile")).toBeInTheDocument();
    expect(screen.queryByText(/^Your /)).toBeNull();
    mockPathname = "/dashboard/consultee/cp_learner/settings/profile";
  });
});
