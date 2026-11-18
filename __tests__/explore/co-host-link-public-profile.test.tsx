/**
 * A public plan page lists every accepted collaborator under "Team", each
 * with their role, and links the name to the expert page only when that page
 * exists for the public: a verified profile.
 */
import { render, screen } from "@testing-library/react";

import {
  CoHostList,
  hasPublicExpertPage,
} from "@/app/explore/programs/plans/components/CoHostList";

const coHost = (
  id: string,
  name: string,
  verificationStatus: string,
  role = "CO_HOST",
) => ({
  id: `collab-${id}`,
  role,
  consultantProfile: {
    id,
    verificationStatus,
    user: { id: `user-${id}`, name, image: null },
  },
});

describe("co-hosts on a public plan page", () => {
  it("links a verified co-host and shows an unverified one by name alone", () => {
    render(
      <CoHostList
        collaborators={[
          coHost("cp-public", "Priya Sharma", "VERIFIED"),
          coHost("cp-hidden", "Rohan Mehta", "PENDING"),
        ]}
      />,
    );
    expect(
      screen.getByRole("link", { name: /Priya Sharma/ }).getAttribute("href"),
    ).toBe("/explore/experts/cp-public");
    expect(screen.getByText("Rohan Mehta")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Rohan Mehta/ })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("titles the list for everyone it holds, a support role included", () => {
    render(
      <CoHostList
        collaborators={[
          coHost("cp-host", "Priya Sharma", "VERIFIED"),
          coHost("cp-support", "Ethan Lee", "VERIFIED", "TECHNICAL_SUPPORT"),
        ]}
      />,
    );
    expect(screen.getByText("Team")).toBeTruthy();
    // "Co-host" is one person's role here, never the name of the list.
    expect(screen.getAllByText(/co-host/i).map((el) => el.textContent)).toEqual(
      ["Co-host"],
    );
    expect(screen.getByText("Technical support")).toBeTruthy();
  });

  it("renders nothing for a plan with no co-host", () => {
    const { container } = render(<CoHostList collaborators={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the host's profile link on a public plan page", () => {
  it("is offered only for a verified host", () => {
    expect(hasPublicExpertPage({ verificationStatus: "VERIFIED" })).toBe(true);
    expect(hasPublicExpertPage({ verificationStatus: "UNDER_REVIEW" })).toBe(
      false,
    );
    expect(hasPublicExpertPage({})).toBe(false);
    expect(hasPublicExpertPage(null)).toBe(false);
  });
});
