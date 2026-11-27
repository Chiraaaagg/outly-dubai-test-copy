import { z } from "zod";
import { PAGE_PAX_AGES, variantPaxAges, type PaxAgeBands } from "@/lib/pax-ages";
import { unitDefinitionSchema } from "../schemas/activity.schema";

/**
 * The age bands a stored variant sells (doc 30 N4, `variantPaxAges`), read
 * from raw product content for the supplier age check
 * (`supplierCatalogService.mappingReadinessFor`): its typed units when they
 * parse, else the page's own bands. Readiness parses the whole document and
 * refuses it when invalid, so a lenient read here never makes a product
 * instant. Pure; readiness passes the content it judged, so both halves read
 * one snapshot (review 102 N4-03).
 */
export function variantPaxAgesOf(content: unknown, variantCode: string | null): PaxAgeBands {
  if (variantCode === null) return PAGE_PAX_AGES;
  const raw = (content as { variants?: unknown } | null)?.variants;
  const variant = Array.isArray(raw) ? raw.find((v) => (v as { id?: unknown } | null)?.id === variantCode) : undefined;
  const units = z.array(unitDefinitionSchema).safeParse((variant as { units?: unknown } | undefined)?.units ?? []);
  return (units.success ? variantPaxAges({ units: units.data }) : null) ?? PAGE_PAX_AGES;
}
