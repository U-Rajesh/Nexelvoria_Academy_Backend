import { z } from "zod";

const entityIdSchema = z.string().trim().min(1, "Id is required").max(128);

export const createEnrollmentBodySchema = z.object({
  courseId: entityIdSchema,
  batchId: entityIdSchema.optional(),
});

export type CreateEnrollmentBody = z.infer<typeof createEnrollmentBodySchema>;
