import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { tombstoneSlug } from "../../suppliers/traveldesk/clean-address";

/**
 * Doc 30 §3.9 follow-up against the LOCAL disposable test database: retire the
 * old page of an already published imported listing (live page: soft delete
 * and redirect; already archived page: redirect only), move a "<base>-<n>"
 * listing to "<base>" and back, and the restore path undoing a move first.
 * The publish path's rules stop or keep the retire (references, instant).
 *
 * Synthetic listings under `zz-test-<run>-` slugs and a run-scoped supplier;
 * the listing links are written directly (reviewed, indexable), standing in
 * for the importer. Removed in afterAll (audit rows are append-only and stay).
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const P = `zz-test-${RUN}`;
const CODE = `zz-tdaddr-${RUN}`;
let nextTour = 940_000_000 + Math.floor(Math.random() * 50_000_000);

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };
const editor: Actor = { type: "admin", id: uuidv7(), roles: ["editor"], permissions: new Set(["products.edit", "products.publish"]) };
const code = (e: unknown) => (isAppError(e) ? e.code : String(e));
const msg = (re: RegExp) => (e: unknown) => isAppError(e) && re.test(e.message);

describe.skipIf(!enabled)("TravelDesk listing address clean-up (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let listings: typeof import("../traveldesk-listing.service").traveldeskListingService;
  let activities: typeof import("../activity.service").activityService;
  let importService: typeof import("../import.service").importService;
  let lookupRetiredSlug: typeof import("@/lib/catalog/redirects").lookupRetiredSlug;
  let supplierId = "";
  let category = "";

  async function makeProduct(slug: string, title: string, relatedSlugs: string[] = []) {
    const created = await activities.create(admin, {
      slug,
      title,
      subtitle: `${title}, a synthetic page.`,
      tier: "B",
      categorySlug: category,
      secondaryCategorySlugs: [],
      collectionSlugs: [],
      images: [`img:activity:${slug}:0`],
      imageAlt: title,
      durationMinutes: 120,
      isPrivate: false,
      pickupIncluded: false,
      pickupZones: [],
      confirmation: "manual",
      fulfilmentMode: "inquiry",
      freeCancellationHours: 24,
      mobileVoucher: true,
      dietary: [],
      suitability: [],
      location: "Dubai",
      meetingPoint: "At the venue",
      timeSlots: [],
      price: { adult: { aed: 150, inr: 3600 } },
      inclusions: ["Entry"],
      exclusions: [],
      itinerary: [],
      importantInfo: [],
      cancellationPolicy: "Free cancellation up to 24 hours before the start.",
      variants: [],
      addOns: [],
      faqs: [],
      relatedSlugs,
      comboSlugs: [],
      supplier: { id: "outlyy-direct", name: "OUTLYY direct", source: "direct", reliability: 90, verifiedSince: "2026" },
      badges: {},
      seo: { title, description: `${title}, a synthetic page.`, keywords: [] },
    });
    await activities.setStatus(admin, created.id, "published");
    return created.id;
  }

  /** A published imported listing: the product is published first, then its reviewed link is written (as publish leaves it). */
  async function makeListing(slug: string, title: string) {
    const productId = await makeProduct(slug, title);
    const linkId = uuidv7();
    const tour = String(nextTour++);
    await prisma.supplierListingLink.create({
      data: { id: linkId, productId, supplierId, environment: "test", tourExternalId: tour, offerExternalIds: [tour], kind: "inquiry", arrival: "self", route: "internal", fulfilment: "on_request", pricingRuleVersion: 1, noindex: false, reviewedAt: new Date(), reviewedBy: admin.id },
    });
    return { productId, linkId };
  }

  /** The editor input of a product as it is now (what the console form would send back). */
  async function inputOf(id: string) {
    const current = await activities.get(admin, id);
    const { id: _i, rating: _r, reviewCount: _c, bookedThisMonth: _b, ...input } = current.content;
    return { input, version: current.version };
  }

  const product = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  const redirectsOf = (ids: string[]) => prisma.productRedirect.findMany({ where: { OR: [{ oldProductId: { in: ids } }, { targetProductId: { in: ids } }] }, orderBy: { oldSlug: "asc" }, select: { oldSlug: true, oldProductId: true, targetProductId: true, linkId: true } });

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ traveldeskListingService: listings } = await import("../traveldesk-listing.service"));
    ({ activityService: activities } = await import("../activity.service"));
    ({ importService } = await import("../import.service"));
    ({ lookupRetiredSlug } = await import("@/lib/catalog/redirects"));
    category = (await prisma.category.findFirstOrThrow({ where: { deletedAt: null }, select: { slug: true } })).slug;
    supplierId = (await prisma.supplier.create({ data: { id: uuidv7(), code: CODE, name: "TravelDesk", source: "api", adapter: "traveldesk" } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = (await prisma.product.findMany({ where: { slug: { startsWith: P } }, select: { id: true } })).map((p) => p.id);
    await prisma.productRedirect.deleteMany({ where: { OR: [{ oldProductId: { in: ids } }, { targetProductId: { in: ids } }] } });
    await prisma.supplierListingLink.deleteMany({ where: { productId: { in: ids } } });
    await prisma.productSupplierMapping.deleteMany({ where: { productId: { in: ids } } });
    await prisma.productEligibility.deleteMany({ where: { productId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
    if (supplierId) await prisma.supplier.delete({ where: { id: supplierId } }).catch(() => {});
    await prisma.$disconnect();
  });

  // dubai-frame -> dubai-frame-2: the old page is live, the listing was published with "replaces: none".
  const frameBase = `${P}-frame`;
  const frameSlug = `${frameBase}-2`;
  let frame = { productId: "", linkId: "" };
  let frameOld = "";

  it("retire: a reference to the old slug stops it, an instant old page is kept, a missing permission refuses", async () => {
    frameOld = await makeProduct(frameBase, "Old synthetic frame");
    frame = await makeListing(frameSlug, "Synthetic frame");
    const referrer = await makeProduct(`${P}-referrer`, "Synthetic referrer", [frameBase]);
    await expect(listings.retireOld(admin, frame.linkId, frameOld, "retire the old frame page")).rejects.toSatisfy(msg(new RegExp(`still named elsewhere: listing:${P}-referrer`)));
    await activities.remove(admin, referrer, "zz synthetic: drop the reference");

    await prisma.product.update({ where: { id: frameOld }, data: { fulfilmentMode: "instant" } });
    await expect(listings.retireOld(admin, frame.linkId, frameOld, "retire the old frame page")).rejects.toSatisfy(msg(/old listing is instant/));
    await prisma.product.update({ where: { id: frameOld }, data: { fulfilmentMode: "inquiry" } });

    await expect(listings.retireOld(editor, frame.linkId, frameOld, "retire the old frame page")).rejects.toSatisfy((e) => code(e) === "FORBIDDEN");
    await expect(listings.retireOld(admin, frame.linkId, frame.productId, "retire the old frame page")).rejects.toSatisfy((e) => code(e) === "VALIDATION_FAILED");
    await expect(listings.retireOld(admin, frame.linkId, frameOld, "short")).rejects.toSatisfy((e) => code(e) === "VALIDATION_FAILED");
    expect((await product(frameOld)).deletedAt).toBeNull();
  });

  it("retire: a live old page is soft-deleted with a permanent redirect, and the link records it", async () => {
    const r = await listings.retireOld(admin, frame.linkId, frameOld, "retire the old frame page");
    expect(r).toMatchObject({ mode: "retired", oldSlug: frameBase, slug: frameSlug });
    expect((await product(frameOld)).deletedAt).not.toBeNull();
    expect(await redirectsOf([frameOld])).toEqual([{ oldSlug: frameBase, oldProductId: frameOld, targetProductId: frame.productId, linkId: frame.linkId }]);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: frame.linkId } })).replacesProductId).toBe(frameOld);
    expect(await lookupRetiredSlug(frameBase)).toEqual({ to: `/activities/${frameSlug}`, permanent: true });
    expect(await prisma.auditLog.count({ where: { entityId: frameOld, action: "traveldesk_listing.retire" } })).toBe(1);
    // A second retire of the same page has nothing to do.
    await expect(listings.retireOld(admin, frame.linkId, frameOld, "retire the old frame page")).rejects.toSatisfy(msg(/already redirects to this listing/));
  });

  it("queue offers the move for the published -2 listing", async () => {
    const row = (await listings.queue(admin, { environment: "test" })).find((x) => x.linkId === frame.linkId)!;
    expect(row).toMatchObject({ cleanAddress: frameBase, movedFrom: null, retireOptions: [] });
  });

  it("move: refused while another listing names the -2 slug; then moves, with versions, audits and redirects", async () => {
    const referrer = await makeProduct(`${P}-referrer-two`, "Second synthetic referrer", [frameSlug]);
    await expect(listings.moveToCleanAddress(admin, frame.linkId, "clean address for the frame")).rejects.toSatisfy(msg(new RegExp(`still named elsewhere: listing:${P}-referrer-two`)));
    await activities.remove(admin, referrer, "zz synthetic: drop the reference");
    await expect(listings.moveToCleanAddress(editor, frame.linkId, "clean address for the frame")).rejects.toSatisfy((e) => code(e) === "FORBIDDEN");

    const [beforeListing, beforeOld] = [await product(frame.productId), await product(frameOld)];
    const moved = await listings.moveToCleanAddress(admin, frame.linkId, "clean address for the frame");
    const tomb = tombstoneSlug(frameBase, frameOld);
    expect(moved).toMatchObject({ from: frameSlug, to: frameBase, tombstone: tomb });
    const [listing, old] = [await product(frame.productId), await product(frameOld)];
    expect(listing).toMatchObject({ slug: frameBase, status: "published", deletedAt: null, version: beforeListing.version + 1 });
    expect((listing.content as { slug: string }).slug).toBe(frameBase);
    // The listing's own placeholder image refs follow the slug (review P3), and that rewrite locks nothing (review P2).
    expect((listing.content as { images: string[] }).images).toEqual([`img:activity:${frameBase}:0`]);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: frame.linkId } })).lockedFields).toEqual([]);
    expect(old).toMatchObject({ slug: tomb, version: beforeOld.version + 1 });
    expect(old.deletedAt).not.toBeNull();
    expect(await redirectsOf([frameOld, frame.productId])).toEqual([{ oldSlug: frameSlug, oldProductId: frameOld, targetProductId: frame.productId, linkId: frame.linkId }]);
    expect(await lookupRetiredSlug(frameSlug)).toEqual({ to: `/activities/${frameBase}`, permanent: true });
    expect(await lookupRetiredSlug(frameBase)).toBeNull();
    expect(await lookupRetiredSlug(tomb)).toBeNull();
    const v = await prisma.productVersion.findUniqueOrThrow({ where: { productId_version: { productId: frame.productId, version: listing.version } } });
    expect((v.content as { slug: string }).slug).toBe(frameBase);
    const ov = await prisma.productVersion.findUniqueOrThrow({ where: { productId_version: { productId: frameOld, version: old.version } } });
    expect(ov.reason?.startsWith("Replaced by ")).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: frame.productId, action: "traveldesk_listing.move_address" } })).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { entityId: frame.productId, action: "activity.update" }, orderBy: { createdAt: "desc" }, select: { before: true, after: true } })).toMatchObject({ before: { slug: frameSlug }, after: { slug: frameBase } });

    const row = (await listings.queue(admin, { environment: "test" })).find((x) => x.linkId === frame.linkId)!;
    expect(row).toMatchObject({ slug: frameBase, cleanAddress: null, movedFrom: frameSlug });
    // Already at the clean address; the retired page cannot come back from the console while its address is lent.
    await expect(listings.moveToCleanAddress(admin, frame.linkId, "clean address for the frame")).rejects.toSatisfy(msg(/does not end in -<number>/));
    await expect(activities.restore(admin, frameOld)).rejects.toSatisfy(msg(/undo that address move/));
  });

  it("P1-1: the old -2 address a move freed is reserved for create, update, duplicate, restore-version and the CSV import", async () => {
    // create
    const other = await makeProduct(`${P}-reserve-src`, "Reserve source");
    const { input } = await inputOf(other);
    await expect(activities.create(admin, { ...input, slug: frameSlug })).rejects.toSatisfy(msg(/is reserved: a retired or moved page's old address/));
    // update to the reserved slug
    const v = await inputOf(other);
    await expect(activities.update(admin, other, { ...v.input, slug: frameSlug }, { expectedVersion: v.version })).rejects.toSatisfy(msg(/is reserved/));
    // restore-version to a version that had the reserved slug: give `other` a version at a free slug, then free the
    // slug behind a redirect (as a move does) and restore that version.
    const free = `${P}-reserve-free`;
    await activities.update(admin, other, { ...v.input, slug: free }, { expectedVersion: v.version });
    const atFree = (await product(other)).version;
    const back = await inputOf(other);
    await activities.update(admin, other, { ...back.input, slug: `${P}-reserve-src` }, { expectedVersion: back.version });
    await prisma.productRedirect.create({ data: { id: uuidv7(), oldSlug: free, oldProductId: frameOld, targetProductId: frame.productId } });
    await expect(activities.restoreVersion(admin, other, atFree)).rejects.toSatisfy(msg(/is reserved/));
    // duplicate skips a reserved copy slug
    await prisma.productRedirect.create({ data: { id: uuidv7(), oldSlug: `${P}-reserve-src-copy`, oldProductId: frameOld, targetProductId: frame.productId } });
    const copy = await activities.duplicate(admin, other);
    expect(copy.slug).toBe(`${P}-reserve-src-copy-2`);
    // CSV import: a new row on the reserved slug fails at preview
    const { csv } = await importService.exportCsv(admin, { productIds: [other] });
    const preview = await importService.preview(admin, { source: "csv", text: csv.split(`${P}-reserve-src`).join(frameSlug), fileName: "zz-reserved.csv" });
    expect(preview.rowsFailed).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/is reserved: a retired or moved page's old address/);
    await prisma.importBatch.deleteMany({ where: { id: preview.batchId } });
    await prisma.productRedirect.deleteMany({ where: { oldSlug: { in: [free, `${P}-reserve-src-copy`] } } });
  });

  it("P2-1: a moved listing's slug is fixed (update and restore-version refuse) until the move is undone", async () => {
    const v = await inputOf(frame.productId);
    await expect(activities.update(admin, frame.productId, { ...v.input, slug: `${P}-frame-elsewhere` }, { expectedVersion: v.version })).rejects.toSatisfy(msg(/moved to its clean address; undo the move/));
    const preMove = (await prisma.productVersion.findFirstOrThrow({ where: { productId: frame.productId, reason: { startsWith: "Moved to clean address" } }, select: { version: true } })).version - 1;
    await expect(activities.restoreVersion(admin, frame.productId, preMove)).rejects.toSatisfy(msg(/moved to its clean address; undo the move/));
    // A save that keeps the slug still works; it locks what the person changed, not the rewritten image refs.
    await activities.update(admin, frame.productId, { ...v.input, subtitle: "Synthetic frame, edited after the move." }, { expectedVersion: v.version });
    expect((await product(frame.productId)).slug).toBe(frameBase);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: frame.linkId } })).lockedFields).toEqual(["subtitle"]);
  });

  it("undo is the exact inverse (references to the base still land on the listing), and the move can be repeated", async () => {
    // Undo recreates the base redirect, so a list naming the base does not stop it (review P2-2).
    await makeProduct(`${P}-frame-base-referrer`, "Frame base referrer", [frameBase]);
    const back = await listings.undoCleanAddress(admin, frame.linkId, "undo the frame address move");
    expect(back).toMatchObject({ from: frameBase, to: frameSlug });
    expect((await product(frame.productId)).slug).toBe(frameSlug);
    expect(((await product(frame.productId)).content as { slug: string }).slug).toBe(frameSlug);
    expect(((await product(frame.productId)).content as { images: string[] }).images).toEqual([`img:activity:${frameSlug}:0`]);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: frame.linkId } })).lockedFields).toEqual(["subtitle"]);
    expect((await product(frameOld)).slug).toBe(frameBase);
    expect(await redirectsOf([frameOld, frame.productId])).toEqual([{ oldSlug: frameBase, oldProductId: frameOld, targetProductId: frame.productId, linkId: frame.linkId }]);
    expect(await lookupRetiredSlug(frameBase)).toEqual({ to: `/activities/${frameSlug}`, permanent: true });
    await expect(listings.undoCleanAddress(admin, frame.linkId, "undo the frame address move")).rejects.toSatisfy(msg(/not moved/));
    await listings.moveToCleanAddress(admin, frame.linkId, "clean address for the frame, again");
    expect((await product(frame.productId)).slug).toBe(frameBase);
  });

  it("restore of a moved listing undoes the move first: the old page is back, published, at its own address", async () => {
    const r = await listings.restoreReplaced(admin, frame.linkId, "restore the old frame page");
    expect(r.oldSlug).toBe(frameBase);
    expect(await product(frameOld)).toMatchObject({ slug: frameBase, status: "published", deletedAt: null });
    expect((await product(frame.productId)).slug).toBe(frameSlug);
    expect(await redirectsOf([frameOld, frame.productId])).toEqual([]);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: frame.linkId } })).replacesProductId).toBeNull();
    expect(await lookupRetiredSlug(frameSlug)).toBeNull();
  });

  // global-village -> global-village-2: the old page was archived some other way and has no redirect.
  const villageBase = `${P}-village`;
  const villageSlug = `${villageBase}-2`;
  let village = { productId: "", linkId: "" };
  let villageOld = "";

  it("retire of an archived page writes the redirect only (and a retire version); the queue offers it as redirect only", async () => {
    villageOld = await makeProduct(villageBase, "Old synthetic village");
    await activities.remove(admin, villageOld, "zz synthetic: retired for catalogue re-import");
    village = await makeListing(villageSlug, "Synthetic village");
    const row = (await listings.queue(admin, { environment: "test" })).find((x) => x.linkId === village.linkId)!;
    expect(row.retireOptions).toEqual([{ productId: villageOld, slug: villageBase, title: "Old synthetic village", archived: true }]);
    expect(row.cleanAddress).toBeNull();

    // A list still naming the archived page does not stop the redirect (the page already left it); it is reported.
    await makeProduct(`${P}-village-referrer`, "Village referrer", [villageBase]);
    const before = await product(villageOld);
    const r = await listings.retireOld(admin, village.linkId, villageOld, "redirect the archived village page");
    expect(r).toMatchObject({ mode: "redirected", references: [`listing:${P}-village-referrer`] });
    const after = await product(villageOld);
    expect(after.version).toBe(before.version + 1);
    expect(after.deletedAt).toEqual(before.deletedAt);
    expect((await prisma.productVersion.findUniqueOrThrow({ where: { productId_version: { productId: villageOld, version: after.version } } })).reason).toMatch(/^Redirected to /);
    expect(await lookupRetiredSlug(villageBase)).toEqual({ to: `/activities/${villageSlug}`, permanent: true });
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: village.linkId } })).replacesProductId).toBe(villageOld);
  });

  it("two concurrent moves: exactly one wins", async () => {
    const results = await Promise.allSettled([
      listings.moveToCleanAddress(admin, village.linkId, "clean address for the village"),
      listings.moveToCleanAddress(admin, village.linkId, "clean address for the village"),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(code((results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason)).toBe("CONFLICT");
    expect((await product(village.productId)).slug).toBe(villageBase);
    expect(await redirectsOf([villageOld, village.productId])).toEqual([{ oldSlug: villageSlug, oldProductId: villageOld, targetProductId: village.productId, linkId: village.linkId }]);
  });

  it("P2-2: restore after a redirect-only retire and a move drops the redirect and leaves the old page archived at its own address", async () => {
    const r = await listings.restoreReplaced(admin, village.linkId, "undo the village redirect");
    expect(r).toMatchObject({ oldSlug: villageBase, redirectOnly: true, restored: 0 });
    const old = await product(villageOld);
    expect(old).toMatchObject({ slug: villageBase, status: "archived" });
    expect(old.deletedAt).not.toBeNull();
    expect((await product(village.productId)).slug).toBe(villageSlug);
    expect(await redirectsOf([villageOld, village.productId])).toEqual([]);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: village.linkId } })).replacesProductId).toBeNull();
    expect(await lookupRetiredSlug(villageBase)).toBeNull();
  });

  // A page archived without a retire marker, with a hand-written redirect to the listing (no replaces recorded).
  const legacyBase = `${P}-legacy`;
  const legacySlug = `${legacyBase}-2`;
  let legacy = { productId: "", linkId: "" };
  let legacyOld = "";

  it("P2-3: moving a page archived without a retire marker writes a neutral reason; undo clears the replaces the move set", async () => {
    legacyOld = await makeProduct(legacyBase, "Legacy synthetic page");
    await activities.remove(admin, legacyOld, "zz synthetic: retired for catalogue re-import");
    legacy = await makeListing(legacySlug, "Synthetic legacy");
    await prisma.productRedirect.create({ data: { id: uuidv7(), oldSlug: legacyBase, oldProductId: legacyOld, targetProductId: legacy.productId, linkId: legacy.linkId } });
    await listings.moveToCleanAddress(admin, legacy.linkId, "clean address for the legacy page");
    const held = await product(legacyOld);
    expect((await prisma.productVersion.findUniqueOrThrow({ where: { productId_version: { productId: legacyOld, version: held.version } } })).reason).toMatch(/^Address change: /);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: legacy.linkId } })).replacesProductId).toBe(legacyOld);

    await listings.undoCleanAddress(admin, legacy.linkId, "undo the legacy address move");
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: legacy.linkId } })).replacesProductId).toBeNull();
    const back = await product(legacyOld);
    expect(back.slug).toBe(legacyBase);
    expect((await prisma.productVersion.findUniqueOrThrow({ where: { productId_version: { productId: legacyOld, version: back.version } } })).reason).toMatch(/^Address change: /);
  });

  it("P2-3: restore of that page refuses instead of publishing it (no retire marker, N1-11)", async () => {
    await listings.moveToCleanAddress(admin, legacy.linkId, "clean address for the legacy page, again");
    await expect(listings.restoreReplaced(admin, legacy.linkId, "restore the legacy page")).rejects.toSatisfy(msg(/changed after it was retired/));
    expect((await product(legacy.productId)).slug).toBe(legacyBase);
    expect((await product(legacyOld)).deletedAt).not.toBeNull();
  });

  it("P3: the queue offers the undo for a moved listing that is no longer published", async () => {
    await prisma.product.update({ where: { id: legacy.productId }, data: { status: "draft" } });
    const row = (await listings.queue(admin, { environment: "test" })).find((x) => x.linkId === legacy.linkId)!;
    expect(row).toMatchObject({ status: "draft", movedFrom: legacySlug, cleanAddress: null });
    await prisma.product.update({ where: { id: legacy.productId }, data: { status: "published" } });
  });

  it("P2-1: a listing whose slug changed behind a move is never restored with its old page at a tombstone", async () => {
    // Out of band (no service allows it): the listing leaves the base.
    await prisma.product.update({ where: { id: legacy.productId }, data: { slug: `${P}-legacy-elsewhere` } });
    await expect(listings.restoreReplaced(admin, legacy.linkId, "restore the legacy page")).rejects.toSatisfy(msg(/no longer at/));
    expect((await product(legacyOld)).deletedAt).not.toBeNull();
    await expect(listings.undoCleanAddress(admin, legacy.linkId, "undo the legacy address move")).rejects.toSatisfy(msg(/no longer at/));
    await prisma.product.update({ where: { id: legacy.productId }, data: { slug: legacyBase } });
  });

  it("P3: retire refuses a live old page whose slug already redirects elsewhere (never retargeted)", async () => {
    const busyOld = await makeProduct(`${P}-busy`, "Busy synthetic page");
    const busy = await makeListing(`${P}-busy-new`, "Synthetic busy");
    const elsewhere = await makeListing(`${P}-busy-elsewhere`, "Synthetic elsewhere");
    // Not dormant for this page: the redirect names a different old page, even a live and published one (only a
    // redirect whose old page is this same page, live again, is taken over: P3-1).
    const ghost = await makeProduct(`${P}-busy-ghost`, "Busy ghost page");
    await prisma.productRedirect.create({ data: { id: uuidv7(), oldSlug: `${P}-busy`, oldProductId: ghost, targetProductId: elsewhere.productId, linkId: elsewhere.linkId } });
    await expect(listings.retireOld(admin, busy.linkId, busyOld, "retire the busy page")).rejects.toSatisfy(msg(/already redirects to another listing/));
    expect((await product(busyOld)).deletedAt).toBeNull();
    expect((await prisma.productRedirect.findUniqueOrThrow({ where: { oldSlug: `${P}-busy` } })).targetProductId).toBe(elsewhere.productId);
  });

  it("P3-1: a dormant redirect (its old page restored and republished from the console) is taken over by the listing's own retire", async () => {
    const dormantOld = await makeProduct(`${P}-dormant`, "Dormant synthetic page");
    const l1 = await makeListing(`${P}-dormant-new`, "Synthetic dormant one");
    await listings.retireOld(admin, l1.linkId, dormantOld, "retire the dormant page");
    await activities.restore(admin, dormantOld);
    await activities.setStatus(admin, dormantOld, "published");
    expect(await lookupRetiredSlug(`${P}-dormant`)).toBeNull();
    const r = await listings.retireOld(admin, l1.linkId, dormantOld, "retire the dormant page again");
    expect(r.mode).toBe("retired");
    expect((await product(dormantOld)).deletedAt).not.toBeNull();
    expect(await redirectsOf([dormantOld])).toEqual([{ oldSlug: `${P}-dormant`, oldProductId: dormantOld, targetProductId: l1.productId, linkId: l1.linkId }]);

    // Restored and republished again, then another listing takes the page over: the first link no longer names it.
    await activities.restore(admin, dormantOld);
    await activities.setStatus(admin, dormantOld, "published");
    const l2 = await makeListing(`${P}-dormant-other`, "Synthetic dormant two");
    const taken = await listings.retireOld(admin, l2.linkId, dormantOld, "retire the dormant page for another listing");
    expect(taken.releasedFrom).toBe("Synthetic dormant one");
    expect(await redirectsOf([dormantOld])).toEqual([{ oldSlug: `${P}-dormant`, oldProductId: dormantOld, targetProductId: l2.productId, linkId: l2.linkId }]);
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: l1.linkId } })).replacesProductId).toBeNull();
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: l2.linkId } })).replacesProductId).toBe(dormantOld);
    expect(await lookupRetiredSlug(`${P}-dormant`)).toEqual({ to: `/activities/${P}-dormant-other`, permanent: true });
    expect(await prisma.auditLog.count({ where: { entityId: dormantOld, action: "product_redirect.retarget" } })).toBe(2);
  });

  it("P3: retire offers only the page the link names while that page is live", async () => {
    const named = await makeProduct(`${P}-named-other`, "Named synthetic page");
    await makeProduct(`${P}-named`, "Base holder");
    const l = await makeListing(`${P}-named-2`, "Synthetic named");
    await prisma.supplierListingLink.update({ where: { id: l.linkId }, data: { replacesProductId: named } });
    const row = (await listings.queue(admin, { environment: "test" })).find((x) => x.linkId === l.linkId)!;
    expect(row.retireOptions.map((o) => o.productId)).toEqual([named]);
  });

  it("move refuses: the base held by a live page, no redirect from the base, a redirect from the base to another listing", async () => {
    const liveBase = `${P}-live`;
    const liveOld = await makeProduct(liveBase, "Live synthetic page");
    const live = await makeListing(`${liveBase}-2`, "Synthetic live");
    await expect(listings.moveToCleanAddress(admin, live.linkId, "clean address for the live one")).rejects.toSatisfy(msg(/held by a live listing/));

    // Archived, but nothing records it as replaced by this listing.
    await activities.remove(admin, liveOld, "zz synthetic: archived without a redirect");
    await expect(listings.moveToCleanAddress(admin, live.linkId, "clean address for the live one")).rejects.toSatisfy(msg(/no redirect to this listing/));

    // Its base redirects to another listing.
    const other = await makeListing(`${P}-other`, "Synthetic other");
    await prisma.productRedirect.create({ data: { id: uuidv7(), oldSlug: liveBase, oldProductId: liveOld, targetProductId: other.productId, linkId: other.linkId } });
    await expect(listings.moveToCleanAddress(admin, live.linkId, "clean address for the live one")).rejects.toSatisfy(msg(/redirects to another listing/));
    await expect(listings.retireOld(admin, live.linkId, liveOld, "redirect the archived live page")).rejects.toSatisfy(msg(/already redirects to another listing/));
    expect((await product(live.productId)).slug).toBe(`${liveBase}-2`);
  });
});
