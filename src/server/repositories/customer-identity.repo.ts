import "server-only";
import { prisma, type Tx } from "../lib/db";
import { uuidv7 } from "../lib/ids";

/**
 * Group B persistence: identities (Supabase user id → customer), the hook
 * gate (`customer_auth_intents`), the automatic attach links and the email
 * send counters. Hashes only where the contact itself is not needed.
 */

type Db = Tx | typeof prisma;

export const SUPABASE_PROVIDER = "supabase";

export type SignInMethod = "email_otp" | "google" | "apple" | "sms_otp" | "whatsapp_otp";

export interface IdentityRecord {
  id: string;
  customerId: string;
  providerSubject: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  lastMethod: string;
}

export const customerIdentityRepo = {
  /* ------------------------------------------------------------ identities */

  async findBySubject(subject: string, db: Db = prisma): Promise<IdentityRecord | null> {
    return db.customerIdentity.findUnique({
      where: { provider_providerSubject: { provider: SUPABASE_PROVIDER, providerSubject: subject } },
      select: { id: true, customerId: true, providerSubject: true, email: true, emailVerifiedAt: true, lastMethod: true },
    });
  },

  async findByCustomer(customerId: string, db: Db = prisma): Promise<IdentityRecord | null> {
    return db.customerIdentity.findUnique({
      where: { customerId_provider: { customerId, provider: SUPABASE_PROVIDER } },
      select: { id: true, customerId: true, providerSubject: true, email: true, emailVerifiedAt: true, lastMethod: true },
    });
  },

  async create(input: { customerId: string; subject: string; email: string | null; emailHash: string | null; emailVerifiedAt: Date | null; method: SignInMethod; now: Date }, db: Db = prisma): Promise<IdentityRecord> {
    const id = uuidv7();
    await db.customerIdentity.create({
      data: {
        id,
        customerId: input.customerId,
        provider: SUPABASE_PROVIDER,
        providerSubject: input.subject,
        email: input.email,
        emailHash: input.emailHash,
        emailVerifiedAt: input.emailVerifiedAt,
        lastMethod: input.method,
        createdAt: input.now,
        lastUsedAt: input.now,
      },
    });
    return { id, customerId: input.customerId, providerSubject: input.subject, email: input.email, emailVerifiedAt: input.emailVerifiedAt, lastMethod: input.method };
  },

  /** A sign-in on a known identity: the method, the time and, only when this sign-in proved it, the email. */
  async touch(id: string, input: { email: string | null; emailHash: string | null; emailVerifiedAt: Date | null; method: SignInMethod; now: Date }, db: Db = prisma): Promise<void> {
    await db.customerIdentity.update({
      where: { id },
      data: {
        lastMethod: input.method,
        lastUsedAt: input.now,
        ...(input.email ? { email: input.email, emailHash: input.emailHash, emailVerifiedAt: input.emailVerifiedAt } : {}),
      },
    });
  },

  /** Erasure (PRV): the identity rows go; links keep the order history with `identity_id` NULL. Returns the removed subjects. */
  async removeForCustomer(customerId: string, db: Db = prisma): Promise<string[]> {
    const rows = await db.customerIdentity.findMany({ where: { customerId }, select: { providerSubject: true } });
    if (rows.length) await db.customerIdentity.deleteMany({ where: { customerId } });
    return rows.map((r) => r.providerSubject);
  },

  /* -------------------------------------------------------------- intents */

  /** One live intent per contact: older open ones are retired first. */
  async createIntent(input: { channel: "email" | "phone"; contactHash: string; ipHash?: string; now: Date; ttlMs: number }, db: Db = prisma): Promise<string> {
    const id = uuidv7();
    await db.customerAuthIntent.updateMany({ where: { channel: input.channel, contactHash: input.contactHash, consumedAt: null }, data: { consumedAt: input.now } });
    await db.customerAuthIntent.create({
      data: { id, channel: input.channel, contactHash: input.contactHash, ipHash: input.ipHash, createdAt: input.now, expiresAt: new Date(input.now.getTime() + input.ttlMs) },
    });
    return id;
  },

  /** True when a live, unconsumed intent exists (Before User Created hook). Reads only. */
  async hasLiveIntent(channel: "email" | "phone", contactHash: string, now: Date, db: Db = prisma): Promise<boolean> {
    const row = await db.customerAuthIntent.findFirst({ where: { channel, contactHash, consumedAt: null, expiresAt: { gt: now } }, select: { id: true } });
    return Boolean(row);
  },

  /** Consumes the newest live intent. Single use: a second caller gets null. */
  async consumeIntent(channel: "email" | "phone", contactHash: string, now: Date, db: Db = prisma): Promise<string | null> {
    const row = await db.customerAuthIntent.findFirst({
      where: { channel, contactHash, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!row) return null;
    const r = await db.customerAuthIntent.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
    return r.count === 1 ? row.id : null;
  },

  /* ------------------------------------------------------------- counters */

  /** +1 on today's (UTC) count for an email sent outside the outbox. Best effort: never throws. */
  async countEmailSend(kind: "signin_code" | "checkout_code" | "recovery_code", now: Date = new Date(), db: Db = prisma): Promise<void> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    try {
      await db.$executeRaw`
        INSERT INTO email_send_counters (day, kind, count, updated_at) VALUES (${day}::date, ${kind}, 1, ${now})
        ON CONFLICT (day, kind) DO UPDATE SET count = email_send_counters.count + 1, updated_at = EXCLUDED.updated_at`;
    } catch {
      // Counting never blocks a send; the volume alert reads a slightly low figure instead.
    }
  },
};
