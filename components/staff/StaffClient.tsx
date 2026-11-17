"use client";

import { useState } from "react";
import { Plus, Trash2, X, Shield, AlertCircle, Check } from "lucide-react";

export type StaffRow = {
  id: string; // membership ID
  userId: string;
  name: string;
  email: string;
  phone?: string | null;
  role: string;
  department: string | null;
  status: string;
  isActive: boolean;
  /** True while the account holder has not yet accepted the invitation. */
  invitationPending?: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

const ALL_ROLES = [
  { value: "HOTEL_OWNER", label: "Hotel Owner", description: "Full ownership & billing control" },
  { value: "HOTEL_ADMIN", label: "Hotel Admin", description: "Operations & staff management" },
  { value: "MANAGER", label: "Manager", description: "Daily operations & inventory" },
  { value: "RECEPTIONIST", label: "Receptionist", description: "Front desk & reservations" },
  { value: "ACCOUNTANT", label: "Accountant", description: "Financial reporting & ledgers" },
  { value: "CASHIER", label: "Cashier", description: "Point of sale & counter payments" },
  { value: "WAITER", label: "Waiter / Server", description: "Restaurant orders & tables" },
  { value: "HOUSEKEEPER", label: "Housekeeper", description: "Room cleaning & linen" },
  { value: "TECHNICIAN", label: "Technician", description: "Maintenance & facilities" },
];

export default function StaffClient({
  initialStaff,
  currentUserId,
  currentUserRole,
}: {
  initialStaff: StaffRow[];
  currentUserId: string | null;
  currentUserRole: string | null;
}) {
  const [staff, setStaff] = useState<StaffRow[]>(initialStaff);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StaffRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isOwner = currentUserRole === "HOTEL_OWNER";
  const canManageStaff = isOwner || currentUserRole === "HOTEL_ADMIN";

  // Permitted roles for dropdowns (non-owners cannot assign HOTEL_OWNER)
  const assignableRoles = isOwner
    ? ALL_ROLES
    : ALL_ROLES.filter((r) => r.value !== "HOTEL_OWNER");

  async function updateRole(id: string, role: string) {
    setBusyId(id);
    setActionMessage(null);
    setActionError(null);

    try {
      const res = await fetch(`/api/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || "Could not update staff role.");
        return;
      }
      setStaff((prev) => prev.map((s) => (s.id === id ? { ...s, role } : s)));
      setActionMessage("Staff role updated successfully.");
    } catch {
      setActionError("Network error while updating role.");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleStatus(id: string, currentStatus: string) {
    setBusyId(id);
    setActionMessage(null);
    setActionError(null);

    const newStatus = currentStatus === "ACTIVE" ? "SUSPENDED" : "ACTIVE";

    try {
      const res = await fetch(`/api/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newStatus === "ACTIVE" ? { reinvite: true } : { status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || "Could not update staff status.");
        return;
      }
      setStaff((prev) => prev.map((s) => s.id === id
        ? { ...s, status: "SUSPENDED", isActive: false, invitationPending: newStatus === "ACTIVE" }
        : s));
      setActionMessage(newStatus === "ACTIVE" ? "Invitation sent; the account holder must accept before access is restored." : "Staff member suspended.");
    } catch {
      setActionError("Network error while updating status.");
    } finally {
      setBusyId(null);
    }
  }

  async function executeDelete(member: StaffRow) {
    setBusyId(member.id);
    setActionMessage(null);
    setActionError(null);

    try {
      const res = await fetch(`/api/staff/${member.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setActionError(data.error || "Could not remove staff member.");
        return;
      }

      if (data.mode === "deleted") {
        setStaff((prev) => prev.filter((s) => s.id !== member.id));
        setActionMessage(`${member.name} was removed from this hotel workspace.`);
      } else {
        setStaff((prev) =>
          prev.map((s) => (s.id === member.id ? { ...s, status: "SUSPENDED", isActive: false } : s))
        );
        setActionMessage(
          `${member.name} has existing activity on record in this hotel. Their membership was suspended to protect historical logs.`
        );
      }
    } catch {
      setActionError("Network error while removing staff member.");
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Staff & Memberships</h1>
          <p className="text-text-secondary text-sm mt-0.5">
            Manage authorized staff members, assign operational roles, and set workstation credentials.
          </p>
        </div>
        {canManageStaff && (
          <button
            onClick={() => setAddOpen(true)}
            className="btn-primary flex items-center gap-2 text-sm font-semibold shrink-0"
          >
            <Plus size={16} /> Add Staff Member
          </button>
        )}
      </div>

      {actionMessage && (
        <div className="p-3.5 rounded-xl bg-success/10 border border-success/20 text-success text-sm flex items-center gap-2">
          <Check size={18} /> {actionMessage}
        </div>
      )}

      {actionError && (
        <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/20 text-danger text-sm flex items-center gap-2">
          <AlertCircle size={18} /> {actionError}
        </div>
      )}

      <div className="card overflow-x-auto p-0 border border-border shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-secondary border-b border-border bg-bg/40">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Hotel Role</th>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last Login</th>
              {canManageStaff && <th className="px-4 py-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => {
              const isSelf = s.userId === currentUserId;
              const isTargetOwner = s.role === "HOTEL_OWNER";
              const canEditThisMember =
                canManageStaff &&
                !isSelf &&
                (!isTargetOwner || isOwner);

              return (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-bg/20 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{s.name}</span>
                      {isSelf && (
                        <span className="text-[11px] font-semibold text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded">
                          You
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{s.email}</td>
                  <td className="px-4 py-3">
                    {canEditThisMember ? (
                      <select
                        value={s.role}
                        onChange={(e) => updateRole(s.id, e.target.value)}
                        disabled={busyId === s.id}
                        className="rounded-control border border-border px-2 py-1 text-xs bg-surface font-medium focus:outline-none focus:ring-1 focus:ring-primary-500"
                      >
                        {assignableRoles.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="inline-flex items-center gap-1 badge bg-primary-50 text-primary-700 text-xs font-medium">
                        <Shield size={12} /> {s.role.replace("_", " ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{s.department || "—"}</td>
                  <td className="px-4 py-3">
                    {s.invitationPending ? (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700">
                        Invitation pending
                      </span>
                    ) : canEditThisMember ? (
                      <button
                        onClick={() => toggleStatus(s.id, s.status)}
                        disabled={busyId === s.id}
                        className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                          s.status === "ACTIVE"
                            ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                            : "bg-danger/10 text-danger hover:bg-danger/20"
                        }`}
                      >
                        {s.status === "ACTIVE" ? "Active" : "Suspended"}
                      </button>
                    ) : (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          s.status === "ACTIVE"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-danger/10 text-danger"
                        }`}
                      >
                        {s.status === "ACTIVE" ? "Active" : "Suspended"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs">
                    {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : "Never"}
                  </td>
                  {canManageStaff && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                        {canEditThisMember && (
                          <button
                            onClick={() => setDeleteTarget(s)}
                            disabled={busyId === s.id}
                            title={`Remove ${s.name} from hotel`}
                            className="inline-flex items-center gap-1 text-danger text-xs font-medium hover:underline disabled:opacity-40"
                          >
                            <Trash2 size={14} /> Remove
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add Staff Modal */}
      {addOpen && (
        <AddStaffModal
          assignableRoles={assignableRoles}
          onClose={() => setAddOpen(false)}
          onCreated={(newMember) => {
            setAddOpen(false);
            setStaff((prev) => [...prev, newMember].sort((a, b) => a.name.localeCompare(b.name)));
            setActionMessage(
              newMember.invitationPending
                ? `Invitation sent to ${newMember.name}. They must accept it before they can access this hotel.`
                : `Added ${newMember.name} to hotel staff.`
            );
          }}
        />
      )}

      {/* Delete / Remove Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="card w-full max-w-md shadow-xl border border-border">
            <h2 className="text-lg font-bold text-text-primary mb-2">Remove Staff Member</h2>
            <p className="text-sm text-text-secondary mb-4 leading-relaxed">
              Are you sure you want to remove <strong className="text-text-primary">{deleteTarget.name}</strong> from this hotel?
            </p>
            <p className="text-xs text-text-muted mb-6 bg-bg/60 p-3 rounded-lg border border-border">
              If they have transaction history (reservations, payments, or task logs in this hotel), their access will be suspended while preserving historical audit logs. If they have no recorded history, their membership will be permanently removed.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="btn-secondary text-sm px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeDelete(deleteTarget)}
                disabled={busyId === deleteTarget.id}
                className="btn-primary !bg-danger hover:!bg-danger/90 !border-danger text-sm px-4 py-2"
              >
                {busyId === deleteTarget.id ? "Processing..." : "Confirm Removal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddStaffModal({
  assignableRoles,
  onClose,
  onCreated,
}: {
  assignableRoles: { value: string; label: string }[];
  onClose: () => void;
  onCreated: (staff: StaffRow) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(assignableRoles[0]?.value || "RECEPTIONIST");
  const [department, setDepartment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone: phone || undefined,
        password,
        role,
        department: department || undefined,
      }),
    });

    setLoading(false);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not add staff member.");
      return;
    }

    // An existing account is invited, not added: the API answers 202 with a
    // SUSPENDED membership. Showing it as active would tell the administrator the
    // person has access when they do not.
    const invitationPending = data.invitationPending === true;
    onCreated({
      id: data.id,
      userId: data.userId,
      name: data.name || name,
      email: data.email || email,
      phone: data.phone ?? (phone || null),
      role: data.role || role,
      department: data.department ?? (department || null),
      status: invitationPending ? "SUSPENDED" : "ACTIVE",
      isActive: !invitationPending,
      invitationPending,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto shadow-xl border border-border">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-text-primary">Add Staff Member</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-control px-3 py-2 mb-3">
            {error}
          </p>
        )}

        <form onSubmit={submit} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Full Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Samuel Mutiso"
              className="w-full rounded-control border border-border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="samuel@yourhotel.com"
              className="w-full rounded-control border border-border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Phone Number (Optional)</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+254 700 000 000"
              className="w-full rounded-control border border-border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Initial Password (new accounts only — leave blank when inviting an existing account)
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              placeholder="At least 8 characters"
              className="w-full rounded-control border border-border px-3 py-2 text-sm font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Hotel Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-control border border-border px-3 py-2 text-sm bg-surface"
              >
                {assignableRoles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Department (Optional)</label>
              <input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="Front Desk / Accounts"
                className="w-full rounded-control border border-border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <p className="text-xs text-text-muted pt-1">
            If the email already has an account, that person is <strong>invited</strong>: their password and global profile are untouched, and they get access only after they accept from their own workspace list. A new email becomes a staff account immediately, with the password you set here.
          </p>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? "Creating..." : "Add to Hotel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}