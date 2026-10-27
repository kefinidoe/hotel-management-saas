"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Building2, Plus, LogOut, ArrowRight, ShieldCheck } from "lucide-react";

type MembershipItem = {
  id: string;
  hotelId: string;
  hotelName: string;
  hotelSlug: string;
  role: string;
  status: string;
};

export default function SelectHotelPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<MembershipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadMemberships() {
      try {
        const res = await fetch("/api/auth/memberships");
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        const data = await res.json();
        setMemberships(data.memberships || []);
      } catch {
        setError("Failed to load your hotel workspaces.");
      } finally {
        setLoading(false);
      }
    }
    loadMemberships();
  }, [router]);

  async function handleSelect(hotelId: string) {
    setError(null);
    setSwitchingId(hotelId);
    try {
      const res = await fetch("/api/auth/switch-hotel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Could not switch to hotel workspace.");
        setSwitchingId(null);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error while selecting workspace.");
      setSwitchingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="card w-full max-w-lg shadow-lg border border-border">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <Image
              src="/axis-hotel-mark.png"
              alt="Hotel Management"
              width={40}
              height={40}
              className="w-10 h-10 object-contain rounded-lg"
            />
            <div>
              <h1 className="text-xl font-bold text-text-primary">Select Hotel Workspace</h1>
              <p className="text-text-secondary text-xs">
                Choose the property workspace you wish to manage.
              </p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            title="Sign out"
            className="text-text-muted hover:text-danger p-1 rounded-md"
          >
            <LogOut size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-control bg-danger/10 border border-danger/20 text-danger text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            Loading your hotel workspaces...
          </div>
        ) : memberships.length === 0 ? (
          <div className="py-6 text-center">
            <Building2 size={36} className="mx-auto text-text-muted mb-2 opacity-60" />
            <p className="text-sm font-medium text-text-primary">No Active Workspaces Found</p>
            <p className="text-xs text-text-secondary mt-1 max-w-xs mx-auto">
              You are not currently a member of any operational hotel. Create your own hotel workspace to get started.
            </p>
            <Link
              href="/onboarding"
              className="btn-primary inline-flex items-center gap-2 mt-4 text-xs font-semibold"
            >
              <Plus size={16} /> Set Up New Hotel
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {memberships.map((m) => (
              <div
                key={m.id}
                onClick={() => !switchingId && handleSelect(m.hotelId)}
                className={`p-4 rounded-xl border border-border bg-surface hover:border-primary-400 hover:shadow-md transition-all cursor-pointer flex items-center justify-between group ${
                  switchingId === m.hotelId ? "opacity-60 pointer-events-none" : ""
                }`}
              >
                <div className="flex items-center gap-3.5">
                  <div className="w-10 h-10 rounded-lg bg-primary-50 text-primary-700 flex items-center justify-center font-bold text-base">
                    {m.hotelName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-text-primary group-hover:text-primary-700 transition-colors">
                      {m.hotelName}
                    </h3>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-text-muted font-mono">@{m.hotelSlug}</span>
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary-100/70 text-primary-800 font-medium">
                        <ShieldCheck size={11} /> {m.role.replace("_", " ")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    disabled={switchingId === m.hotelId}
                    className="btn-secondary text-xs px-3 py-1.5 rounded-lg group-hover:bg-primary-600 group-hover:text-white group-hover:border-primary-600 transition-all flex items-center gap-1"
                  >
                    {switchingId === m.hotelId ? "Loading..." : "Enter"}
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            ))}

            <div className="pt-3 border-t border-border flex items-center justify-between">
              <span className="text-xs text-text-muted">Need to onboard another property?</span>
              <Link
                href="/onboarding"
                className="text-xs font-medium text-primary-600 hover:underline inline-flex items-center gap-1"
              >
                <Plus size={14} /> New Hotel Workspace
              </Link>
            </div>

            <div className="pt-2 text-center">
              <Link
                href="/platform"
                className="text-[11px] text-text-secondary hover:text-purple-700 transition-colors inline-flex items-center gap-1 font-medium"
              >
                Platform Operator Console &rarr;
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
