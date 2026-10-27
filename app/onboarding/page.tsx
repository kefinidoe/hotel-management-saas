"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import HotelFlowBrand from "@/components/HotelFlowBrand";
import { Building2, Globe, MapPin, Phone, Mail, DollarSign, Clock, ArrowRight } from "lucide-react";

const CURRENCIES = [
  { code: "KES", label: "KES — Kenyan Shilling" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — British Pound" },
  { code: "TZS", label: "TZS — Tanzanian Shilling" },
  { code: "UGX", label: "UGX — Ugandan Shilling" },
  { code: "RWF", label: "RWF — Rwandan Franc" },
  { code: "ZAR", label: "ZAR — South African Rand" },
  { code: "AED", label: "AED — UAE Dirham" },
];

const TIMEZONES = [
  "Africa/Nairobi",
  "UTC",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Cairo",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [currency, setCurrency] = useState("KES");
  const [timezone, setTimezone] = useState("Africa/Nairobi");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleNameChange(val: string) {
    setName(val);
    if (!slugEdited) {
      setSlug(slugify(val));
    }
  }

  function handleSlugChange(val: string) {
    setSlug(val.toLowerCase().replace(/[^a-z0-9-]/g, ""));
    setSlugEdited(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          slug: slug || slugify(name),
          currency,
          timezone,
          email,
          phone,
          address,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || data.error || "Could not create hotel workspace.");
        setLoading(false);
        return;
      }

      // Successfully onboarded and cookie set. Navigate to dashboard.
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-bg flex items-center justify-center p-4 py-8">
      <div className="card w-full max-w-xl shadow-lg border border-border">
        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-border">
          <HotelFlowBrand iconOnly iconClassName="h-10 w-10 rounded-lg" />
          <div>
            <h1 className="text-xl font-bold text-text-primary">Set Up Your Hotel Workspace</h1>
            <p className="text-text-secondary text-xs mt-0.5">
              Configure your property identity and operational details. You will become the primary Hotel Owner.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Hotel Name */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
              <Building2 size={16} className="text-primary-600" /> Hotel / Property Name
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={100}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Grand View Resort & Spa"
              className="w-full rounded-control border border-border px-3.5 py-2.5 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>

          {/* Workspace Slug */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
              <Globe size={16} className="text-primary-600" /> Workspace Identifier (Slug)
            </label>
            <div className="flex items-center rounded-control border border-border bg-bg/50 px-3 py-1.5 focus-within:ring-2 focus-within:ring-primary-500">
              <span className="text-xs text-text-muted select-none">app/hotels/</span>
              <input
                type="text"
                required
                minLength={2}
                maxLength={60}
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="grand-view-resort"
                className="w-full bg-transparent border-0 px-1 py-1 text-sm font-mono focus:outline-none"
              />
            </div>
            <p className="text-xs text-text-muted mt-1">
              Unique URL-safe identifier for your hotel workspace. Letters, numbers, and hyphens only.
            </p>
          </div>

          {/* Currency and Timezone Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <DollarSign size={16} className="text-primary-600" /> Operational Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-control border border-border px-3 py-2 text-sm bg-surface
                           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <Clock size={16} className="text-primary-600" /> Operational Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-control border border-border px-3 py-2 text-sm bg-surface
                           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Contact Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <Mail size={16} className="text-primary-600" /> Contact Email (Optional)
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="info@yourhotel.com"
                className="w-full rounded-control border border-border px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <Phone size={16} className="text-primary-600" /> Contact Phone (Optional)
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+254 700 000 000"
                className="w-full rounded-control border border-border px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
              <MapPin size={16} className="text-primary-600" /> Physical Address (Optional)
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. 100 Flamingo Road, Nakuru, Kenya"
              className="w-full rounded-control border border-border px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>

          {error && (
            <div className="p-3 rounded-control bg-danger/10 border border-danger/20 text-danger text-sm">
              {error}
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="btn-primary w-full py-2.5 flex items-center justify-center gap-2 text-base font-semibold"
            >
              {loading ? (
                "Setting Up Workspace..."
              ) : (
                <>
                  Complete Setup & Enter Workspace <ArrowRight size={18} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
