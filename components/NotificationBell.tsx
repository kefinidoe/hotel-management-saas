"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, Loader2 } from "lucide-react";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

const TYPE_DOT: Record<string, string> = {
  STOCK_ALERT: "bg-amber-500",
  MAINTENANCE: "bg-orange-500",
  BILLING: "bg-purple-500",
  RESERVATION: "bg-blue-500",
  HOUSEKEEPING: "bg-emerald-500",
  SYSTEM: "bg-slate-400",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load notifications (HTTP ${res.status}).`);
      const data = (await res.json()) as { unread: number; notifications: NotificationItem[] };
      setItems(data.notifications);
      setUnread(data.unread);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load notifications.");
    } finally {
      setLoading(false);
    }
  }, []);

  // The badge has to be right before the panel is ever opened, so the first
  // fetch happens on mount and the panel re-uses it when opened.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void load();
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, load]);

  async function markAll() {
    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    if (res.ok) {
      setItems((current) => current.map((item) => ({ ...item, isRead: true })));
      setUnread(0);
    } else {
      setError("Could not mark notifications as read.");
    }
  }

  async function markOne(id: string) {
    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setItems((current) => current.map((item) => (item.id === id ? { ...item, isRead: true } : item)));
      setUnread((current) => Math.max(0, current - 1));
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="relative text-text-secondary hover:text-text-primary"
        title="Notifications"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
      >
        <Bell size={19} strokeWidth={1.8} />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white
                       text-[10px] font-semibold leading-4 text-center"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-3 w-80 rounded-lg border border-border bg-surface shadow-lg z-30">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-sm font-semibold text-text-primary">Notifications</p>
            <button
              onClick={markAll}
              disabled={unread === 0}
              className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 disabled:text-text-secondary disabled:cursor-not-allowed"
            >
              <CheckCheck size={13} /> Mark all read
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading && (
              <p className="flex items-center gap-2 px-4 py-4 text-sm text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </p>
            )}
            {!loading && error && <p className="px-4 py-4 text-sm text-danger">{error}</p>}
            {!loading && !error && items.length === 0 && (
              <p className="px-4 py-6 text-sm text-text-secondary text-center">
                Nothing needs your attention.
              </p>
            )}
            {!loading &&
              !error &&
              items.map((item) => (
                <div
                  key={item.id}
                  className={`px-4 py-3 border-b border-border last:border-b-0 ${
                    item.isRead ? "bg-surface" : "bg-primary-50/50"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                        TYPE_DOT[item.type] ?? TYPE_DOT.SYSTEM
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary">{item.title}</p>
                      <p className="text-xs text-text-secondary mt-0.5 break-words">{item.message}</p>
                      <p className="text-[11px] text-text-secondary mt-1">{relativeTime(item.createdAt)}</p>
                    </div>
                    {!item.isRead && (
                      <button
                        onClick={() => markOne(item.id)}
                        className="text-[11px] text-primary-600 hover:text-primary-700 shrink-0"
                        title="Mark as read"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
