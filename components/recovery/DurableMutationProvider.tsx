"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Operation = "OPENING_BALANCE" | "PURCHASE" | "WASTAGE" | "ADJUSTMENT" | "EXPENSE_CREATE";
type Attempt = { version: 1; hotelId: string; actorId: string; operation: Operation; path: string; method: "POST" | "PATCH"; key: string; body: string; createdAt: number };
type Context = { submit: (operation: Operation, path: string, method: "POST" | "PATCH", body: unknown) => Promise<Response> };
const RecoveryContext = createContext<Context | null>(null);

function matchesPath(a: Attempt): boolean {
  if (a.operation === "OPENING_BALANCE") return a.method === "POST" && a.path === "/api/inventory";
  if (a.operation === "PURCHASE") return a.method === "POST" && a.path === "/api/purchases";
  if (a.operation === "WASTAGE") return a.method === "POST" && a.path === "/api/wastage";
  if (a.operation === "EXPENSE_CREATE") return a.method === "POST" && a.path === "/api/expenses";
  return a.operation === "ADJUSTMENT" && a.method === "PATCH" && /^\/api\/inventory\/[a-zA-Z0-9_-]{1,100}$/.test(a.path);
}

export function readDurableAttempt(storage: Storage, storageKey: string, hotelId: string, actorId: string): Attempt | null {
  const raw = storage.getItem(storageKey);
  if (raw === null) return null;
  let a: Attempt;
  try { a = JSON.parse(raw); } catch { throw new Error("Saved recovery data is unreadable. Do not create a new transaction; reconcile it first."); }
  if (!a || a.version !== 1 || a.hotelId !== hotelId || a.actorId !== actorId || typeof a.key !== "string" || a.key.length < 4 || a.key.length > 128 ||
      typeof a.body !== "string" || a.body.length > 16000 || typeof a.createdAt !== "number" || !matchesPath(a)) {
    throw new Error("Saved recovery data is invalid. Do not create a new transaction; reconcile it first.");
  }
  try { const body = JSON.parse(a.body); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); }
  catch { throw new Error("Saved request is invalid. Do not create a new transaction; reconcile it first."); }
  return a;
}

export function DurableMutationProvider({ hotelId, actorId, children }: { hotelId: string; actorId: string; children: React.ReactNode }) {
  const storageKey = `hms:pending-mutation:v1:${encodeURIComponent(hotelId)}:${encodeURIComponent(actorId)}`;
  const [pending, setPending] = useState<Attempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    try { setPending(readDurableAttempt(window.localStorage, storageKey, hotelId, actorId)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Recovery storage is unavailable."); }
  }, [storageKey, hotelId, actorId]);
  useEffect(() => {
    refresh();
    const listener = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) refresh(); };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, [storageKey, refresh]);

  async function locked<T>(work: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error("This browser cannot safely coordinate recovery across tabs; no request was sent.");
    return navigator.locks.request(`hms:mutation:${hotelId}:${actorId}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("Another tab is processing an operation; no new request was sent.");
      return work();
    });
  }

  async function send(attempt: Attempt): Promise<Response> {
    const response = await fetch(attempt.path, { method: attempt.method, headers: {
      "Content-Type": "application/json", "Idempotency-Key": attempt.key,
      "X-Expected-Hotel-Id": hotelId, "X-Expected-Actor-Id": actorId,
    }, body: attempt.body });
    if (response.ok) {
      // Do not discard a claim on an invalid or truncated success response.
      const value: unknown = await response.clone().json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unrecognized response; keep the saved attempt and retry it.");
      window.localStorage.removeItem(storageKey);
      setPending(null);
    }
    return response;
  }

  async function submit(operation: Operation, path: string, method: "POST" | "PATCH", body: unknown): Promise<Response> {
    return locked(async () => {
      const serialized = JSON.stringify(body);
      const old = readDurableAttempt(window.localStorage, storageKey, hotelId, actorId);
      if (old && (old.operation !== operation || old.path !== path || old.method !== method || old.body !== serialized)) {
        throw new Error("A previous request is unresolved. Use the recovery panel before creating another transaction.");
      }
      const attempt: Attempt = old ?? { version: 1, hotelId, actorId, operation, path, method, key: crypto.randomUUID(), body: serialized, createdAt: Date.now() };
      if (!matchesPath(attempt)) throw new Error("Invalid operation; no request was sent.");
      window.localStorage.setItem(storageKey, JSON.stringify(attempt));
      // Verify storage before sending: this fails closed for disabled/quota-limited storage.
      if (window.localStorage.getItem(storageKey) !== JSON.stringify(attempt)) throw new Error("Could not persist the request; no request was sent.");
      setPending(attempt);
      return send(attempt);
    });
  }

  async function retry() {
    setBusy(true); setError(null);
    try {
      await locked(async () => {
        const attempt = readDurableAttempt(window.localStorage, storageKey, hotelId, actorId);
        if (!attempt) { setPending(null); return; }
        const response = await send(attempt);
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error || `Recovery was not confirmed (HTTP ${response.status}). The attempt is preserved.`);
        }
        window.location.reload();
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Recovery failed; the attempt is preserved."); }
    finally { setBusy(false); }
  }

  async function markReconciled() {
    if (!window.confirm("Only continue after independently verifying this attempt's outcome in its original hotel. Clear the saved recovery record?")) return;
    setBusy(true);
    try { await locked(async () => { window.localStorage.removeItem(storageKey); setPending(null); setError(null); }); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not clear the record."); }
    finally { setBusy(false); }
  }

  return <RecoveryContext.Provider value={{ submit }}>
    {(pending || error) && <div role="alert" className="card mb-4 border-warning">
      <p>{pending ? `Unresolved ${pending.operation.replaceAll("_", " ").toLowerCase()} request. Do not create another until this is verified.` : "Transaction recovery is unavailable."}</p>
      {error && <p className="text-danger text-sm">{error}</p>}
      {pending && <><details><summary>Details for reconciliation</summary><pre className="whitespace-pre-wrap text-xs">{pending.body}</pre><p className="text-xs">Key: {pending.key}</p></details>
        <button type="button" disabled={busy} onClick={retry} className="btn-primary mr-2">Retry saved request</button>
        <button type="button" disabled={busy} onClick={markReconciled} className="btn-secondary">Mark independently reconciled</button></>}
    </div>}
    {children}
  </RecoveryContext.Provider>;
}

export function useDurableMutation(): Context {
  const context = useContext(RecoveryContext);
  if (!context) throw new Error("A verified hotel and user are required for transaction recovery.");
  return context;
}
