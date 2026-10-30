"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ScrollText } from "lucide-react";

interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actorName: string;
  actorEmail: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  PAYMENT_RECORDED: "Payment recorded",
  CHECK_OUT: "Guest checked out",
  CHECK_OUT_WITH_BALANCE: "Checked out with a balance",
  STAFF_ADDED: "Staff added",
  STAFF_UPDATED: "Staff updated",
  STAFF_REMOVED: "Staff removed",
  HOTEL_SETTINGS_UPDATED: "Hotel settings changed",
  SUBSCRIPTION_UPDATED: "Subscription changed",
  INVITATION_SENT: "Invitation sent",
};

function label(action: string): string {
  return (
    ACTION_LABELS[action] ??
    action
      .toLowerCase()
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

function summarise(entry: AuditEntry): string {
  const meta = entry.metadata ?? {};
  const parts: string[] = [];
  if (typeof meta.amount === "number") parts.push(`KSh ${Number(meta.amount).toLocaleString()}`);
  if (typeof meta.reference === "string" && meta.reference) parts.push(`ref ${meta.reference}`);
  if (typeof meta.email === "string") parts.push(meta.email);
  if (typeof meta.role === "string") parts.push(String(meta.role).replace(/_/g, " ").toLowerCase());
  if (typeof meta.planId === "string") parts.push(`plan ${meta.planId}`);
  return parts.join(" · ");
}

export default function AuditTrailClient({ hotelName }: { hotelName: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = filter ? `?action=${encodeURIComponent(filter)}` : "";
      const res = await fetch(`/api/audit-logs${query}`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(
          res.status === 403
            ? "Only the hotel owner or an administrator can read the audit trail."
            : `Could not load the audit trail (HTTP ${res.status}).`
        );
      }
      const data = (await res.json()) as { logs: AuditEntry[]; actions: string[] };
      setEntries(data.logs);
      setActions(data.actions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the audit trail.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="flex items-center gap-2">
            <ScrollText size={22} /> Audit trail
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Who changed what at {hotelName}, newest first. Entries are written by the system and cannot be
            edited or deleted from this screen.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="btn-secondary flex items-center gap-2 text-sm"
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <label className="text-sm text-text-secondary flex items-center gap-2">
          Action
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="input py-1.5 text-sm"
          >
            <option value="">All actions</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {label(action)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm text-text-secondary self-center">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {error && <div className="card p-4 text-danger text-sm mb-4">{error}</div>}

      <div className="card overflow-hidden">
        {loading && entries.length === 0 ? (
          <p className="flex items-center gap-2 p-6 text-sm text-text-secondary">
            <Loader2 size={16} className="animate-spin" /> Loading the audit trail…
          </p>
        ) : entries.length === 0 ? (
          <p className="p-6 text-sm text-text-secondary">
            No audit entries yet. Staff changes, hotel settings, payments and check-outs are recorded here as
            they happen.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-border">
                  <td className="px-4 py-3 text-text-secondary whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-medium text-text-primary">{label(entry.action)}</td>
                  <td className="px-4 py-3">
                    <span className="text-text-primary">{entry.actorName}</span>
                    {entry.actorEmail && (
                      <span className="block text-xs text-text-secondary">{entry.actorEmail}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {entry.entity}
                    {entry.entityId && (
                      <span className="block text-xs font-mono">{entry.entityId.slice(0, 8)}…</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{summarise(entry) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
