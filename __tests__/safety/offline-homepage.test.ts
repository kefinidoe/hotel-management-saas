import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  redirect: vi.fn((location: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as Error & { location?: string }).location = location;
    throw error;
  }),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import Home from "../../app/page";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDirectUrl = process.env.DIRECT_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;
  vi.clearAllMocks();
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDirectUrl === undefined) delete process.env.DIRECT_URL;
  else process.env.DIRECT_URL = originalDirectUrl;
});

describe("offline homepage preview", () => {
  it("redirects to login without loading database-backed auth when DATABASE_URL is absent", async () => {
    await expect(Home()).rejects.toMatchObject({ location: "/login" });
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
    expect(mocks.getServerSession).not.toHaveBeenCalled();
  });
});
