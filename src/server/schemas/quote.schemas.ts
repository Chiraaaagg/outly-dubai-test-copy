import "server-only";
import { z } from "zod";
import { dateKeySchema, uuidSchema } from "./inquiry.schemas";
import type { QuoteRequest } from "../quotes/contracts";

/**
 * Request schema for `POST /api/quotes` (`QuoteRequest`,
 * src/server/quotes/contracts.ts). Strict at every level; the caps keep one
 * request to a few supplier checks. Nothing here is trusted beyond shape: the
 * quote service recomputes every price, mode and rule from the database.
 */

/** Hard ceiling on lines per quote, before any policy (`MULTI_INSTANT_ITEM_POLICY`) applies. */
export const QUOTE_MAX_LINES = 10;
/** Body ceiling for the route; a full ten-line request is well under 8 KB. */
export const QUOTE_MAX_BYTES = 16 * 1024;

const idPart = z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, "Invalid id");

export const quoteLineSchema = z
  .object({
    productId: uuidSchema,
    variantId: idPart,
    serviceDate: dateKeySchema.refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "Use a real date"),
    slotRef: z.string().trim().min(1).max(120).nullable(),
    units: z
      .record(z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/, "Invalid unit"), z.number().int().min(0).max(100))
      .refine((u) => Object.keys(u).length <= 10, "Too many units"),
    addonIds: z.array(idPart).max(20),
    pickup: z.object({ hotelRef: z.string().trim().min(1).max(120) }).strict().nullable(),
    // Doc 30 N4 (review 102 N4-01): the band edges the picker showed; absent on carts from before N4.
    ages: z.object({ childMax: z.number().int().min(0).max(120), infantMax: z.number().int().min(0).max(120) }).strict().optional(),
  })
  .strict();

export const quoteRequestSchema = z
  .object({
    lines: z.array(quoteLineSchema).min(1, "Add at least one item").max(QUOTE_MAX_LINES, `At most ${QUOTE_MAX_LINES} items`),
    currency: z.enum(["INR", "AED"]),
    couponCode: z.string().trim().min(1).max(40).nullable(),
  })
  .strict() satisfies z.ZodType<QuoteRequest>;
