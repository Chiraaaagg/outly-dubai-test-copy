import "server-only";
import type { Tx } from "../lib/db";
import { EDITORIAL_FIELDS, isLockKey, personLocksBetween } from "../suppliers/traveldesk/traveldesk.listing-build";

/**
 * Editorial locks of imported TravelDesk listings (doc 30 §3.7; review 106
 * N1-08). A field is locked once a person has changed it from the document
 * the import (or the last system write) produced, and stays locked: the
 * daily upkeep (N3) never overwrites a locked field.
 *
 *  - Every person's save of a linked product (editor, CSV round trip) calls
 *    `recordEditorialLocks` in its transaction.
 *  - An adopted listing (hand-written page, §3.9) has every editorial field
 *    locked from the start.
 *  - A system writer (the photo copy, the N3 sync) passes the fields it wrote
 *    as `systemFields`, which are never locked by that write, and `rebase`,
 *    which moves the baseline (`import_version`) to the version it wrote.
 *
 * Facts (times, ages, pickup, policy, units, prices) are never locked here,
 * with three person choices as exceptions (doc 30 N3, review 108 N3-01,
 * N3-03, N3-14): an option's name (`variant:<id>:name`), an option's price a
 * person raised (`variant:<id>:price`, locked upward only) and the "Quote
 * only" switch (`quoteOnly`). Locks are sticky: a later rebase keeps them.
 */
export async function recordEditorialLocks(tx: Tx, productId: string, opts: { systemFields?: readonly string[]; rebase?: boolean } = {}): Promise<string[] | null> {
  const link = await tx.supplierListingLink.findUnique({ where: { productId }, select: { id: true, adopted: true, importVersion: true, lockedFields: true, deactivatedAt: true } });
  if (!link || link.deactivatedAt) return null;
  const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { content: true, version: true } });
  let locked: string[];
  const stored = link.lockedFields.filter(isLockKey);
  if (link.adopted) locked = [...new Set([...EDITORIAL_FIELDS, ...stored])];
  else {
    const base = await tx.productVersion.findUnique({ where: { productId_version: { productId, version: link.importVersion } }, select: { content: true } });
    const changed = base ? personLocksBetween(base.content as Record<string, unknown>, product.content as Record<string, unknown>) : [];
    const system = new Set(opts.systemFields ?? []);
    const extra = [...new Set([...stored, ...changed.filter((f) => !system.has(f))])].filter((f) => !(EDITORIAL_FIELDS as readonly string[]).includes(f)).sort();
    locked = [...EDITORIAL_FIELDS.filter((f) => stored.includes(f) || (changed.includes(f) && !system.has(f))), ...extra].slice(0, 60);
  }
  const same = locked.length === link.lockedFields.length && locked.every((f) => link.lockedFields.includes(f));
  if (!same || opts.rebase) {
    await tx.supplierListingLink.update({ where: { id: link.id }, data: { lockedFields: locked, ...(opts.rebase ? { importVersion: product.version } : {}) } });
  }
  return locked;
}
