/* eslint-disable no-console */
// Removes rows left behind by an interrupted service test run (slug prefix zz-test-).
// Usage: npm run db:purge   (the disposable test database; see scripts/db.mjs)
// The target guard runs first: the disposable marker must match, or the owner
// passes --target=production --project-ref=<ref> and confirms interactively.
import { PrismaClient } from "@prisma/client";
import { assertDisposableDbLive, confirmProductionTarget, parseTargetArgs } from "../src/server/__tests__/helpers/target-guard.ts";
const prisma = new PrismaClient();
const target = parseTargetArgs(process.argv.slice(2));
if (target.target === "production") await confirmProductionTarget({ projectRef: target.projectRef, action: "purge of zz-test- rows" });
else await assertDisposableDbLive(prisma);
// TravelDesk service tests: run-scoped suppliers (zz-td-*) and their catalogue / candidate rows.
const tdSuppliers = await prisma.supplier.findMany({ where: { code: { startsWith: "zz-td-" } }, select: { id: true } });
const tdIds = tdSuppliers.map((x) => x.id);
await prisma.supplierMappingCandidate.deleteMany({ where: { OR: [{ supplierId: { in: tdIds } }, { product: { slug: { startsWith: "zz-test-" } } }] } });
await prisma.productSupplierMapping.deleteMany({ where: { supplierId: { in: tdIds } } });
await prisma.supplierPriceSnapshot.deleteMany({ where: { supplierId: { in: tdIds } } });
await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId: { in: tdIds } } });
// Booking engine tests: jobs and leases go; bookings and their events are append-only, so a supplier with bookings stays.
const tdBookings = await prisma.supplierBooking.findMany({ where: { supplierId: { in: tdIds } }, select: { id: true } });
await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: tdBookings.map((x) => x.id) } } });
await prisma.supplierAccountLease.deleteMany({ where: { supplierId: { in: tdIds } } });
await prisma.supplier.deleteMany({ where: { id: { in: tdIds }, bookings: { none: {} } } });
await prisma.productSupplierMapping.deleteMany({ where: { product: { slug: { startsWith: "zz-test-" } } } });
const p = await prisma.product.deleteMany({ where: { slug: { startsWith: "zz-test-" } } });
const c = await prisma.category.deleteMany({ where: { slug: { startsWith: "zz-test-" } } });
console.log(`purged ${p.count} products, ${c.count} categories`);
await prisma.$disconnect();
