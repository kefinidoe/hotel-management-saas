import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
const m = vi.hoisted(() => ({
  tenant: vi.fn(), role: vi.fn(), module: vi.fn(), auth: vi.fn(), session: vi.fn(), configured: vi.fn(), limit: vi.fn(),
  membership: vi.fn(), count: vi.fn(), user: vi.fn(), transaction: vi.fn(), task: vi.fn(), hotel: vi.fn(), update: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hash") } }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: m.tenant, requireAuth: m.auth, requireRole: m.role, requireModule: m.module, ROLE_GROUPS: { STAFF_ADMIN: [], HOUSEKEEPING: [], STAFF_VIEW: [] } }));
vi.mock("next-auth", () => ({ getServerSession: m.session }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db-safety-guard", () => ({ isDatabaseConfigured: m.configured }));
vi.mock("@/lib/auth-rate-limit", () => ({ limitAuthRequest: m.limit }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  hotelMembership: { findFirst: m.membership, count: m.count },
  user: { findUnique: m.user, findFirst: m.user, update: m.update },
  housekeepingTask: { findFirst: m.task }, hotel: { findUnique: m.hotel }, $transaction: m.transaction,
} }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
import { POST as createStaff } from "@/app/api/staff/route";
import { PATCH as updateStaff, DELETE as deleteStaff } from "@/app/api/staff/[id]/route";
import { PUT as updateTask } from "@/app/api/housekeeping/[id]/route";
import { PATCH as settings } from "@/app/api/hotel/settings/route";
import { POST as onboarding } from "@/app/api/hotel/onboarding/route";
import { POST as password } from "@/app/api/profile/password/route";

const ctx = { params: Promise.resolve({ id: "target" }) };
const request = (method: string, body?: string, query = "") => new Request(`https://hotel.test/api/action${query}`, { method, ...(body === undefined ? {} : { body }) });
const routes = [
  { name: "staff create", method: "POST", run: createStaff, valid: { name: "Jane Staff", email: "jane@example.com", role: "WAITER", password: "abcdefgh" }, invalid: { name: "", email: "bad", role: "WAITER" } },
  { name: "staff update", method: "PATCH", run: (r: Request) => updateStaff(r, ctx), valid: { department: "Service" }, invalid: { isActive: "false" } },
  { name: "staff delete", method: "DELETE", run: (r: Request) => deleteStaff(r, ctx), valid: undefined, invalid: { extra: true } },
  { name: "housekeeping", method: "PUT", run: (r: Request) => updateTask(r, ctx), valid: { status: "READY" }, invalid: { status: "BROKEN" } },
  { name: "hotel settings", method: "PATCH", run: settings, valid: { name: "Hotel Name" }, invalid: { timezone: "Not/AZone" } },
  { name: "hotel onboarding", method: "POST", run: onboarding, valid: { name: "Hotel Name" }, invalid: { name: "Hotel Name", currency: "NOPE" } },
  { name: "password", method: "POST", run: password, valid: { currentPassword: "old-password", newPassword: "new-password" }, invalid: { currentPassword: "old", newPassword: "short" } },
];
const body = (value: unknown) => value === undefined ? undefined : JSON.stringify(value);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
  m.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "actor", role: "MANAGER" });
  m.role.mockReturnValue(null); m.module.mockResolvedValue(null);
  m.auth.mockResolvedValue({ user: { id: "actor" } }); m.session.mockResolvedValue({ user: { id: "actor" } });
  m.configured.mockReturnValue(true); m.limit.mockResolvedValue(null);
  m.user.mockResolvedValue({ id: "actor", isActive: true });
  m.membership.mockResolvedValue({ id: "target", userId: "other", role: "WAITER", status: "ACTIVE", user: { name: "Other" } });
  m.count.mockResolvedValue(1);
});

describe.each(routes)("$name", ({ run, method, valid, invalid }) => {
  it("returns structured errors for malformed input, invalid fields and queries before writes", async () => {
    for (const r of [request(method, "{"), request(method, body(invalid)), request(method, body(valid), "?extra=1")]) {
      const result = await run(r);
      expect(result.status).toBe(400);
      expect((await result.json()).issues[0]).toEqual(expect.objectContaining({ code: expect.any(String), path: expect.any(Array), message: expect.any(String) }));
    }
    expect(m.transaction).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
    if (run === updateTask) expect(m.task).not.toHaveBeenCalled();
    if (run === settings) expect(m.hotel).not.toHaveBeenCalled();
  });
});

it.each([createStaff, (r: Request) => updateStaff(r, ctx), (r: Request) => deleteStaff(r, ctx), (r: Request) => updateTask(r, ctx), settings])("tenant and role denial precede validation", async (run) => {
  m.tenant.mockResolvedValueOnce(NextResponse.json({}, { status: 401 }));
  expect((await run(request("POST", "{"))).status).toBe(401);
  m.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
  expect((await run(request("POST", "{"))).status).toBe(403);
  expect(m.transaction).not.toHaveBeenCalled();
});
it("rate-limits even malformed staff-create attempts before validation", async () => {
  m.limit.mockResolvedValueOnce(NextResponse.json({}, { status: 429 }));
  expect((await createStaff(request("POST", "{"))).status).toBe(429);
  expect(m.limit).toHaveBeenCalledWith(expect.any(Request), "invitationCreate", "", "actor");
  expect(m.user).not.toHaveBeenCalled();
});
it("rate-limits password changes before validation", async () => {
  m.limit.mockResolvedValueOnce(NextResponse.json({}, { status: 429 }));
  expect((await password(request("POST", "{"))).status).toBe(429);
  expect(m.user).not.toHaveBeenCalled();
});
it("checks account activity before onboarding validation", async () => {
  m.user.mockResolvedValueOnce({ id: "actor", isActive: false });
  expect((await onboarding(request("POST", "{"))).status).toBe(403);
  expect(m.transaction).not.toHaveBeenCalled();
});
it("preserves the security guard against administrator password resets", async () => {
  const result = await updateStaff(request("PATCH", JSON.stringify({ newPassword: "some-password" })), ctx);
  expect(result.status).toBe(403); expect(m.transaction).not.toHaveBeenCalled();
});
it("preserves owner-only grants before validation", async () => {
  const result = await createStaff(request("POST", JSON.stringify({ role: "HOTEL_OWNER", email: "bad", name: "" })));
  expect(result.status).toBe(403); expect(m.limit).toHaveBeenCalled(); expect(m.user).not.toHaveBeenCalled();
});
it("checks target owner permissions before validating an update", async () => {
  m.membership.mockResolvedValueOnce({ id: "target", userId: "other", role: "HOTEL_OWNER", status: "ACTIVE", user: { name: "Owner" } });
  const result = await updateStaff(request("PATCH", JSON.stringify({ role: "WAITER", isActive: "bad" })), ctx);
  expect(result.status).toBe(403); expect(m.transaction).not.toHaveBeenCalled();
});
it("requires a valid initial password for new staff before the quota transaction", async () => {
  m.user.mockResolvedValueOnce(null);
  const response = await createStaff(request("POST", JSON.stringify({ name: "New User", email: "new@example.com", role: "WAITER", password: "short" })));
  expect(response.status).toBe(400); expect((await response.json()).issues[0].path).toEqual(["password"]);
  expect(m.transaction).not.toHaveBeenCalled();
});
it("checks account status and the current password before validating the new password", async () => {
  m.user.mockResolvedValueOnce({ id: "actor", isActive: false });
  expect((await password(request("POST", "{"))).status).toBe(403);
  vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);
  const result = await password(request("POST", JSON.stringify({ currentPassword: "wrong-password", newPassword: "short" })));
  expect(result.status).toBe(400);
  expect((await result.json()).error).toContain("current password");
  expect(m.update).not.toHaveBeenCalled();
});
