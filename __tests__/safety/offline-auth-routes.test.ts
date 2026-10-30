import { afterEach, describe, expect, it, vi } from "vitest";

const { prismaModuleLoaded, authModuleLoaded, nextAuthHandler } = vi.hoisted(() => ({
  prismaModuleLoaded: vi.fn(),
  authModuleLoaded: vi.fn(),
  nextAuthHandler: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  prismaModuleLoaded();
  return { prisma: {} };
});
vi.mock("@/lib/auth", () => {
  authModuleLoaded();
  return { authOptions: {} };
});
vi.mock("next-auth", () => ({
  __esModule: true,
  default: nextAuthHandler,
  getServerSession: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("database-backed authentication routes in offline preview", () => {
  it("returns 503 for registration without loading Prisma", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { POST } = await import("../../app/api/auth/register/route");
    const response = await POST(new Request("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Offline Test",
        email: "offline@example.invalid",
        password: "NotARealPassword123!",
      }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });
    expect(prismaModuleLoaded).not.toHaveBeenCalled();
  });

  it("returns 503 for membership and switch routes before loading database-backed auth", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const [{ GET }, { POST }] = await Promise.all([
      import("../../app/api/auth/memberships/route"),
      import("../../app/api/auth/switch-hotel/route"),
    ]);
    const membershipResponse = await GET();
    const switchResponse = await POST(new Request("http://localhost:3000/api/auth/switch-hotel", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ hotelId: "offline-hotel" }),
    }));

    expect(membershipResponse.status).toBe(503);
    expect(switchResponse.status).toBe(503);
    expect(prismaModuleLoaded).not.toHaveBeenCalled();
    expect(authModuleLoaded).not.toHaveBeenCalled();
  });

  it("returns 503 for invitation decisions without loading Prisma", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { POST } = await import("../../app/api/auth/invitations/[id]/route");
    const response = await POST(
      new Request("http://localhost:3000/api/auth/invitations/mem-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      }),
      { params: Promise.resolve({ id: "mem-1" }) }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });
    expect(prismaModuleLoaded).not.toHaveBeenCalled();
    expect(authModuleLoaded).not.toHaveBeenCalled();
  });

  it("returns 503 for NextAuth endpoints without evaluating the Prisma-backed auth config", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { GET } = await import("../../app/api/auth/[...nextauth]/route");
    const request = new Request("http://localhost:3000/api/auth/providers") as Request & {
      nextUrl: URL;
    };
    Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
    const response = await GET(request as never, { params: Promise.resolve({ nextauth: ["providers"] }) });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });
    expect(authModuleLoaded).not.toHaveBeenCalled();
    expect(nextAuthHandler).not.toHaveBeenCalled();
  });
});
