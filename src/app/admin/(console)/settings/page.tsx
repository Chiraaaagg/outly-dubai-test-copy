import { hasPermission } from "@/server/lib/actor";
import { currentFxRow } from "@/server/services/fx-refresh.service";
import { settingsService } from "@/server/services/settings.service";
import { requirePage } from "../../_lib/guard";
import { PageHeader } from "../../_components/ui";
import { FxPanel, type FxView } from "./fx-panel";
import { SettingsForms } from "./settings-forms";

/**
 * /admin/settings — SLA, routing, follow-up ladder and price tolerance
 * (§10 §2.13, §17). Values propagate within a minute (settings cache TTL).
 * The live INR-per-AED rate is shown read-only; `pricing.edit` adds a manual
 * refresh (doc 22 §32.16).
 */
export const dynamic = "force-dynamic";

function dubaiTime(iso: string): string {
  return `${new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })} GST`;
}

export default async function AdminSettingsPage() {
  const { actor } = await requirePage("settings.edit");
  const [all, fx] = await Promise.all([settingsService.all(), currentFxRow()]);
  const fxView: FxView | null = fx
    ? { inrPerAed: fx.inrPerAed, version: fx.version, source: fx.source, recordedAt: dubaiTime(fx.recordedAt), expiresAt: dubaiTime(fx.expiresAt), usable: fx.usable }
    : null;
  return (
    <>
      <PageHeader title="Settings" sub="Changes are audited and take effect within a minute on every instance. No deploy needed." />
      <div className="mb-4">
        <FxPanel current={fxView} canRefresh={hasPermission(actor, "pricing.edit")} />
      </div>
      <SettingsForms initial={all} />
    </>
  );
}
