import { z } from "zod";
import {
  SupportTicketStatusEnum,
  SupportPriorityEnum,
  SupportIssueTypeEnum,
} from "./enums";

export const CreateSupportTicketSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  priority: SupportPriorityEnum.optional(),
  category: z.string().optional(),
  issueType: SupportIssueTypeEnum.optional(),
  consultationId: z.string().optional(),
  subscriptionId: z.string().optional(),
  paymentId: z.string().optional(),
  appointmentId: z.string().optional(),
});

export const UpdateSupportTicketSchema = z.object({
  status: SupportTicketStatusEnum.optional(),
  priority: SupportPriorityEnum.optional(),
  assignedToId: z.string().nullable().optional(),
  refundId: z.string().optional(),
});

export const CreateSupportResponseSchema = z.object({
  message: z.string().trim().min(1, "Message is required"),
  isInternal: z.boolean().default(false),
});

export type CreateSupportTicketInput = z.infer<
  typeof CreateSupportTicketSchema
>;
export type UpdateSupportTicketInput = z.infer<
  typeof UpdateSupportTicketSchema
>;
export type CreateSupportResponseInput = z.infer<
  typeof CreateSupportResponseSchema
>;
