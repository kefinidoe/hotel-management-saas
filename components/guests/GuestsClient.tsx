"use client";

import { useRef, useState } from "react";
import { Search, X, Archive, RotateCcw } from "lucide-react";
import { formatDisplayDate } from "@/lib/dates";
import { ApiRequestError, apiErrorMessage, requestJson } from "@/lib/client-api";

type GuestRow = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  isArchived: boolean;
  currentRoom: string | null;
  lastStatus: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
};

type GuestDetail = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  idNumber: string | null;
  nationality: string | null;
  vehicleRegistration: string | null;
  notes: string | null;
  isArchived: boolean;
  reservations: {
    id: string;
    code: string;
    status: string;
    checkInDate: string;
    checkOutDate: string;
    rooms: { roomNumber: string; rate: number }[];
  }[];
  folios: { id: string; isClosed: boolean; total: number; paid: number; balance: number }[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isGuestRow(value: unknown): value is GuestRow {
  return isObject(value) &&
    typeof value.id === "string" && Boolean(value.id.trim()) && value.id === value.id.trim() &&
    typeof value.fullName === "string" && Boolean(value.fullName.trim()) &&
    isNullableString(value.phone) && isNullableString(value.email) &&
    typeof value.isArchived === "boolean" &&
    isNullableString(value.currentRoom) && isNullableString(value.lastStatus) &&
    (value.checkInDate === null || isValidDate(value.checkInDate)) &&
    (value.checkOutDate === null || isValidDate(value.checkOutDate));
}

function isGuestList(value: unknown): value is GuestRow[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((guest) => {
    if (!isGuestRow(guest) || ids.has(guest.id)) return false;
    ids.add(guest.id);
    return true;
  });
}

function isGuestDetail(value: unknown): value is GuestDetail {
  if (
    !isObject(value) ||
    typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim() ||
    typeof value.fullName !== "string" || !value.fullName.trim() ||
    !isNullableString(value.phone) || !isNullableString(value.email) ||
    !isNullableString(value.idNumber) || !isNullableString(value.nationality) ||
    !isNullableString(value.vehicleRegistration) || !isNullableString(value.notes) ||
    typeof value.isArchived !== "boolean" ||
    !Array.isArray(value.reservations) || !Array.isArray(value.folios)
  ) return false;

  const validReservations = value.reservations.every((reservation) =>
    isObject(reservation) &&
    typeof reservation.id === "string" && Boolean(reservation.id.trim()) &&
    typeof reservation.code === "string" && Boolean(reservation.code.trim()) &&
    typeof reservation.status === "string" && Boolean(reservation.status.trim()) &&
    isValidDate(reservation.checkInDate) && isValidDate(reservation.checkOutDate) &&
    Array.isArray(reservation.rooms) && reservation.rooms.every((room) =>
      isObject(room) && typeof room.roomNumber === "string" &&
      typeof room.rate === "number" && Number.isFinite(room.rate)
    )
  );
  const validFolios = value.folios.every((folio) =>
    isObject(folio) &&
    typeof folio.id === "string" && Boolean(folio.id.trim()) &&
    typeof folio.isClosed === "boolean" &&
    typeof folio.total === "number" && Number.isFinite(folio.total) &&
    typeof folio.paid === "number" && Number.isFinite(folio.paid) &&
    typeof folio.balance === "number" && Number.isFinite(folio.balance)
  );
  return validReservations && validFolios;
}

function isArchiveResult(value: unknown, id: string, isArchived: boolean): boolean {
  return isObject(value) && value.id === id && value.isArchived === isArchived;
}

export default function GuestsClient({ initialGuests }: { initialGuests: GuestRow[] }) {
  const [guests, setGuests] = useState<GuestRow[]>(() => initialGuests.filter(isGuestRow));
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailErrorStatus, setDetailErrorStatus] = useState<number | null>(null);
  const [detailRetryable, setDetailRetryable] = useState(false);
  const listRequestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const queryRef = useRef("");
  const showArchivedRef = useRef(false);

  async function loadGuestList(q: string, includeArchived: boolean) {
    const requestId = ++listRequestSequence.current;
    setListLoading(true);
    setError(null);
    const params = new URLSearchParams({ q });
    if (includeArchived) params.set("includeArchived", "true");
    try {
      const rows: unknown = await requestJson<unknown>(`/api/guests?${params.toString()}`);
      if (requestId !== listRequestSequence.current) return;
      if (!isGuestList(rows)) throw new Error("The server returned an invalid guest list.");
      setGuests(rows);
    } catch (loadError) {
      if (requestId === listRequestSequence.current) {
        setError(apiErrorMessage(loadError, "Could not load guests."));
      }
    } finally {
      if (requestId === listRequestSequence.current) setListLoading(false);
    }
  }

  function search(q: string, includeArchived = showArchivedRef.current) {
    queryRef.current = q;
    setQuery(q);
    return loadGuestList(q, includeArchived);
  }

  function toggleShowArchived() {
    const next = !showArchivedRef.current;
    showArchivedRef.current = next;
    setShowArchived(next);
    void loadGuestList(queryRef.current, next);
  }

  async function openGuest(id: string) {
    const canSelect = guests.some((guest) => guest.id === id);
    if (!id.trim() || id !== id.trim() || (!canSelect && selectedIdRef.current !== id)) return;

    const requestId = ++detailRequestSequence.current;
    selectedIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailErrorStatus(null);
    setDetailRetryable(false);
    setDetailLoading(true);
    try {
      const guest: unknown = await requestJson<unknown>(`/api/guests/${encodeURIComponent(id)}`);
      if (requestId !== detailRequestSequence.current || selectedIdRef.current !== id) return;
      if (!isGuestDetail(guest) || guest.id !== id) {
        throw new Error("The server returned invalid guest details. Please try again.");
      }
      setDetail(guest);
    } catch (loadError) {
      if (requestId !== detailRequestSequence.current || selectedIdRef.current !== id) return;
      setDetail(null);
      setDetailError(apiErrorMessage(loadError, "Could not load this guest."));
      setDetailErrorStatus(loadError instanceof ApiRequestError ? loadError.status ?? null : null);
      setDetailRetryable(
        !(loadError instanceof ApiRequestError) ||
        loadError.kind === "network" ||
        (loadError.status !== undefined && loadError.status >= 500)
      );
    } finally {
      if (requestId === detailRequestSequence.current && selectedIdRef.current === id) {
        setDetailLoading(false);
      }
    }
  }

  function closeGuestDetail(refreshList = false) {
    detailRequestSequence.current += 1;
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setDetailErrorStatus(null);
    setDetailRetryable(false);
    if (refreshList) void loadGuestList(queryRef.current, showArchivedRef.current);
  }

  async function setArchived(isArchived: boolean) {
    const id = selectedIdRef.current;
    const selectedDetail = detail;
    const selectionRequestId = detailRequestSequence.current;
    if (
      archiving || !id || !isGuestDetail(selectedDetail) || selectedDetail.id !== id ||
      id !== selectedIdRef.current
    ) return;
    if (isArchived && !confirm("Archive this guest? They'll be hidden from the list, but all their stay and payment history stays intact and can be restored anytime.")) {
      return;
    }
    if (selectedIdRef.current !== id || detailRequestSequence.current !== selectionRequestId) return;

    setArchiving(true);
    setDetailError(null);
    setDetailErrorStatus(null);
    setDetailRetryable(false);
    try {
      const result: unknown = await requestJson<unknown>(`/api/guests/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived }),
      });
      if (!isArchiveResult(result, id, isArchived)) {
        throw new Error("The server returned an invalid guest update. Please refresh and try again.");
      }
      if (selectedIdRef.current === id && detailRequestSequence.current === selectionRequestId) {
        setDetail((current) => current?.id === id ? { ...current, isArchived } : current);
      }
      await loadGuestList(queryRef.current, showArchivedRef.current);
    } catch (mutationError) {
      if (selectedIdRef.current === id && detailRequestSequence.current === selectionRequestId) {
        setDetailError(apiErrorMessage(mutationError, "Could not update this guest."));
        setDetailErrorStatus(mutationError instanceof ApiRequestError ? mutationError.status ?? null : null);
        setDetailRetryable(
          !(mutationError instanceof ApiRequestError) ||
          mutationError.kind === "network" ||
          (mutationError.status !== undefined && mutationError.status >= 500)
        );
      }
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div>
      <h1>Guests</h1>
      <p className="text-text-secondary text-sm mt-1 mb-4">
        Search by name, phone, or email.
      </p>

      <div className="flex items-center gap-4 mb-4">
        <div className="relative max-w-md flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => search(e.target.value)}
            placeholder="Search guests..."
            className="w-full rounded-control border border-border bg-surface pl-9 pr-3 py-2.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary whitespace-nowrap">
          <input type="checkbox" checked={showArchived} onChange={toggleShowArchived} />
          Show archived
        </label>
      </div>

      {error && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
          <span>{error}</span>
          <button type="button" onClick={() => void loadGuestList(queryRef.current, showArchivedRef.current)} disabled={listLoading} className="underline disabled:opacity-50">
            Retry
          </button>
        </div>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted text-xs uppercase border-b border-border">
              <th className="p-3 font-medium">Guest</th>
              <th className="p-3 font-medium">Phone</th>
              <th className="p-3 font-medium">Room</th>
              <th className="p-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => (
              <tr
                key={g.id}
                onClick={() => openGuest(g.id)}
                className="border-b border-border last:border-0 cursor-pointer hover:bg-primary-50/40"
              >
                <td className="p-3 font-medium">
                  {g.fullName}
                  {g.isArchived && (
                    <span className="ml-2 text-xs text-text-muted border border-border rounded px-1.5 py-0.5">
                      Archived
                    </span>
                  )}
                </td>
                <td className="p-3 text-text-secondary">{g.phone ?? "—"}</td>
                <td className="p-3 text-text-secondary">{g.currentRoom ?? "—"}</td>
                <td className="p-3 text-text-secondary">{g.lastStatus?.replace("_", " ") ?? "—"}</td>
              </tr>
            ))}
            {listLoading && (
              <tr>
                <td colSpan={4} role="status" className="p-6 text-center text-text-secondary">
                  Loading guests…
                </td>
              </tr>
            )}
            {!listLoading && !error && guests.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-text-secondary">
                  No guests found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedId && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
          <div className="card w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2>{detail?.fullName ?? (detailLoading ? "Loading..." : "Guest details")}</h2>
              <button onClick={() => closeGuestDetail()} className="text-text-secondary hover:text-text-primary">
                <X size={18} />
              </button>
            </div>

            {detailLoading && <p role="status" className="text-sm text-text-secondary">Loading guest details…</p>}
            {detailError && (
              <div role="alert" className="flex items-center justify-between gap-3 rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                <span>{detailError}</span>
                <div className="flex shrink-0 items-center gap-3">
                  {detailErrorStatus === 401 && <a href="/login" className="underline">Sign in</a>}
                  {detailRetryable && (
                    <button type="button" onClick={() => void openGuest(selectedId)} disabled={detailLoading} className="underline disabled:opacity-50">
                      Retry
                    </button>
                  )}
                  <button type="button" onClick={() => closeGuestDetail(true)} className="underline">
                    Back to guest list
                  </button>
                </div>
              </div>
            )}

            {detail && (
              <div className="space-y-6">
                <div className="text-sm text-text-secondary space-y-1">
                  <p>Phone: {detail.phone ?? "—"}</p>
                  <p>Email: {detail.email ?? "—"}</p>
                  <p>National ID: {detail.idNumber ?? "—"}</p>
                  <p>Nationality: {detail.nationality ?? "—"}</p>
                  <p>Vehicle Reg: {detail.vehicleRegistration ?? "—"}</p>
                </div>

                <div>
                  <h3 className="mb-2">Stay History</h3>
                  <div className="space-y-2">
                    {detail.reservations.map((r) => (
                      <div key={r.id} className="border border-border rounded-control px-3 py-2 text-sm">
                        <div className="flex justify-between">
                          <span className="font-medium">
                            {r.rooms.map((rr) => rr.roomNumber).join(", ")} — {r.code}
                          </span>
                          <span className="text-text-secondary">{r.status.replace("_", " ")}</span>
                        </div>
                        <p className="text-text-secondary text-xs mt-0.5">
                          {formatDisplayDate(r.checkInDate)} –{" "}
                          {formatDisplayDate(r.checkOutDate)}
                        </p>
                      </div>
                    ))}
                    {detail.reservations.length === 0 && (
                      <p className="text-sm text-text-secondary">No reservations yet.</p>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="mb-2">Financial History</h3>
                  <div className="space-y-2">
                    {detail.folios.map((f) => (
                      <div key={f.id} className="border border-border rounded-control px-3 py-2 text-sm flex justify-between">
                        <span className="text-text-secondary">{f.isClosed ? "Closed folio" : "Open folio"}</span>
                        <span className={f.balance > 0 ? "text-danger font-medium" : "text-success font-medium"}>
                          Balance: KSh {f.balance.toLocaleString()}
                        </span>
                      </div>
                    ))}
                    {detail.folios.length === 0 && (
                      <p className="text-sm text-text-secondary">No billing history yet.</p>
                    )}
                  </div>
                </div>

                <div className="pt-2 border-t border-border">
                  {detail.isArchived ? (
                    <button
                      onClick={() => void setArchived(false)}
                      disabled={archiving || Boolean(detailError)}
                      className="flex items-center gap-2 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
                    >
                      <RotateCcw size={16} /> Restore guest
                    </button>
                  ) : (
                    <button
                      onClick={() => void setArchived(true)}
                      disabled={archiving || Boolean(detailError) || detail.reservations.some((r) => r.status === "CHECKED_IN")}
                      className="flex items-center gap-2 text-sm text-danger hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        detail.reservations.some((r) => r.status === "CHECKED_IN")
                          ? "Can't archive a guest who is currently checked in"
                          : undefined
                      }
                    >
                      <Archive size={16} /> Archive guest
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}