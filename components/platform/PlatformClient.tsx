"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Building2,
  Shield,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Users,
  BedDouble,
  RefreshCw,
  ExternalLink,
  Info,
  Calendar,
  Layers,
  FileText,
  CreditCard,
} from "lucide-react";
import type { HotelStatus } from "@prisma/client";
import { formatPlatformPrice } from "@/lib/platform-currency";

interface HotelSummary {
  id: string;
  name: string;
  slug: string;
  status: HotelStatus;
  currency: string;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  roomCount: number;
  memberCount: number;
  reservationCount: number;
  owner: { id: string; name: string; email: string; phone?: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

interface PlatformMetrics {
  totalHotels: number;
  activeHotels: number;
  trialingHotels: number;
  suspendedHotels: number;
  cancelledHotels: number;
  totalUsers: number;
  totalRooms: number;
}

interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: any;
  createdAt: string;
  userName: string;
  userEmail: string | null;
  hotelName: string;
  hotelSlug: string | null;
}

export default function PlatformClient() {
  const [tab, setTab] = useState<"overview" | "directory" | "subscriptions" | "audit">("overview");

  // Metrics & overview data
  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null);
  const [recentHotels, setRecentHotels] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(true);

  // Directory state
  const [hotels, setHotels] = useState<HotelSummary[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingHotels, setLoadingHotels] = useState(false);

  // Subscriptions state
  const [subscriptions, setSubscriptions] = useState<any[]>([]);
  const [subSummary, setSubSummary] = useState<any>(null);
  const [availablePlans, setAvailablePlans] = useState<any[]>([]);
  const [subSearch, setSubSearch] = useState("");
  const [subStatusFilter, setSubStatusFilter] = useState("ALL");
  const [subPlanFilter, setSubPlanFilter] = useState("ALL");
  const [loadingSubs, setLoadingSubs] = useState(false);

  // Manage Subscription Modal state
  const [managingSubHotel, setManagingSubHotel] = useState<any | null>(null);
  const [subAction, setSubAction] = useState<"CHANGE_PLAN" | "EXTEND_TRIAL" | "CHANGE_STATUS" | "ADJUST_BILLING">("CHANGE_PLAN");
  const [targetPlanId, setTargetPlanId] = useState("GROWTH");
  const [extendDays, setExtendDays] = useState(14);
  const [targetSubStatus, setTargetSubStatus] = useState("ACTIVE");
  const [targetBillingInterval, setTargetBillingInterval] = useState("MONTHLY");
  const [subReason, setSubReason] = useState("");
  const [subConfirmed, setSubConfirmed] = useState(false);
  const [submittingSub, setSubmittingSub] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  // Selected hotel for inspection modal
  const [inspectingHotelId, setInspectingHotelId] = useState<string | null>(null);
  const [inspectedHotel, setInspectedHotel] = useState<any | null>(null);
  const [loadingInspection, setLoadingInspection] = useState(false);

  // Lifecycle status modal state
  const [lifecycleHotel, setLifecycleHotel] = useState<HotelSummary | null>(null);
  const [targetStatus, setTargetStatus] = useState<HotelStatus | "">("");
  const [statusReason, setStatusReason] = useState("");
  const [confirmCheckbox, setConfirmCheckbox] = useState(false);
  const [submittingStatus, setSubmittingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Load Overview Data
  const loadOverview = useCallback(async () => {
    try {
      setLoadingOverview(true);
      const res = await fetch("/api/platform/overview");
      if (!res.ok) throw new Error("Failed to load platform overview");
      const data = await res.json();
      setMetrics(data.metrics);
      setRecentHotels(data.recentHotels || []);
      setAuditLogs(data.recentAuditLogs || []);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  // Load Directory Data
  const loadHotels = useCallback(async () => {
    try {
      setLoadingHotels(true);
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      params.set("page", page.toString());
      params.set("limit", "15");

      const res = await fetch(`/api/platform/hotels?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load hotel directory");
      const data = await res.json();
      setHotels(data.hotels || []);
      setTotalPages(data.totalPages || 1);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingHotels(false);
    }
  }, [search, statusFilter, page]);

  const loadSubscriptions = useCallback(async () => {
    try {
      setLoadingSubs(true);
      const params = new URLSearchParams();
      if (subSearch.trim()) params.set("q", subSearch.trim());
      if (subStatusFilter !== "ALL") params.set("status", subStatusFilter);
      if (subPlanFilter !== "ALL") params.set("plan", subPlanFilter);

      const res = await fetch(`/api/platform/subscriptions?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load subscriptions");
      const data = await res.json();
      setSubscriptions(data.subscriptions || []);
      setSubSummary(data.summary || null);
      setAvailablePlans(data.availablePlans || []);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingSubs(false);
    }
  }, [subSearch, subStatusFilter, subPlanFilter]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadHotels();
  }, [loadHotels]);

  useEffect(() => {
    if (tab === "subscriptions") {
      loadSubscriptions();
    }
  }, [tab, loadSubscriptions]);

  // Handle subscription update submit
  const handleUpdateSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managingSubHotel) return;
    setSubmittingSub(true);
    setSubError(null);

    try {
      const payload: any = {
        action: subAction,
        reason: subReason.trim(),
        confirmed: subConfirmed,
      };

      if (subAction === "CHANGE_PLAN") payload.planId = targetPlanId;
      else if (subAction === "EXTEND_TRIAL") payload.extendDays = extendDays;
      else if (subAction === "CHANGE_STATUS") payload.newStatus = targetSubStatus;
      else if (subAction === "ADJUST_BILLING") payload.billingInterval = targetBillingInterval;

      const res = await fetch(`/api/platform/hotels/${managingSubHotel.hotelId}/subscription`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to update subscription");
      }

      setSuccessToast(`Subscription updated successfully for ${managingSubHotel.hotelName}.`);
      setManagingSubHotel(null);
      loadSubscriptions();
      loadOverview();
      loadHotels();
      setTimeout(() => setSuccessToast(null), 4000);
    } catch (err: any) {
      setSubError(err.message || "Failed to submit subscription changes.");
    } finally {
      setSubmittingSub(false);
    }
  };

  // Handle hotel inspection
  const handleInspect = async (hotelId: string) => {
    setInspectingHotelId(hotelId);
    setLoadingInspection(true);
    try {
      const res = await fetch(`/api/platform/hotels/${hotelId}`);
      if (!res.ok) throw new Error("Failed to inspect hotel");
      const data = await res.json();
      setInspectedHotel(data);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingInspection(false);
    }
  };

  // Open lifecycle modal
  const openLifecycleModal = (hotel: HotelSummary) => {
    setLifecycleHotel(hotel);
    setTargetStatus("");
    setStatusReason("");
    setConfirmCheckbox(false);
    setStatusError(null);
  };

  // Submit lifecycle status change
  const handleStatusSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lifecycleHotel || !targetStatus) return;

    if (
      (targetStatus === "SUSPENDED" || targetStatus === "CANCELLED") &&
      (!confirmCheckbox || statusReason.trim().length < 5)
    ) {
      setStatusError("Explicit confirmation and a reason of at least 5 characters are required.");
      return;
    }

    setSubmittingStatus(true);
    setStatusError(null);

    try {
      const res = await fetch(`/api/platform/hotels/${lifecycleHotel.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: targetStatus,
          reason: statusReason.trim(),
          confirmed: confirmCheckbox,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to update lifecycle status");
      }

      setSuccessToast(data.message || "Hotel lifecycle status updated successfully.");
      setTimeout(() => setSuccessToast(null), 6000);
      setLifecycleHotel(null);
      loadHotels();
      loadOverview();
      loadSubscriptions();
    } catch (err: any) {
      setStatusError(err.message || "Failed to update hotel status");
    } finally {
      setSubmittingStatus(false);
    }
  };

  const getStatusBadge = (status: HotelStatus) => {
    switch (status) {
      case "ACTIVE":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 size={12} /> Active
          </span>
        );
      case "TRIALING":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <Clock size={12} /> Trialing
          </span>
        );
      case "SUSPENDED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
            <AlertTriangle size={12} /> Suspended
          </span>
        );
      case "CANCELLED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">
            <XCircle size={12} /> Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-800">
            {status}
          </span>
        );
    }
  };

  const getPlanBadge = (planId: string) => {
    switch (planId?.toUpperCase()) {
      case "ENTERPRISE":
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-800 border border-purple-200">
            Enterprise
          </span>
        );
      case "GROWTH":
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200">
            Growth
          </span>
        );
      case "STARTER":
      default:
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-800 border border-slate-200">
            Starter
          </span>
        );
    }
  };

  const getSubStatusBadge = (effectiveStatus: string, isOverdue: boolean) => {
    if (isOverdue || effectiveStatus === "PAST_DUE" || effectiveStatus === "TRIAL_EXPIRED") {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-200">
          <AlertTriangle size={12} /> {effectiveStatus === "TRIAL_EXPIRED" ? "Trial Expired" : "Past Due"}
        </span>
      );
    }
    switch (effectiveStatus) {
      case "ACTIVE":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 size={12} /> Active
          </span>
        );
      case "TRIALING":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <Clock size={12} /> Trialing
          </span>
        );
      case "SUSPENDED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
            <AlertTriangle size={12} /> Suspended
          </span>
        );
      case "CANCELLED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">
            <XCircle size={12} /> Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-800">
            {effectiveStatus}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast alert */}
      {successToast && (
        <div className="p-4 rounded-control bg-emerald-50 border border-emerald-200 text-emerald-900 flex items-center justify-between animate-fadeIn">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
            <span className="text-sm font-medium">{successToast}</span>
          </div>
          <button
            onClick={() => setSuccessToast(null)}
            className="text-xs text-emerald-700 hover:text-emerald-900 underline font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Title & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-border">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Platform Administration</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Manage multi-tenant hotel workspaces, inspect system health, and control operational lifecycles.
          </p>
        </div>

        {/* Tab Controls */}
        <div className="flex items-center bg-surface border border-border rounded-control p-1">
          <button
            onClick={() => setTab("overview")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-control transition-colors ${
              tab === "overview"
                ? "bg-primary-500 text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setTab("directory")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-control transition-colors ${
              tab === "directory"
                ? "bg-primary-500 text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Hotel Directory
          </button>
          <button
            onClick={() => {
              setTab("subscriptions");
              loadSubscriptions();
            }}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-control transition-colors ${
              tab === "subscriptions"
                ? "bg-primary-500 text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Subscriptions & Plans
          </button>
          <button
            onClick={() => setTab("audit")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-control transition-colors ${
              tab === "audit"
                ? "bg-primary-500 text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Audit Trail
          </button>
        </div>
      </div>

      {/* TAB 1: OVERVIEW */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* Key Metrics Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <div className="bg-surface border border-border rounded-card p-4 shadow-sm">
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                Total Hotels
              </span>
              <p className="text-2xl font-bold text-text-primary mt-1">
                {metrics ? metrics.totalHotels : "..."}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-text-secondary mt-1">
                <Building2 size={12} /> Workspaces
              </div>
            </div>

            <div className="bg-surface border border-emerald-200 rounded-card p-4 shadow-sm bg-emerald-50/20">
              <span className="text-xs font-medium text-emerald-800 uppercase tracking-wider">
                Active
              </span>
              <p className="text-2xl font-bold text-emerald-700 mt-1">
                {metrics ? metrics.activeHotels : "..."}
              </p>
              <span className="text-[11px] text-emerald-600">Operating normally</span>
            </div>

            <div className="bg-surface border border-blue-200 rounded-card p-4 shadow-sm bg-blue-50/20">
              <span className="text-xs font-medium text-blue-800 uppercase tracking-wider">
                Trialing
              </span>
              <p className="text-2xl font-bold text-blue-700 mt-1">
                {metrics ? metrics.trialingHotels : "..."}
              </p>
              <span className="text-[11px] text-blue-600">Onboarding trial</span>
            </div>

            <div className="bg-surface border border-amber-200 rounded-card p-4 shadow-sm bg-amber-50/20">
              <span className="text-xs font-medium text-amber-800 uppercase tracking-wider">
                Suspended
              </span>
              <p className="text-2xl font-bold text-amber-700 mt-1">
                {metrics ? metrics.suspendedHotels : "..."}
              </p>
              <span className="text-[11px] text-amber-600">Operations locked</span>
            </div>

            <div className="bg-surface border border-red-200 rounded-card p-4 shadow-sm bg-red-50/20">
              <span className="text-xs font-medium text-red-800 uppercase tracking-wider">
                Cancelled
              </span>
              <p className="text-2xl font-bold text-red-700 mt-1">
                {metrics ? metrics.cancelledHotels : "..."}
              </p>
              <span className="text-[11px] text-red-600">Deactivated</span>
            </div>

            <div className="bg-surface border border-border rounded-card p-4 shadow-sm">
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                Total Users
              </span>
              <p className="text-2xl font-bold text-text-primary mt-1">
                {metrics ? metrics.totalUsers : "..."}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-text-secondary mt-1">
                <Users size={12} /> Across all tenants
              </div>
            </div>

            <div className="bg-surface border border-border rounded-card p-4 shadow-sm">
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                Total Rooms
              </span>
              <p className="text-2xl font-bold text-text-primary mt-1">
                {metrics ? metrics.totalRooms : "..."}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-text-secondary mt-1">
                <BedDouble size={12} /> Managed inventory
              </div>
            </div>
          </div>

          {/* Quick Actions & Recent Registrations */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Registrations Card */}
            <div className="bg-surface border border-border rounded-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Building2 size={18} className="text-primary-500" />
                  <h3 className="font-semibold text-text-primary text-base">Recent Hotel Workspaces</h3>
                </div>
                <button
                  onClick={() => setTab("directory")}
                  className="text-xs font-medium text-primary-600 hover:underline"
                >
                  View All Directory &rarr;
                </button>
              </div>

              {recentHotels.length === 0 ? (
                <p className="text-sm text-text-secondary py-6 text-center">No hotels registered yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {recentHotels.map((h, idx) => (
                    <div key={`recent-hotel-${h.id || idx}`} className="py-3 flex items-center justify-between text-sm">
                      <div>
                        <p className="font-medium text-text-primary">{h.name}</p>
                        <p className="text-xs text-text-secondary font-mono">
                          /{h.slug} &bull; {h.owner ? `${h.owner.name} (${h.owner.email})` : "No owner"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {getStatusBadge(h.status)}
                        <span className="text-xs text-text-muted">
                          {new Date(h.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Platform Audit Events Card */}
            <div className="bg-surface border border-border rounded-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Shield size={18} className="text-primary-500" />
                  <h3 className="font-semibold text-text-primary text-base">Platform Activity & Audit</h3>
                </div>
                <button
                  onClick={() => setTab("audit")}
                  className="text-xs font-medium text-primary-600 hover:underline"
                >
                  Full Audit Trail &rarr;
                </button>
              </div>

              {auditLogs.length === 0 ? (
                <p className="text-sm text-text-secondary py-6 text-center">No platform activity recorded.</p>
              ) : (
                <div className="divide-y divide-border">
                  {auditLogs.slice(0, 6).map((log, idx) => (
                    <div key={`platform-log-${log.id || 'item'}-${idx}-${log.createdAt || idx}`} className="py-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-800">
                          {log.action}
                        </span>
                        <span className="text-xs text-text-muted">
                          {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} &bull;{" "}
                          {new Date(log.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary mt-1">
                        Actor: <strong className="text-text-primary">{log.userName}</strong> &bull; Target:{" "}
                        <strong>{log.hotelName}</strong>
                      </p>
                      {log.metadata?.reason && (
                        <p className="text-xs text-text-secondary italic mt-0.5">
                          Reason: &ldquo;{log.metadata.reason}&rdquo;
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: HOTEL DIRECTORY */}
      {tab === "directory" && (
        <div className="space-y-4">
          {/* Search & Filters */}
          <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
              <input
                type="text"
                placeholder="Search hotel name or slug..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="w-full pl-9 pr-3 py-2 text-sm rounded-control border border-border focus:outline-none focus:ring-1 focus:ring-primary-500 bg-bg/50"
              />
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <Filter size={14} />
                <span>Status:</span>
              </div>
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                className="text-xs rounded-control border border-border py-2 px-3 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
              >
                <option value="ALL">All Statuses</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="TRIALING">TRIALING</option>
                <option value="SUSPENDED">SUSPENDED</option>
                <option value="CANCELLED">CANCELLED</option>
              </select>

              <button
                onClick={() => {
                  loadHotels();
                  loadOverview();
                }}
                title="Refresh Directory"
                className="p-2 border border-border rounded-control hover:bg-bg text-text-secondary transition-colors"
              >
                <RefreshCw size={14} className={loadingHotels ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          {/* Directory Table */}
          <div className="bg-surface border border-border rounded-card shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg border-b border-border text-xs text-text-secondary uppercase">
                  <tr>
                    <th className="py-3 px-4 font-semibold">Hotel Workspace</th>
                    <th className="py-3 px-4 font-semibold">Lifecycle Status</th>
                    <th className="py-3 px-4 font-semibold">Owner & Contact</th>
                    <th className="py-3 px-4 font-semibold">Capacity</th>
                    <th className="py-3 px-4 font-semibold">Created</th>
                    <th className="py-3 px-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loadingHotels ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-text-secondary text-sm">
                        <RefreshCw size={18} className="animate-spin mx-auto mb-2 text-primary-500" />
                        Loading hotel directory...
                      </td>
                    </tr>
                  ) : hotels.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-text-secondary text-sm">
                        No hotels found matching criteria.
                      </td>
                    </tr>
                  ) : (
                    hotels.map((h, idx) => (
                      <tr key={`hotel-row-${h.id || idx}`} className="hover:bg-bg/40 transition-colors">
                        <td className="py-3.5 px-4">
                          <p className="font-semibold text-text-primary">{h.name}</p>
                          <span className="text-xs font-mono text-text-secondary">/{h.slug}</span>
                          <span className="text-xs text-text-muted ml-2">
                            ({h.currency} &bull; {h.timezone})
                          </span>
                        </td>
                        <td className="py-3.5 px-4">{getStatusBadge(h.status)}</td>
                        <td className="py-3.5 px-4">
                          {h.owner ? (
                            <div>
                              <p className="font-medium text-text-primary text-xs">{h.owner.name}</p>
                              <p className="text-xs text-text-secondary">{h.owner.email}</p>
                            </div>
                          ) : (
                            <span className="text-xs text-text-muted italic">No Owner Assigned</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="text-xs text-text-secondary">
                            <span>{h.roomCount} rooms</span> &bull; <span>{h.memberCount} staff</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-xs text-text-secondary">
                          {new Date(h.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              onClick={() => handleInspect(h.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded-control border border-border hover:bg-bg text-text-secondary hover:text-text-primary transition-colors"
                              title="Inspect hotel operational status without switching active session"
                            >
                              Inspect
                            </button>
                            <button
                              onClick={() => openLifecycleModal(h)}
                              className="px-2.5 py-1 text-xs font-semibold rounded-control bg-primary-500 text-white hover:bg-primary-600 transition-colors"
                            >
                              Lifecycle
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="p-4 border-t border-border flex items-center justify-between text-xs text-text-secondary">
                <span>
                  Page {page} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-bg"
                  >
                    Previous
                  </button>
                  <button
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="px-3 py-1 rounded border border-border disabled:opacity-40 hover:bg-bg"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: SUBSCRIPTIONS & PLANS */}
      {tab === "subscriptions" && (
        <div className="space-y-6">
          {/* Subscriptions Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="bg-surface border border-border rounded-card p-4 shadow-sm">
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                Total Subscriptions
              </span>
              <p className="text-2xl font-bold text-text-primary mt-1">
                {subSummary ? subSummary.totalHotels : "..."}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-text-secondary mt-1">
                <CreditCard size={12} /> Workspaces
              </div>
            </div>

            <div className="bg-surface border border-emerald-200 rounded-card p-4 shadow-sm bg-emerald-50/20">
              <span className="text-xs font-medium text-emerald-800 uppercase tracking-wider">
                Active
              </span>
              <p className="text-2xl font-bold text-emerald-700 mt-1">
                {subSummary ? subSummary.activeCount : "..."}
              </p>
              <span className="text-[11px] text-emerald-600">Paid billing</span>
            </div>

            <div className="bg-surface border border-blue-200 rounded-card p-4 shadow-sm bg-blue-50/20">
              <span className="text-xs font-medium text-blue-800 uppercase tracking-wider">
                Trialing
              </span>
              <p className="text-2xl font-bold text-blue-700 mt-1">
                {subSummary ? subSummary.trialingCount : "..."}
              </p>
              <span className="text-[11px] text-blue-600">Evaluating SaaS</span>
            </div>

            <div className="bg-surface border border-amber-200 rounded-card p-4 shadow-sm bg-amber-50/20">
              <span className="text-xs font-medium text-amber-800 uppercase tracking-wider">
                Expiring Soon
              </span>
              <p className="text-2xl font-bold text-amber-700 mt-1">
                {subSummary ? subSummary.expiringSoonCount : "..."}
              </p>
              <span className="text-[11px] text-amber-600">&le; 7 days left</span>
            </div>

            <div className="bg-surface border border-rose-200 rounded-card p-4 shadow-sm bg-rose-50/20">
              <span className="text-xs font-medium text-rose-800 uppercase tracking-wider">
                Overdue / Past Due
              </span>
              <p className="text-2xl font-bold text-rose-700 mt-1">
                {subSummary ? subSummary.overdueCount : "..."}
              </p>
              <span className="text-[11px] text-rose-600">Requires renewal</span>
            </div>

            <div className="bg-surface border border-gray-200 rounded-card p-4 shadow-sm bg-gray-50/30">
              <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                Suspended
              </span>
              <p className="text-2xl font-bold text-text-secondary mt-1">
                {subSummary ? subSummary.suspendedCount : "..."}
              </p>
              <span className="text-[11px] text-text-muted">Access held</span>
            </div>
          </div>

          {/* Search & Filters */}
          <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col sm:flex-row gap-3 items-center justify-between">
            <div className="flex-1 w-full sm:w-auto relative">
              <Search className="absolute left-3 top-2.5 text-text-secondary" size={16} />
              <input
                type="text"
                placeholder="Search hotel subscriptions by name or slug..."
                value={subSearch}
                onChange={(e) => setSubSearch(e.target.value)}
                className="w-full text-xs pl-9 pr-3 py-2 rounded-control border border-border bg-bg/50 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <Filter size={14} />
                <span>Status:</span>
              </div>
              <select
                value={subStatusFilter}
                onChange={(e) => setSubStatusFilter(e.target.value)}
                className="text-xs rounded-control border border-border px-2.5 py-2 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500"
              >
                <option value="ALL">All Statuses</option>
                <option value="TRIALING">Trialing</option>
                <option value="ACTIVE">Active</option>
                <option value="PAST_DUE">Past Due</option>
                <option value="TRIAL_EXPIRED">Trial Expired</option>
                <option value="SUSPENDED">Suspended</option>
                <option value="CANCELLED">Cancelled</option>
              </select>

              <select
                value={subPlanFilter}
                onChange={(e) => setSubPlanFilter(e.target.value)}
                className="text-xs rounded-control border border-border px-2.5 py-2 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500"
              >
                <option value="ALL">All Plans</option>
                <option value="STARTER">Starter Tier</option>
                <option value="GROWTH">Growth Tier</option>
                <option value="ENTERPRISE">Enterprise Tier</option>
              </select>

              <button
                onClick={loadSubscriptions}
                className="p-2 border border-border rounded-control hover:bg-bg text-text-secondary"
                title="Refresh subscriptions"
              >
                <RefreshCw size={14} className={loadingSubs ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          {/* Subscriptions Table */}
          <div className="bg-surface border border-border rounded-card overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg border-b border-border text-xs text-text-secondary uppercase">
                  <tr>
                    <th className="py-3 px-4 font-semibold">Hotel Workspace</th>
                    <th className="py-3 px-4 font-semibold">Assigned Plan</th>
                    <th className="py-3 px-4 font-semibold">Subscription State</th>
                    <th className="py-3 px-4 font-semibold">Period / Expiration</th>
                    <th className="py-3 px-4 font-semibold">Usage & Limits</th>
                    <th className="py-3 px-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loadingSubs ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-text-secondary">
                        <RefreshCw size={20} className="animate-spin inline-block mb-1" />
                        <p className="text-xs">Loading subscriptions...</p>
                      </td>
                    </tr>
                  ) : subscriptions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-text-secondary text-sm">
                        No hotel subscriptions found matching filter criteria.
                      </td>
                    </tr>
                  ) : (
                    subscriptions.map((sub, idx) => (
                      <tr key={`sub-row-${sub.hotelId || idx}`} className="hover:bg-bg/40 transition-colors">
                        <td className="py-3.5 px-4">
                          <p className="font-semibold text-text-primary">{sub.hotelName}</p>
                          <span className="text-xs font-mono text-text-secondary">/{sub.hotelSlug}</span>
                          <span className="text-xs text-text-muted ml-2">({sub.currency})</span>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="flex flex-col gap-0.5">
                            {getPlanBadge(sub.subscription.planId)}
                            <span className="text-[11px] text-text-secondary font-mono mt-0.5">
                              {formatPlatformPrice(sub.subscription.amountExact, sub.subscription.currency, sub.currency)} / {sub.subscription.billingInterval.toLowerCase()}
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          {getSubStatusBadge(sub.subscription.effectiveStatus, sub.subscription.isOverdue)}
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          {sub.subscription.effectiveStatus === "TRIALING" ? (
                            <div>
                              <p className="font-medium text-blue-700">
                                {sub.subscription.daysRemaining !== null
                                  ? `${sub.subscription.daysRemaining} days remaining`
                                  : "Trial Active"}
                              </p>
                              <span className="text-[11px] text-text-muted">
                                Ends: {sub.subscription.trialEndsAt ? new Date(sub.subscription.trialEndsAt).toLocaleDateString() : "—"}
                              </span>
                            </div>
                          ) : sub.subscription.isOverdue ? (
                            <div>
                              <p className="font-semibold text-rose-700">Overdue / Past Due</p>
                              <span className="text-[11px] text-text-muted">Grace period</span>
                            </div>
                          ) : (
                            <div>
                              <p className="font-medium text-text-primary">
                                {sub.subscription.daysRemaining !== null
                                  ? `${sub.subscription.daysRemaining} days in period`
                                  : "Active"}
                              </p>
                              <span className="text-[11px] text-text-muted">
                                Renews: {sub.subscription.currentPeriodEndsAt ? new Date(sub.subscription.currentPeriodEndsAt).toLocaleDateString() : "—"}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs font-mono">
                          <div className="space-y-0.5">
                            <div>
                              <span className="text-text-secondary">Rooms: </span>
                              <strong className="text-text-primary">
                                {sub.usage.rooms.current} / {isFinite(sub.usage.rooms.max) ? sub.usage.rooms.max : "Unlimited"}
                              </strong>
                            </div>
                            <div>
                              <span className="text-text-secondary">Staff: </span>
                              <strong className="text-text-primary">
                                {sub.usage.staff.current} / {isFinite(sub.usage.staff.max) ? sub.usage.staff.max : "Unlimited"}
                              </strong>
                            </div>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <button
                            onClick={() => {
                              setManagingSubHotel(sub);
                              setSubAction("CHANGE_PLAN");
                              setTargetPlanId(sub.subscription.planId || "GROWTH");
                              setTargetSubStatus(sub.subscription.storedStatus || "ACTIVE");
                              setSubReason("");
                              setSubConfirmed(false);
                              setSubError(null);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-control border border-primary-300 text-primary-700 hover:bg-primary-50 transition-colors"
                          >
                            <CreditCard size={13} />
                            <span>Manage Plan</span>
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: AUDIT TRAIL */}
      {tab === "audit" && (
        <div className="bg-surface border border-border rounded-card p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-text-primary text-base">Administrative Audit Trail</h3>
              <p className="text-xs text-text-secondary">
                Accountability records of platform actions, lifecycle modifications, and target hotels.
              </p>
            </div>
            <button
              onClick={loadOverview}
              className="p-1.5 border border-border rounded-control hover:bg-bg text-text-secondary"
            >
              <RefreshCw size={14} className={loadingOverview ? "animate-spin" : ""} />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg border-b border-border text-xs text-text-secondary uppercase">
                <tr>
                  <th className="py-3 px-4 font-semibold">Timestamp</th>
                  <th className="py-3 px-4 font-semibold">Action</th>
                  <th className="py-3 px-4 font-semibold">Target Hotel</th>
                  <th className="py-3 px-4 font-semibold">Platform Actor</th>
                  <th className="py-3 px-4 font-semibold">Metadata & Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-text-secondary">
                      No administrative audit logs found.
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log, idx) => (
                    <tr key={`platform-tr-${log.id || 'item'}-${idx}-${log.createdAt || idx}`} className="hover:bg-bg/40 text-xs">
                      <td className="py-3 px-4 text-text-secondary whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-primary-600">
                        {log.action}
                      </td>
                      <td className="py-3 px-4 font-medium text-text-primary">
                        {log.hotelName}
                        {log.hotelSlug && <span className="font-mono text-text-secondary ml-1">({log.hotelSlug})</span>}
                      </td>
                      <td className="py-3 px-4 text-text-primary">
                        {log.userName}
                        {log.userEmail && <span className="text-text-secondary block">{log.userEmail}</span>}
                      </td>
                      <td className="py-3 px-4 text-text-secondary max-w-xs truncate">
                        {log.metadata ? (
                          <span>
                            {log.metadata.previousStatus && (
                              <span>
                                {log.metadata.previousStatus} &rarr; {log.metadata.newStatus}.{" "}
                              </span>
                            )}
                            {log.metadata.reason && <em>&ldquo;{log.metadata.reason}&rdquo;</em>}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* INSPECT HOTEL MODAL */}
      {inspectingHotelId && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-card max-w-2xl w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto space-y-5">
            <div className="flex items-start justify-between border-b border-border pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <Building2 size={20} className="text-primary-500" />
                  <h2 className="text-lg font-bold text-text-primary">
                    {inspectedHotel ? inspectedHotel.hotel.name : "Inspecting Hotel..."}
                  </h2>
                </div>
                <p className="text-xs text-text-secondary mt-0.5 font-mono">
                  ID: {inspectingHotelId} &bull; Slug: /{inspectedHotel?.hotel.slug}
                </p>
              </div>
              <button
                onClick={() => {
                  setInspectingHotelId(null);
                  setInspectedHotel(null);
                }}
                className="text-text-secondary hover:text-text-primary p-1"
              >
                &times;
              </button>
            </div>

            {loadingInspection ? (
              <div className="py-12 text-center text-text-secondary">
                <RefreshCw size={24} className="animate-spin mx-auto mb-2 text-primary-500" />
                <p className="text-sm">Fetching operational hotel inspection data...</p>
              </div>
            ) : inspectedHotel ? (
              <div className="space-y-4">
                {/* Security Isolation Notice */}
                <div className="p-3 rounded-control bg-blue-50 border border-blue-200 text-blue-900 text-xs flex items-center gap-2">
                  <Info size={16} className="text-blue-600 shrink-0" />
                  <span>
                    <strong>Platform Isolation:</strong> You are viewing hotel metadata directly from the database.
                    No tenant workspace was entered and no active session cookies were modified.
                  </span>
                </div>

                {/* Status & Operational Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                  <div className="p-3 rounded-control bg-bg border border-border">
                    <span className="text-[11px] text-text-secondary uppercase">Status</span>
                    <div className="mt-1">{getStatusBadge(inspectedHotel.hotel.status)}</div>
                  </div>
                  <div className="p-3 rounded-control bg-bg border border-border">
                    <span className="text-[11px] text-text-secondary uppercase">Rooms</span>
                    <p className="text-lg font-bold text-text-primary mt-1">{inspectedHotel.stats.roomsCount}</p>
                  </div>
                  <div className="p-3 rounded-control bg-bg border border-border">
                    <span className="text-[11px] text-text-secondary uppercase">Staff Members</span>
                    <p className="text-lg font-bold text-text-primary mt-1">{inspectedHotel.stats.membershipsCount}</p>
                  </div>
                  <div className="p-3 rounded-control bg-bg border border-border">
                    <span className="text-[11px] text-text-secondary uppercase">Reservations</span>
                    <p className="text-lg font-bold text-text-primary mt-1">{inspectedHotel.stats.reservationsCount}</p>
                  </div>
                </div>

                {/* Hotel Details */}
                <div className="border border-border rounded-control p-4 space-y-2 text-xs">
                  <h4 className="font-semibold text-text-primary text-sm mb-2">Workspace Information</h4>
                  <div className="grid grid-cols-2 gap-2 text-text-secondary">
                    <div>
                      <strong className="text-text-primary">Currency:</strong> {inspectedHotel.hotel.currency}
                    </div>
                    <div>
                      <strong className="text-text-primary">Timezone:</strong> {inspectedHotel.hotel.timezone}
                    </div>
                    <div>
                      <strong className="text-text-primary">Contact Email:</strong>{" "}
                      {inspectedHotel.hotel.contactEmail || "—"}
                    </div>
                    <div>
                      <strong className="text-text-primary">Contact Phone:</strong>{" "}
                      {inspectedHotel.hotel.contactPhone || "—"}
                    </div>
                    <div className="col-span-2">
                      <strong className="text-text-primary">Address:</strong>{" "}
                      {inspectedHotel.hotel.address || "—"}
                    </div>
                  </div>
                </div>

                {/* Staff Members List */}
                <div className="border border-border rounded-control p-4 space-y-2 text-xs">
                  <h4 className="font-semibold text-text-primary text-sm mb-2">Staff Memberships</h4>
                  {inspectedHotel.memberships.length === 0 ? (
                    <p className="text-text-secondary">No members found.</p>
                  ) : (
                    <div className="divide-y divide-border max-h-40 overflow-y-auto">
                      {inspectedHotel.memberships.map((m: any, idx: number) => (
                        <div key={`member-${m.id || idx}`} className="py-2 flex items-center justify-between">
                          <div>
                            <span className="font-medium text-text-primary">{m.user.name}</span>
                            <span className="text-text-secondary ml-1">({m.user.email})</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-800">
                              {m.role}
                            </span>
                            <span className="text-[10px] text-text-secondary">{m.status}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Subscription & Entitlements Card */}
                {inspectedHotel.subscription && (
                  <div className="border border-border rounded-control p-4 space-y-3 bg-bg/30 text-xs">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-text-primary text-sm flex items-center gap-1.5">
                        <CreditCard size={15} /> SaaS Subscription & Plan
                      </h4>
                      {getPlanBadge(inspectedHotel.subscription.planId)}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
                      <div className="p-2 rounded bg-surface border border-border">
                        <span className="text-text-secondary text-[10px] block uppercase">Status</span>
                        <strong className="text-text-primary text-xs">
                          {inspectedHotel.subscription.effectiveStatus}
                        </strong>
                      </div>
                      <div className="p-2 rounded bg-surface border border-border">
                        <span className="text-text-secondary text-[10px] block uppercase">Days Left</span>
                        <strong className="text-text-primary text-xs">
                          {inspectedHotel.subscription.daysRemaining !== null
                            ? `${inspectedHotel.subscription.daysRemaining} days`
                            : "Active"}
                        </strong>
                      </div>
                      <div className="p-2 rounded bg-surface border border-border">
                        <span className="text-text-secondary text-[10px] block uppercase">Room Limit</span>
                        <strong className="text-text-primary text-xs">
                          {inspectedHotel.stats.roomsCount} /{" "}
                          {isFinite(inspectedHotel.subscription.limits?.maxRooms)
                            ? inspectedHotel.subscription.limits.maxRooms
                            : "Unlimited"}
                        </strong>
                      </div>
                      <div className="p-2 rounded bg-surface border border-border">
                        <span className="text-text-secondary text-[10px] block uppercase">Staff Limit</span>
                        <strong className="text-text-primary text-xs">
                          {inspectedHotel.stats.membershipsCount} /{" "}
                          {isFinite(inspectedHotel.subscription.limits?.maxStaff)
                            ? inspectedHotel.subscription.limits.maxStaff
                            : "Unlimited"}
                        </strong>
                      </div>
                    </div>
                    {inspectedHotel.subscription.modules && (
                      <div>
                        <span className="text-[11px] font-semibold text-text-secondary block mb-1">
                          Enabled Plan Modules:
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {inspectedHotel.subscription.modules.map((m: string) => (
                            <span
                              key={m}
                              className="px-2 py-0.5 rounded text-[10px] font-mono bg-primary-50 text-primary-700 border border-primary-200"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => {
                      setInspectingHotelId(null);
                      setInspectedHotel(null);
                    }}
                    className="px-4 py-2 text-xs font-semibold rounded-control bg-primary-500 text-white hover:bg-primary-600 transition-colors"
                  >
                    Close Inspection
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* MANAGE SUBSCRIPTION MODAL */}
      {managingSubHotel && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-card max-w-lg w-full p-6 shadow-xl space-y-5 animate-fadeIn">
            <div className="flex items-start justify-between border-b border-border pb-3">
              <div>
                <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
                  <CreditCard size={18} /> Manage Plan & Subscription
                </h2>
                <p className="text-xs text-text-secondary mt-0.5 font-mono">
                  Hotel: {managingSubHotel.hotelName} (/{managingSubHotel.hotelSlug})
                </p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Current price: {formatPlatformPrice(managingSubHotel.subscription.amountExact, managingSubHotel.subscription.currency, managingSubHotel.currency)} / {managingSubHotel.subscription.billingInterval.toLowerCase()}
                </p>
              </div>
              <button
                onClick={() => setManagingSubHotel(null)}
                className="text-text-secondary hover:text-text-primary text-lg"
              >
                &times;
              </button>
            </div>

            {subError && (
              <div className="p-3 rounded-control bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-2">
                <AlertTriangle size={15} />
                <span>{subError}</span>
              </div>
            )}

            <form onSubmit={handleUpdateSubscription} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">
                  Administrative Adjustment Action
                </label>
                <select
                  value={subAction}
                  onChange={(e) => setSubAction(e.target.value as any)}
                  className="w-full text-xs rounded-control border border-border p-2.5 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
                >
                  <option value="CHANGE_PLAN">Change Room Band (1–10, 11–25, 26–50, 51–100, 101–200, 201+)</option>
                  <option value="EXTEND_TRIAL">Extend Trial Period (+7, +14, +30 days)</option>
                  <option value="CHANGE_STATUS">Override Subscription Status (Active, Suspended...)</option>
                  <option value="ADJUST_BILLING">Adjust Billing Interval (Monthly / Yearly)</option>
                </select>
              </div>

              {subAction === "CHANGE_PLAN" && (
                <div>
                  <label className="block text-xs font-semibold text-text-primary mb-1">
                    Select New Room Band / Plan Tier
                  </label>
                  <select
                    value={targetPlanId}
                    onChange={(e) => setTargetPlanId(e.target.value)}
                    className="w-full text-xs rounded-control border border-border p-2.5 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
                  >
                    <optgroup label="Standard Room Bands">
                      <option value="BAND_1_10">Band 1: 1–10 Rooms (Boutique / B&B)</option>
                      <option value="BAND_11_25">Band 2: 11–25 Rooms (Standard / Guest House)</option>
                      <option value="BAND_26_50">Band 3: 26–50 Rooms (Medium Hotel)</option>
                      <option value="BAND_51_100">Band 4: 51–100 Rooms (Large Hotel)</option>
                      <option value="BAND_101_200">Band 5: 101–200 Rooms (Resort)</option>
                      <option value="BAND_201_PLUS">Band 6: 201+ Rooms (Custom Enterprise Quote)</option>
                    </optgroup>
                    <optgroup label="Legacy Tiers (Backward Compatibility)">
                      <option value="STARTER">Starter Tier (Legacy)</option>
                      <option value="GROWTH">Growth Tier (Legacy)</option>
                      <option value="ENTERPRISE">Enterprise Tier (Legacy)</option>
                    </optgroup>
                  </select>
                  <span className="text-[11px] text-text-secondary mt-1 block">
                    Current tier / band: <strong>{managingSubHotel.subscription.planName}</strong>
                  </span>
                </div>
              )}

              {subAction === "EXTEND_TRIAL" && (
                <div>
                  <label className="block text-xs font-semibold text-text-primary mb-1">
                    Extend Trial By Days
                  </label>
                  <select
                    value={extendDays}
                    onChange={(e) => setExtendDays(Number(e.target.value))}
                    className="w-full text-xs rounded-control border border-border p-2.5 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
                  >
                    <option value={7}>+7 Days Extension</option>
                    <option value={14}>+14 Days Extension</option>
                    <option value={30}>+30 Days Extension</option>
                    <option value={60}>+60 Days Extension</option>
                  </select>
                  <span className="text-[11px] text-text-secondary mt-1 block">
                    Current trial end: {managingSubHotel.subscription.trialEndsAt ? new Date(managingSubHotel.subscription.trialEndsAt).toLocaleDateString() : "No trial date"}
                  </span>
                </div>
              )}

              {subAction === "CHANGE_STATUS" && (
                <div>
                  <label className="block text-xs font-semibold text-text-primary mb-1">
                    Select Subscription Status
                  </label>
                  <select
                    value={targetSubStatus}
                    onChange={(e) => setTargetSubStatus(e.target.value)}
                    className="w-full text-xs rounded-control border border-border p-2.5 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
                  >
                    <option value="ACTIVE">ACTIVE (Paid & operational)</option>
                    <option value="TRIALING">TRIALING (In active evaluation)</option>
                    <option value="PAST_DUE">PAST_DUE (Overdue grace period)</option>
                    <option value="SUSPENDED">SUSPENDED (Billing lock)</option>
                    <option value="CANCELLED">CANCELLED (Terminated)</option>
                  </select>
                </div>
              )}

              {subAction === "ADJUST_BILLING" && (
                <div>
                  <label className="block text-xs font-semibold text-text-primary mb-1">
                    Billing Interval
                  </label>
                  <select
                    value={targetBillingInterval}
                    onChange={(e) => setTargetBillingInterval(e.target.value)}
                    className="w-full text-xs rounded-control border border-border p-2.5 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
                  >
                    <option value="MONTHLY">Monthly Billing</option>
                    <option value="YEARLY">Yearly Billing (Discounted)</option>
                  </select>
                </div>
              )}

              {/* Mandatory Reason */}
              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">
                  Administrative Reason <span className="text-danger">*</span>
                </label>
                <textarea
                  value={subReason}
                  onChange={(e) => setSubReason(e.target.value)}
                  placeholder="e.g. Granted trial extension per customer success request, upgraded to Growth tier, offline invoice payment confirmed..."
                  rows={3}
                  className="w-full text-xs rounded-control border border-border p-2.5 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-bg/50"
                  required
                />
                <span className="text-[11px] text-text-secondary">
                  Minimum 5 characters. Permanently logged in audit accountability trail.
                </span>
              </div>

              {(targetSubStatus === "SUSPENDED" || targetSubStatus === "CANCELLED") && (
                <div className="flex items-start gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="subConfirmCheckbox"
                    checked={subConfirmed}
                    onChange={(e) => setSubConfirmed(e.target.checked)}
                    className="mt-0.5 rounded border-border text-primary-600 focus:ring-primary-500"
                    required
                  />
                  <label htmlFor="subConfirmCheckbox" className="text-xs text-text-primary font-medium">
                    I explicitly confirm setting this subscription to {targetSubStatus}.
                  </label>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setManagingSubHotel(null)}
                  className="px-4 py-2 text-xs font-medium rounded-control border border-border text-text-secondary hover:text-text-primary hover:bg-bg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingSub || subReason.trim().length < 5}
                  className="px-4 py-2 text-xs font-semibold rounded-control bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 transition-colors"
                >
                  {submittingSub ? "Saving Changes..." : "Apply Subscription Adjustment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LIFECYCLE CONTROLS MODAL */}
      {lifecycleHotel && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-card max-w-lg w-full p-6 shadow-xl space-y-5 animate-fadeIn">
            <div className="flex items-start justify-between border-b border-border pb-3">
              <div>
                <h2 className="text-lg font-bold text-text-primary">Hotel Lifecycle Transition</h2>
                <p className="text-xs text-text-secondary mt-0.5 font-mono">
                  Hotel: {lifecycleHotel.name} (/{lifecycleHotel.slug})
                </p>
              </div>
              <button
                onClick={() => setLifecycleHotel(null)}
                className="text-text-secondary hover:text-text-primary text-lg"
              >
                &times;
              </button>
            </div>

            {statusError && (
              <div className="p-3 rounded-control bg-red-50 border border-red-200 text-red-900 text-xs flex items-center gap-2">
                <AlertTriangle size={16} className="text-red-600 shrink-0" />
                <span>{statusError}</span>
              </div>
            )}

            <form onSubmit={handleStatusSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Current Lifecycle Status
                </label>
                <div className="mb-2">{getStatusBadge(lifecycleHotel.status)}</div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">
                  Select New Target Status
                </label>
                <select
                  value={targetStatus}
                  onChange={(e) => setTargetStatus(e.target.value as HotelStatus)}
                  className="w-full text-sm rounded-control border border-border py-2 px-3 bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-500 font-medium"
                  required
                >
                  <option value="">-- Select Status --</option>
                  {lifecycleHotel.status !== "ACTIVE" && <option value="ACTIVE">ACTIVE (Operational)</option>}
                  {lifecycleHotel.status !== "TRIALING" && (
                    <option value="TRIALING">TRIALING (Onboarding Trial)</option>
                  )}
                  {lifecycleHotel.status !== "SUSPENDED" && (
                    <option value="SUSPENDED">SUSPENDED (Disable operations & staff)</option>
                  )}
                  {lifecycleHotel.status !== "CANCELLED" && (
                    <option value="CANCELLED">CANCELLED (Deactivated workspace)</option>
                  )}
                </select>
              </div>

              {/* Security & Consequence Warnings */}
              {targetStatus === "SUSPENDED" && (
                <div className="p-3 rounded-control bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-1">
                  <p className="font-semibold flex items-center gap-1.5 text-amber-800">
                    <AlertTriangle size={14} /> Operational Suspension Warning
                  </p>
                  <p>
                    Suspending this hotel immediately blocks all hotel staff from logging in or performing
                    operational actions in the dashboard. Existing sessions will fail closed with{" "}
                    <code>HOTEL_SUSPENDED (403)</code>.
                  </p>
                  <p className="font-semibold">
                    Note: No hotel records, reservations, or financial transactions will be deleted.
                  </p>
                </div>
              )}

              {targetStatus === "CANCELLED" && (
                <div className="p-3 rounded-control bg-red-50 border border-red-200 text-red-900 text-xs space-y-1">
                  <p className="font-semibold flex items-center gap-1.5 text-red-800">
                    <XCircle size={14} /> Workspace Cancellation
                  </p>
                  <p>
                    Cancelling a hotel terminates its workspace. Reactivation from cancelled status requires
                    explicit Platform Super Administrator authorization.
                  </p>
                </div>
              )}

              {/* Reason input required for suspension or cancellation */}
              {(targetStatus === "SUSPENDED" || targetStatus === "CANCELLED") && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-text-primary mb-1">
                      Administrative Reason <span className="text-danger">*</span>
                    </label>
                    <textarea
                      value={statusReason}
                      onChange={(e) => setStatusReason(e.target.value)}
                      placeholder="e.g. Terms violation, requested workspace pause, non-payment, maintenance..."
                      rows={3}
                      className="w-full text-xs rounded-control border border-border p-2.5 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-bg/50"
                      required
                    />
                    <span className="text-[11px] text-text-secondary">
                      Minimum 5 characters. This will be permanently recorded in the administrative audit log.
                    </span>
                  </div>

                  <div className="flex items-start gap-2 pt-1">
                    <input
                      type="checkbox"
                      id="confirmCheckbox"
                      checked={confirmCheckbox}
                      onChange={(e) => setConfirmCheckbox(e.target.checked)}
                      className="mt-0.5 rounded border-border text-primary-600 focus:ring-primary-500"
                      required
                    />
                    <label htmlFor="confirmCheckbox" className="text-xs text-text-primary font-medium">
                      I explicitly confirm updating this hotel workspace status to {targetStatus}.
                    </label>
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setLifecycleHotel(null)}
                  className="px-4 py-2 text-xs font-medium rounded-control border border-border text-text-secondary hover:text-text-primary hover:bg-bg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    submittingStatus ||
                    !targetStatus ||
                    ((targetStatus === "SUSPENDED" || targetStatus === "CANCELLED") &&
                      (!confirmCheckbox || statusReason.trim().length < 5))
                  }
                  className="px-4 py-2 text-xs font-semibold rounded-control bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 transition-colors"
                >
                  {submittingStatus ? "Updating Status..." : "Apply Status Change"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
