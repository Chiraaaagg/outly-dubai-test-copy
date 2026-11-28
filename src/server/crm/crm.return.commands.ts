import "server-only";
import { prisma } from "../lib/db";
import { audit } from "../lib/audit";
import { AppError } from "../lib/errors";
import { requirePermission, SYSTEM_ACTOR, type Actor } from "../lib/actor";
import { adminRepo } from "../repositories/admin.repo";
import { inquiryService } from "../services/inquiry.service";
import type { InquiryStatus } from "@/lib/types";
import type { CrmCommandResult, CrmReturnCommands, CrmStaffActor } from "./crm.reconcile";

/**
 * The return path's only way into OUTLYY state (doc 29e §3.7; CRM batch
 * C3ab): the inquiry service's own `transition` and `assign`, called as the
 * mapped staff member's OUTLYY actor (owner answer 3), plus the audit helper
 * for put-backs. The service applies the transition table, the permission,
 * the "own inquiries only" rule, the loss reason and two-factor rules, writes
 * the inquiry event and the audit row (with "via Bitrix24") and queues the
 * CRM push, in one transaction, exactly as in OUTLYY admin.
 *
 * Nothing else is reachable from here: no payment, booking, ticket, refund,
 * order, document, privacy or authentication code (crm.return.boundary
 * unit test). The staff record is read through the admin repository
 * (read-only) to build the actor the way a signed-in session does:
 * permissions only while the account is active with two-factor enrolled.
 */

interface Wrapped extends CrmStaffActor {
  readonly __actor: Actor;
}

function actorOf(a: CrmStaffActor): Actor {
  return (a as Wrapped).__actor;
}

/** An error the service refused with, as a short code (never a message). */
function refusal(e: unknown): CrmCommandResult {
  if (e instanceof AppError) {
    const detail = e.code === "FORBIDDEN" || e.code === "INVALID_TRANSITION" || e.code === "VALIDATION_FAILED" || e.code === "CONFLICT" || e.code === "NOT_FOUND" ? e.code.toLowerCase() : "refused";
    return { ok: false, code: detail };
  }
  throw e;
}

export const crmReturnCommands: CrmReturnCommands = {
  async inquiry(id) {
    const q = await prisma.inquiry.findUnique({ where: { id }, select: { status: true, assignedAgentId: true, convertedOrderId: true } });
    return q ? { status: q.status, assignedAgentId: q.assignedAgentId, hasOrder: q.convertedOrderId !== null } : null;
  },

  async staff(staffId) {
    const u = await adminRepo.findById(staffId);
    if (!u || u.status !== "active" || !u.totpEnabled) return null;
    const agentOnly = u.roles.every((r) => r === "agent" || r === "agent_lead");
    const actor: Actor = {
      type: agentOnly ? "agent" : "admin",
      id: u.id,
      roles: u.roles,
      permissions: new Set(u.permissions),
      // The audit row says where the action came from; no IP: the request is the portal's, not the person's.
      userAgent: "bitrix24-return-path",
    };
    return { staffId: u.id, __actor: actor } satisfies Wrapped;
  },

  async existingStaff(ids) {
    if (!ids.length) return new Set();
    const rows = await prisma.adminUser.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  },

  async transition(actor, inquiryId, to, via, opts) {
    try {
      await inquiryService.transition(actorOf(actor), inquiryId, to as InquiryStatus, { reason: opts.reason, note: "Moved in Bitrix24", via });
      return { ok: true };
    } catch (e) {
      return refusal(e);
    }
  },

  async assign(actor, inquiryId, agentId, via, note) {
    try {
      const a = actor === "system" ? SYSTEM_ACTOR : actorOf(actor);
      // As in OUTLYY admin (review C3-01): taking an inquiry for oneself is a claim and needs `inquiries.claim`
      // (the admin claim route); any other assignment needs `inquiries.assign` (the admin assign action). The
      // service's own checks (open inquiry, active target with two-factor, self-claim only when unassigned) follow.
      if (actor !== "system") requirePermission(a, agentId === a.id ? "inquiries.claim" : "inquiries.assign");
      await inquiryService.assign(a, inquiryId, agentId, note, { via });
      return { ok: true };
    } catch (e) {
      return refusal(e);
    }
  },

  async recordPutBack(subject, info) {
    const action = info.what === "stage" ? "crm.stage_reverted" : info.what === "drift" ? "crm.drift_pushed" : "crm.fields_restored";
    const after = { via: "bitrix24", dealId: info.dealId, bitrixUserId: info.bitrixUserId, from: info.from ?? null, to: info.to ?? null, fields: info.fields?.length ? info.fields : undefined };
    await audit(SYSTEM_ACTOR, action, { type: subject.type, id: subject.id }, {
      after,
      reason:
        info.what === "stage"
          ? "Stage changed in Bitrix24 was put back"
          : info.what === "drift"
            ? "The deal differed from OUTLYY after OUTLYY's own write: pushed again"
            : "OUTLYY fields changed in Bitrix24 were restored",
    });
    if (subject.type === "inquiry" && info.what === "stage") {
      // OUTLYY's own timeline shows it too. Keys and ids only.
      await prisma.inquiryEvent.create({
        data: {
          inquiryId: subject.id,
          kind: "system",
          actorType: "system",
          note: "A stage change in Bitrix24 was put back",
          meta: { via: "bitrix24", dealId: info.dealId, bitrixUserId: info.bitrixUserId, from: info.from ?? null, to: info.to ?? null },
        },
      });
    }
  },
};
