/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
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

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  documentUploadLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(async () => ({ role: "CONSULTEE" })) },
    supportTicket: {
      findUnique: jest.fn(async () => ({ userId: "owner", status: "OPEN" })),
    },
    supportTicketAttachment: {
      findUnique: jest.fn(async () => ({
        id: "att-1",
        ticketId: "t1",
        storagePath: "support-tickets/t1/file.png",
        ticket: { userId: "owner" },
      })),
      delete: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
  },
}));

import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import {
  uploadSupportTicketAttachment,
  deleteSupportTicketAttachment,
  signSupportTicketAttachment,
} from "../../lib/supabase";
import { getSession } from "../../lib/auth-server";
import { applyRateLimit } from "../../lib/rate-limit";
import {
  DELETE,
  POST,
} from "../../app/api/support-tickets/[ticketId]/attachments/route";
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

  it("throttles a customer per ticket and never throttles staff", async () => {
    mockedDelete.mockResolvedValue(true);
    await DELETE(deleteRequest(), {
      params: Promise.resolve({ ticketId: "t1" }),
    });
    expect(applyRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "ticket-attachment-delete:owner:t1",
    );

    (applyRateLimit as jest.Mock).mockClear();
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      role: "STAFF",
    });
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ ticketId: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(applyRateLimit).not.toHaveBeenCalled();
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

  it("answers an upload failure with generic copy and reports the vendor message once", async () => {
    (uploadSupportTicketAttachment as jest.Mock).mockResolvedValue({
      success: false,
      error: "bucket 'support-attachments' not found",
    });
    const form = new FormData();
    form.set("file", new File(["x"], "a.png", { type: "image/png" }));
    const res = await POST(
      new NextRequest("http://localhost/api/support-tickets/t1/attachments", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ ticketId: "t1" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toMatch(/bucket|storage/i);
    expect(json).not.toHaveProperty("message");
    expect(json).not.toHaveProperty("instructions");
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
