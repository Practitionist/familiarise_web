/**
 * A public plan page names every accepted co-host, and links the name to the
 * expert page only when that page exists for the public: a verified profile.
 */
import { render, screen } from "@testing-library/react";

import { CoHostList } from "@/app/explore/programs/plans/components/CoHostList";

const coHost = (id: string, name: string, verificationStatus: string) => ({
  id: `collab-${id}`,
  role: "CO_HOST",
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
        title="Co-Hosts"
        unnamed="Co-host"
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

  it("renders nothing for a plan with no co-host", () => {
    const { container } = render(
      <CoHostList title="Co-Hosts" unnamed="Co-host" collaborators={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
