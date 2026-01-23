"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { markChannelExists } from "@/lib/stream-cache";
import { upsertUsersToStream } from "./user.action";
import { SupportPriority } from "@prisma/client";

// Input validation schemas
const customerIdSchema = z.string().min(1, "Customer ID is required");
const channelIdSchema = z.string().min(1, "Channel ID is required");
const staffIdSchema = z.string().min(1, "Staff ID is required");

const createSupportChannelSchema = z.object({
  customerId: customerIdSchema,
  topic: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
});

/**
 * Create a support chat channel for customer-staff communication
 * Channel ID format: support-{customerId}-{timestamp}
 */
export async function createSupportChannel(input: {
  customerId: string;
  topic?: string;
  priority?: SupportPriority;
}) {
  const validated = createSupportChannelSchema.parse(input);

  const client = getStreamChatClient();

  // Generate unique channel ID
  const channelId = `support-${validated.customerId}-${Date.now()}`;

  // Get customer info
  const customer = await prisma.user.findUnique({
    where: { id: validated.customerId },
    select: { id: true, name: true, email: true, image: true },
  });

  if (!customer) {
    throw new Error(`Customer not found: ${validated.customerId}`);
  }

  // Ensure customer exists in Stream
  await upsertUsersToStream([validated.customerId]);

  streamLogger.debug("Creating support channel", {
    channelId,
    customerId: validated.customerId,
    topic: validated.topic,
  });

  // Create the Stream channel
  const channel = client.channel("messaging", channelId, {
    name: validated.topic || `Support - ${customer.name || customer.email}`,
    created_by_id: validated.customerId,
    members: [validated.customerId],
    // Custom support channel metadata
    support_channel_id: "", // Will be set after DB record creation
    customer_id: validated.customerId,
    support_status: "OPEN",
    support_priority: validated.priority || "MEDIUM",
    custom: true,
  } as Record<string, unknown>);

  await channel.create();

  // Create DB record
  const supportChannel = await prisma.staffSupportChannel.create({
    data: {
      streamChannelId: channelId,
      customerId: validated.customerId,
      topic: validated.topic,
      priority: validated.priority || "MEDIUM",
      status: "OPEN",
    },
  });

  // Update Stream channel with DB ID
  await channel.updatePartial({
    set: { support_channel_id: supportChannel.id },
  });

  markChannelExists("messaging", channelId);

  streamLogger.info("Support channel created", {
    channelId,
    supportChannelId: supportChannel.id,
  });

  return {
    channelId,
    supportChannelId: supportChannel.id,
    streamChannelId: channelId,
  };
}

/**
 * Assign a staff member to a support channel
 */
export async function assignStaffToChannel(
  channelId: string,
  staffId: string
) {
  channelIdSchema.parse(channelId);
  staffIdSchema.parse(staffId);

  // Get the support channel
  const supportChannel = await prisma.staffSupportChannel.findUnique({
    where: { id: channelId },
    select: { streamChannelId: true, customerId: true },
  });

  if (!supportChannel) {
    throw new Error(`Support channel not found: ${channelId}`);
  }

  // Ensure staff exists in Stream
  await upsertUsersToStream([staffId]);

  const client = getStreamChatClient();
  const channel = client.channel("messaging", supportChannel.streamChannelId);

  streamLogger.debug("Assigning staff to support channel", {
    channelId,
    staffId,
  });

  // Add staff to Stream channel
  await channel.addMembers([staffId]);

  // Update channel metadata
  await channel.updatePartial({
    set: {
      assigned_staff_id: staffId,
      support_status: "ASSIGNED",
    },
  });

  // Update DB record
  const updated = await prisma.staffSupportChannel.update({
    where: { id: channelId },
    data: {
      assignedStaffId: staffId,
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });

  streamLogger.info("Staff assigned to support channel", {
    channelId,
    staffId,
  });

  return {
    success: true,
    channel: updated,
  };
}

/**
 * Escalate a support channel to a formal support ticket
 */
export async function escalateToTicket(
  channelId: string,
  ticketData: {
    title: string;
    description?: string;
    priority?: SupportPriority;
    category?: string;
    issueType?: string;
  }
) {
  channelIdSchema.parse(channelId);

  const supportChannel = await prisma.staffSupportChannel.findUnique({
    where: { id: channelId },
    include: {
      customer: { select: { id: true, name: true } },
    },
  });

  if (!supportChannel) {
    throw new Error(`Support channel not found: ${channelId}`);
  }

  if (supportChannel.linkedTicketId) {
    throw new Error("Channel already has a linked ticket");
  }

  streamLogger.debug("Escalating support channel to ticket", {
    channelId,
    title: ticketData.title,
  });

  // Create ticket and link to channel
  const ticket = await prisma.supportTicket.create({
    data: {
      title:
        ticketData.title ||
        `Support request from ${supportChannel.customer.name || "customer"}`,
      description:
        ticketData.description ||
        supportChannel.topic ||
        "Escalated from support chat",
      priority: ticketData.priority || supportChannel.priority,
      category: ticketData.category,
      userId: supportChannel.customerId,
      assignedToId: supportChannel.assignedStaffId,
    },
  });

  // Update channel with ticket link
  await prisma.staffSupportChannel.update({
    where: { id: channelId },
    data: { linkedTicketId: ticket.id },
  });

  // Update Stream channel metadata
  const client = getStreamChatClient();
  const channel = client.channel("messaging", supportChannel.streamChannelId);
  await channel.updatePartial({
    set: { linked_ticket_id: ticket.id },
  });

  streamLogger.info("Support channel escalated to ticket", {
    channelId,
    ticketId: ticket.id,
  });

  return {
    success: true,
    ticket,
  };
}

/**
 * Close a support channel
 */
export async function closeSupportChannel(channelId: string) {
  channelIdSchema.parse(channelId);

  const supportChannel = await prisma.staffSupportChannel.findUnique({
    where: { id: channelId },
    select: { streamChannelId: true },
  });

  if (!supportChannel) {
    throw new Error(`Support channel not found: ${channelId}`);
  }

  streamLogger.debug("Closing support channel", { channelId });

  // Update DB record
  const updated = await prisma.staffSupportChannel.update({
    where: { id: channelId },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
    },
  });

  // Update Stream channel metadata
  const client = getStreamChatClient();
  const channel = client.channel("messaging", supportChannel.streamChannelId);
  await channel.updatePartial({
    set: { support_status: "CLOSED" },
  });

  // Optionally archive/hide the channel
  // await channel.hide();

  streamLogger.info("Support channel closed", { channelId });

  return {
    success: true,
    channel: updated,
  };
}

/**
 * Resolve a support channel (but keep it accessible)
 */
export async function resolveSupportChannel(channelId: string) {
  channelIdSchema.parse(channelId);

  const supportChannel = await prisma.staffSupportChannel.findUnique({
    where: { id: channelId },
    select: { streamChannelId: true },
  });

  if (!supportChannel) {
    throw new Error(`Support channel not found: ${channelId}`);
  }

  streamLogger.debug("Resolving support channel", { channelId });

  // Update DB record
  const updated = await prisma.staffSupportChannel.update({
    where: { id: channelId },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });

  // Update Stream channel metadata
  const client = getStreamChatClient();
  const channel = client.channel("messaging", supportChannel.streamChannelId);
  await channel.updatePartial({
    set: { support_status: "RESOLVED" },
  });

  streamLogger.info("Support channel resolved", { channelId });

  return {
    success: true,
    channel: updated,
  };
}

/**
 * Get Stream token for a user to connect to support channels
 */
export async function getSupportChannelToken(userId: string) {
  customerIdSchema.parse(userId);

  // Ensure user exists in Stream
  await upsertUsersToStream([userId]);

  const client = getStreamChatClient();
  const token = client.createToken(userId);

  return { token };
}
