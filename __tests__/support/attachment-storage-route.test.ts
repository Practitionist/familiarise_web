/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({ user: { id: "owner" } })),
}));

jest.mock("../../lib/supabase", () => ({
  __esModule: true,
  uploadSupportTicketAttachment: jest.fn(),
  deleteSupportTicketAttachment: jest.fn(),
  signSupportTicketAttachment: jest.fn(),
  getManualBucketInstructions: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(async () => ({ role: "CONSULTEE" })) },
    supportTicketAttachment: {
      findUnique: jest.fn(async () => ({
        id: "att-1",
        ticketId: "t1",
        storagePath: "support-tickets/t1/file.png",
        ticket: { userId: "owner" },
      })),
      delete: jest.fn(async () => ({})),
    },
  },
}));

import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import {
  deleteSupportTicketAttachment,
  signSupportTicketAttachment,
} from "../../lib/supabase";
import { getSession } from "../../lib/auth-server";
import { DELETE } from "../../app/api/support-tickets/[ticketId]/attachments/route";
import { GET } from "../../app/api/support-tickets/[ticketId]/attachments/[attachmentId]/route";

const mockedDelete = deleteSupportTicketAttachment as jest.Mock;
const mockedSign = signSupportTicketAttachment as jest.Mock;
const rowDelete = prisma.supportTicketAttachment.delete as jest.Mock;

const deleteRequest = () =>
  new NextRequest("http://localhost/api/support-tickets/t1/attachments", {
    method: "DELETE",
    body: JSON.stringify({ attachmentId: "att-1" }),
  });

beforeEach(() => jest.clearAllMocks());

describe("support attachment storage", () => {
  it("answers 502 and keeps the row when storage does not confirm the delete", async () => {
    mockedDelete.mockResolvedValue(false);
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ ticketId: "t1" }),
    });
    expect(res.status).toBe(502);
    expect(rowDelete).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("deletes the row once storage confirms the delete", async () => {
    mockedDelete.mockResolvedValue(true);
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ ticketId: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(rowDelete).toHaveBeenCalledWith({ where: { id: "att-1" } });
  });

  it("redirects the owner to a signed URL minted from the stored path", async () => {
    mockedSign.mockResolvedValue("https://storage.test/signed?token=x");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/support-tickets/t1/attachments/att-1",
      ),
      { params: Promise.resolve({ ticketId: "t1", attachmentId: "att-1" }) },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://storage.test/signed?token=x",
    );
    expect(mockedSign).toHaveBeenCalledWith("support-tickets/t1/file.png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a caller who neither owns the ticket nor is staff", async () => {
    (getSession as jest.Mock).mockResolvedValueOnce({ user: { id: "other" } });
    const res = await GET(
      new NextRequest(
        "http://localhost/api/support-tickets/t1/attachments/att-1",
      ),
      { params: Promise.resolve({ ticketId: "t1", attachmentId: "att-1" }) },
    );
    expect(res.status).toBe(403);
    expect(mockedSign).not.toHaveBeenCalled();
  });
});
