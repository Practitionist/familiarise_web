import { z } from "zod";

export const RegisterSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128, "Password must not exceed 128 characters"),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
