// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PropertyLogo from "@/components/PropertyLogo";
import Sidebar from "@/components/Sidebar";
import BrandingSettings from "@/components/settings/BrandingSettings";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ refresh: mockRefresh }) }));
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => { mockRefresh.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

it("changes sidebar branding when the active property changes, and falls back on image errors", () => {
  const { rerender, container } = render(<Sidebar userRole={"MANAGER" as never} hotelName="Kim Resort" logoUrl="https://example.test/kim.png" />);
  expect(screen.getByRole("link", { name: "Kim Resort dashboard" })).toBeTruthy();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/kim.png");
  rerender(<Sidebar userRole={"MANAGER" as never} hotelName="James Resort" logoUrl="https://example.test/james.png" />);
  expect(screen.getByRole("link", { name: "James Resort dashboard" })).toBeTruthy();
  expect(screen.queryByText("Kim Resort")).toBeNull();
  const image = container.querySelector("img")!;
  expect(image.getAttribute("src")).toBe("https://example.test/james.png");
  fireEvent.error(image);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeTruthy();
});

it("never renders insecure or executable URLs", () => {
  const { container } = render(<PropertyLogo logoUrl="javascript:alert(1)" />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeTruthy();
});

it("saves name and URL, then refreshes the active dashboard without re-login", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
    ? response({ name: "Kim Grand", logoUrl: "https://example.test/updated.png" })
    : response({ name: "Kim Resort", logoUrl: null }));
  vi.stubGlobal("fetch", fetchMock);
  render(<BrandingSettings />);
  const name = await screen.findByLabelText("Branding property name");
  fireEvent.change(name, { target: { value: "Kim Grand" } });
  fireEvent.change(screen.getByLabelText("Logo image URL"), { target: { value: "https://example.test/updated.png" } });
  fireEvent.click(screen.getByRole("button", { name: "Save branding" }));
  await waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith("/api/settings/branding", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Kim Grand", logoUrl: "https://example.test/updated.png" }) }));
  expect(screen.getByText("Branding saved.")).toBeTruthy();
});
