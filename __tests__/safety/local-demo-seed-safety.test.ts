import { describe, expect, it } from "vitest";
import { assertLocalDemoSeedTarget } from "../../scripts/local-demo-seed-safety";

const validLocalTarget = {
  SAAS_ENVIRONMENT: "local",
  SAAS_ALLOW_LOCAL_DEMO_SEED: "true",
  DATABASE_URL: "postgresql://127.0.0.1:55432/hotel_saas_demo_test?schema=public",
  DIRECT_URL: "postgresql://127.0.0.1:55432/hotel_saas_demo_test?schema=public",
};

describe("local demo seed target guard", () => {
  it("allows an explicitly opted-in loopback demo database", () => {
    expect(() => assertLocalDemoSeedTarget(validLocalTarget)).not.toThrow();
  });

  it("requires the explicit local-demo opt-in", () => {
    expect(() =>
      assertLocalDemoSeedTarget({ ...validLocalTarget, SAAS_ALLOW_LOCAL_DEMO_SEED: undefined }),
    ).toThrow("SAAS_ALLOW_LOCAL_DEMO_SEED=true");
  });

  it("rejects a remote host", () => {
    expect(() =>
      assertLocalDemoSeedTarget({
        ...validLocalTarget,
        DATABASE_URL: "postgresql://project.supabase.co:5432/hotel_saas_demo_test",
      }),
    ).toThrow("loopback host");
  });

  it("rejects non-demo databases even on loopback", () => {
    expect(() =>
      assertLocalDemoSeedTarget({
        ...validLocalTarget,
        DATABASE_URL: "postgresql://127.0.0.1:55432/postgres",
        DIRECT_URL: "postgresql://127.0.0.1:55432/postgres",
      }),
    ).toThrow("hotel_saas_demo_<suffix>");
  });

  it.each([
    "host=remote.example",
    "HOST=remote.example",
    "hostaddr=192.0.2.1",
    "service=remote-service",
    "port=5432",
    "dbname=postgres",
  ])("rejects connection-target override parameter %s", (parameter) => {
    expect(() =>
      assertLocalDemoSeedTarget({
        ...validLocalTarget,
        DATABASE_URL: `postgresql://127.0.0.1:55432/hotel_saas_demo_test?${parameter}`,
      }),
    ).toThrow("cannot override the loopback connection target");
  });

  it("rejects a remote or mismatched direct URL", () => {
    expect(() =>
      assertLocalDemoSeedTarget({
        ...validLocalTarget,
        DIRECT_URL: "postgresql://127.0.0.1:5432/hotel_saas_demo_test",
      }),
    ).toThrow("same local demo database");
  });
});
