"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BrandingSettings from "./BrandingSettings";
import ModularPricingSettings from "./ModularPricingSettings";
import { Building2, Save, Globe, DollarSign, Clock, Mail, Phone, MapPin, Check, AlertCircle } from "lucide-react";

type HotelData = {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  currency: string;
  timezone: string;
  status: string;
  updatedAt: string;
};

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

export default function HotelSettingsClient({
  initialHotel,
  userRole,
}: {
  initialHotel: HotelData;
  userRole: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialHotel.name);
  useEffect(() => { setName(initialHotel.name); }, [initialHotel.name]);
  const [email, setEmail] = useState(initialHotel.email || "");
  const [phone, setPhone] = useState(initialHotel.phone || "");
  const [address, setAddress] = useState(initialHotel.address || "");
  const [currency, setCurrency] = useState(initialHotel.currency);
  const [timezone, setTimezone] = useState(initialHotel.timezone);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const res = await fetch("/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: email || null,
          phone: phone || null,
          address: address || null,
          currency,
          timezone,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not save settings.");
        setSaving(false);
        return;
      }

      setMessage("Hotel settings updated successfully.");
      router.refresh();
    } catch {
      setError("Network error while saving settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Hotel Settings</h1>
        <p className="text-text-secondary text-sm mt-0.5">
          Configure property identity, contact information, currency, and operational timezone.
        </p>
      </div>

      {message && (
        <div className="p-3.5 rounded-xl bg-success/10 border border-success/20 text-success text-sm flex items-center gap-2">
          <Check size={18} /> {message}
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/20 text-danger text-sm flex items-center gap-2">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Identity & Workspace Card */}
        <div className="card border border-border p-5 space-y-4 shadow-sm">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Building2 size={18} className="text-primary-600" /> Property Identity
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Hotel / Property Name
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-control border border-border px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <Globe size={14} className="text-text-muted" /> Workspace Slug (Read-only)
              </label>
              <div className="flex items-center rounded-control border border-border bg-bg px-3 py-2 text-sm text-text-secondary font-mono">
                @{initialHotel.slug}
                <span className="ml-auto badge bg-emerald-50 text-emerald-700 text-[10px] px-2 py-0.5">
                  {initialHotel.status}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Currency & Localization Card */}
        <div className="card border border-border p-5 space-y-4 shadow-sm">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <DollarSign size={18} className="text-primary-600" /> Localization & Billing
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Base Operating Currency
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
              <p className="text-xs text-text-muted mt-1">
                Used for folio charges, invoices, reports, and restaurant orders.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <Clock size={14} className="text-text-muted" /> Property Timezone
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
              <p className="text-xs text-text-muted mt-1">
                Controls audit logs, check-in schedules, and end-of-day reports.
              </p>
            </div>
          </div>

          <div className="pt-3 border-t border-border flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold text-text-primary">SaaS Subscription & Room Bands</h3>
              <p className="text-xs text-text-muted">Manage property room-band capacity, pricing calculations, and billing intervals.</p>
            </div>
            <a
              href="/dashboard/subscription"
              className="px-3 py-1.5 rounded-control text-xs font-semibold bg-primary-50 text-primary-700 hover:bg-primary-100 border border-primary-200 transition-colors"
            >
              Open Subscription Dashboard
            </a>
          </div>
        </div>

        {/* Contact & Location Card */}
        <div className="card border border-border p-5 space-y-4 shadow-sm">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Mail size={18} className="text-primary-600" /> Contact & Location
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Official Contact Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="reception@yourhotel.com"
                className="w-full rounded-control border border-border px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
                <Phone size={14} className="text-text-muted" /> Front Desk Phone
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
              <MapPin size={14} className="text-text-muted" /> Physical Street Address
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
        </div>

        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-text-muted">
            Logged in as: <strong className="text-text-primary">{userRole.replace("_", " ")}</strong>
          </span>

          <button
            type="submit"
            disabled={saving}
            className="btn-primary flex items-center gap-2 px-5 py-2 text-sm font-semibold shadow-sm"
          >
            <Save size={16} />
            {saving ? "Saving Changes..." : "Save Settings"}
          </button>
        </div>
      </form>
      {["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"].includes(userRole) && <><BrandingSettings initialName={initialHotel.name} /><ModularPricingSettings currency={currency} /></>}
    </div>
  );
}
