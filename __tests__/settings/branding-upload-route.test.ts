import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(), role: vi.fn(), module: vi.fn(), createClient: vi.fn(),
  from: vi.fn(), upload: vi.fn(), getPublicUrl: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.tenant,
  requireRole: mocks.role,
  requireModule: mocks.module,
  ROLE_GROUPS: { MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"] },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
import { POST } from "@/app/api/settings/branding/upload/route";

function request(file?: File) {
  const body = new FormData();
  if (file) body.set("file", file);
  return new Request("https://example.test/api/settings/branding/upload", { method: "POST", body });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://storage.example.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only");
  mocks.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "actor", role: "MANAGER" });
  mocks.role.mockReturnValue(null);
  mocks.module.mockResolvedValue(null);
  mocks.createClient.mockReturnValue({ storage: { from: mocks.from } });
  mocks.from.mockReturnValue({ upload: mocks.upload, getPublicUrl: mocks.getPublicUrl });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: "https://storage.example.test/logo.png" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("branding upload route", () => {
  it("rejects unauthorized users before storage access", async () => {
    mocks.role.mockReturnValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await POST(request(new File(["data"], "logo.png", { type: "image/png" })))).status).toBe(403);
    expect(mocks.module).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects missing, unsupported, and oversized files without uploading", async () => {
    expect((await POST(request())).status).toBe(400);
    expect((await POST(request(new File(["data"], "logo.txt", { type: "text/plain" })))).status).toBe(400);
    expect((await POST(request(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })))).status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("uploads to the tenant-specific path and returns the public URL", async () => {
    const response = await POST(request(new File(["data"], "logo.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logoUrl: "https://storage.example.test/logo.png" });
    expect(mocks.from).toHaveBeenCalledWith("hotel-logos");
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(/^hotel-a-\d+\.png$/), expect.any(Buffer), expect.objectContaining({ contentType: "image/png" }));
  });

  it("returns an error when storage rejects the upload", async () => {
    mocks.upload.mockResolvedValue({ error: new Error("storage unavailable") });
    expect((await POST(request(new File(["data"], "logo.png", { type: "image/png" })))).status).toBe(500);
    expect(mocks.getPublicUrl).not.toHaveBeenCalled();
  });
});
