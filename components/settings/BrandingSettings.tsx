"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PropertyLogo from "@/components/PropertyLogo";
import { apiErrorMessage, requestJson } from "@/lib/client-api";
import { isSafeLogoUrl } from "@/lib/branding";

type Branding = { name: string; logoUrl: string | null };

export default function BrandingSettings({ initialName }: { initialName?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => { if (initialName !== undefined) setName(initialName); }, [initialName]);

  useEffect(() => {
    let cancelled = false;
    requestJson<Branding>("/api/settings/branding").then((brand) => {
      if (!cancelled) { setName(brand.name); setLogoUrl(brand.logoUrl ?? ""); }
    }).catch((failure) => { if (!cancelled) setError(apiErrorMessage(failure, "Could not load branding.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const cleanUrl = logoUrl.trim();
    if (cleanUrl && !isSafeLogoUrl(cleanUrl)) { setError("Enter a valid HTTPS logo URL without credentials."); return; }
    setSaving(true); setError(null); setSuccess(false);
    try {
      const updated = await requestJson<Branding>("/api/settings/branding", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), logoUrl: cleanUrl || null }),
      });
      setName(updated.name); setLogoUrl(updated.logoUrl ?? ""); setSuccess(true);
      router.refresh();
    } catch (failure) { setError(apiErrorMessage(failure, "Could not save branding.")); }
    finally { setSaving(false); }
  }

  return <section className="card border border-border p-5 space-y-4" aria-labelledby="branding-title">
    <h2 id="branding-title" className="text-base font-semibold">Property Branding</h2>
    <p className="text-sm text-text-secondary">Add a publicly accessible HTTPS image URL, or leave it blank to use the default property icon. Your browser loads the image from its host.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {success && <p role="status" className="text-sm text-success">Branding saved.</p>}
    {loading ? <p>Loading branding…</p> : !error || name ? <form onSubmit={save} className="space-y-3">
      <div className="flex items-center gap-3"><PropertyLogo logoUrl={logoUrl.trim()} /><span className="font-medium">{name || "Property name"}</span></div>
      <label className="block text-sm">Property name<input aria-label="Branding property name" required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-control border border-border p-2" /></label>
      <label className="block text-sm">Logo image URL<input aria-label="Logo image URL" type="url" maxLength={2048} placeholder="https://example.com/logo.png" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} className="w-full rounded-control border border-border p-2" /></label>
      <button className="btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save branding"}</button>
    </form> : null}
  </section>;
}
