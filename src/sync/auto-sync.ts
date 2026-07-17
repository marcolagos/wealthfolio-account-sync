import type { AddonContext } from "@wealthfolio/addon-sdk";
import { loadMapping } from "../lib/mapping";
import { PlaidClient } from "../plaid/client";
import { loadSyncLog, runSync } from "./orchestrator";

export const AUTO_SYNC_HOURS_KEY = "auto-sync-hours";
export const DEFAULT_AUTO_SYNC_HOURS = 24;

export async function getAutoSyncHours(ctx: AddonContext): Promise<number> {
  const raw = await ctx.api.storage.get(AUTO_SYNC_HOURS_KEY);
  const parsed = raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_AUTO_SYNC_HOURS;
}

/**
 * Called from enable() on every app launch (the addon is pinned, so it boots
 * eagerly). Runs a sync when configured, mapped, auto-sync is on (hours > 0),
 * and the last run is older than the configured interval. Stays quiet unless
 * something was imported or failed.
 */
export async function maybeAutoSync(ctx: AddonContext): Promise<void> {
  try {
    const hours = await getAutoSyncHours(ctx);
    if (hours === 0) return;

    const client = new PlaidClient(ctx);
    if (!(await client.isConfigured())) return;
    if ((await client.listItems()).length === 0) return;

    const mapping = await loadMapping(ctx);
    if (Object.keys(mapping.links).length === 0) return;

    const lastRun = (await loadSyncLog(ctx))[0]?.at;
    if (lastRun && Date.now() - Date.parse(lastRun) < hours * 3_600_000) return;

    const run = await runSync(ctx);
    ctx.api.query.invalidateQueries(["account-sync", "sync-log"]);
    const failed = run.outcomes.filter((o) => o.error);
    const imported = run.outcomes.reduce((acc, o) => acc + o.imported, 0);
    if (run.error) {
      ctx.api.toast.error(`Auto-sync failed: ${run.error}`);
    } else if (failed.length > 0) {
      ctx.api.toast.warning(
        `Auto-sync: errors on ${failed.length} account(s) — see the sync log`,
      );
    } else if (imported > 0) {
      ctx.api.toast.success(`Auto-sync: ${imported} activities imported`);
    }
  } catch (error) {
    ctx.api.logger.error(
      `account-sync auto-sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
