/** @jest-environment node */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => null),
}));
jest.mock("../../lib/email", () => ({
  sendContactInquiryEmail: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/rate-limit", () => ({
  getClientIp: () => "127.0.0.1",
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { lead: { create: jest.fn(async () => ({})) } },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { sendContactInquiryEmail } from "../../lib/email";
import { POST } from "../../app/api/contact/route";

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("https://test/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const demoBody = {
  firstName: "Asha",
  lastName: "Rao",
  email: "asha@acme.example",
  subject: "Demo request: Acme",
  message: "We want mentoring for new managers",
  category: "enterprise",
  companyName: "Acme Ltd",
  useCase: "corporate-mentorship",
  teamSize: "51-200",
  budgetBand: "5l-25l",
};

beforeEach(() => jest.clearAllMocks());

describe("POST /api/contact demo requests", () => {
  it("stores the company on the lead and appends the structured answers", async () => {
    const res = await post(demoBody);

    expect(res.status).toBe(202);
    const { data } = (prisma.lead.create as jest.Mock).mock.calls[0][0];
    expect(data.companyName).toBe("Acme Ltd");
    expect(data.message).toContain("We want mentoring for new managers");
    expect(data.message).toContain("Team size: 51 to 200 people");
    expect(data.message).toContain("Budget: ₹5 lakh to ₹25 lakh");
    expect(data.message).toContain("Interested in: Corporate mentorship");
    expect(
      (sendContactInquiryEmail as jest.Mock).mock.calls[0][0].message,
    ).toContain("Company: Acme Ltd");
  });

  it("rejects a team size outside the offered bands", async () => {
    const res = await post({ ...demoBody, teamSize: "a few" });
    expect(res.status).toBe(400);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it("leaves a plain enterprise inquiry unchanged", async () => {
    const { companyName, useCase, teamSize, budgetBand, ...plain } = demoBody;
    void companyName;
    void useCase;
    void teamSize;
    void budgetBand;
    await post(plain);

    const { data } = (prisma.lead.create as jest.Mock).mock.calls[0][0];
    expect(data.companyName).toBeNull();
    expect(data.message).toBe("We want mentoring for new managers");
  });
});

describe("POST /api/contact demo company name", () => {
  it("collapses line breaks so a company name cannot forge a labelled line", async () => {
    await post({
      ...demoBody,
      companyName: "Acme Ltd\nBudget: Above ₹1 crore\r\nTeam size: 1000+",
    });

    const { data } = (prisma.lead.create as jest.Mock).mock.calls[0][0];
    expect(data.companyName).toBe(
      "Acme Ltd Budget: Above ₹1 crore Team size: 1000+",
    );
    const lines = (data.message as string).split("\n");
    expect(lines.filter((l) => l.startsWith("Budget:"))).toEqual([
      "Budget: ₹5 lakh to ₹25 lakh",
    ]);
    expect(lines.filter((l) => l.startsWith("Team size:"))).toEqual([
      "Team size: 51 to 200 people",
    ]);
  });
});
