import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(), role: vi.fn(), module: vi.fn(), createClient: vi.fn(),
  from: vi.fn(), upload: vi.fn(), getPublicUrl: vi.fn(), audit: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.tenant,
  requireRole: mocks.role,
  requireModule: mocks.module,
  ROLE_GROUPS: { MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"] },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.audit }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
import { POST } from "@/app/api/settings/branding/upload/route";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
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
  mocks.from.mockReturnValue({ upload: mocks.upload, getPublicUrl: mocks.getPublicUrl, remove: mocks.remove });
  mocks.audit.mockResolvedValue(true);
  mocks.remove.mockResolvedValue({ error: null });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: "https://storage.example.test/logo.png" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("branding upload route", () => {
  it("rejects unauthorized users before storage access", async () => {
    mocks.role.mockReturnValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await POST(request(new File([png], "logo.png", { type: "image/png" })))).status).toBe(403);
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
    const response = await POST(request(new File([png], "logo.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-a", action: "HOTEL_LOGO_UPLOADED" }), undefined, { strict: true });
    expect(await response.json()).toEqual({ logoUrl: "https://storage.example.test/logo.png" });
    expect(mocks.from).toHaveBeenCalledWith("hotel-logos");
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(/^hotel-a\/[0-9a-f-]+\.png$/), expect.any(Buffer), expect.objectContaining({ contentType: "image/png" }));
  });

  it("rejects SVG and spoofed image types", async () => {
    expect((await POST(request(new File(["<svg />"], "logo.svg", { type: "image/svg+xml" })))).status).toBe(400);
    expect((await POST(request(new File(["not a png"], "logo.png", { type: "image/png" })))).status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("bounds the raw multipart body even when content length is absent", async () => {
    const body = new Uint8Array(2 * 1024 * 1024 + 65537);
    expect((await POST(new Request("https://example.test/api/settings/branding/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body }))).status).toBe(413);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("derives extensions from verified MIME and bytes, not the filename", async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224]);
    const response = await POST(request(new File([jpeg], "logo.svg", { type: "image/jpeg" })));
    expect(response.status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(/^hotel-a\/[0-9a-f-]+\.jpg$/), expect.any(Buffer), expect.objectContaining({ contentType: "image/jpeg", upsert: false }));
  });

  it("compensates a failed audit by removing the uploaded object", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    expect((await POST(request(new File([png], "logo.png", { type: "image/png" })))).status).toBe(500);
    expect(mocks.remove).toHaveBeenCalledWith([expect.stringMatching(/^hotel-a\//)]);
    expect(mocks.getPublicUrl).not.toHaveBeenCalled();
  });

  it("returns an error when storage rejects the upload", async () => {
    mocks.upload.mockResolvedValue({ error: new Error("storage unavailable") });
    expect((await POST(request(new File([png], "logo.png", { type: "image/png" })))).status).toBe(500);
    expect(mocks.getPublicUrl).not.toHaveBeenCalled();
  });
});
