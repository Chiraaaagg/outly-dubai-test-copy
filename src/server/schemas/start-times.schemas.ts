import "server-only";
import { z } from "zod";
import { dateKeySchema, uuidSchema } from "./inquiry.schemas";

/**
 * Query of `GET /api/catalog/start-times` (doc 29 Batch 2). Strict: the
 * product and variant ids the activity page already holds, and a Dubai
 * calendar date at most `START_TIMES_MAX_DAYS_AHEAD` days ahead. Nothing
 * else is accepted, so the URL can never carry personal data.
 */

export const START_TIMES_MAX_DAYS_AHEAD = 366;

export const startTimesQuerySchema = z
  .object({
    productId: uuidSchema,
    variantId: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, "Invalid id"),
    date: dateKeySchema.refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "Use a real date"),
  })
  .strict();

export type StartTimesQuery = z.infer<typeof startTimesQuerySchema>;
