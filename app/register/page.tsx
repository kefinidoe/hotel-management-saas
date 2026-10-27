"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import HotelFlowBrand from "@/components/HotelFlowBrand";
import { PRODUCT_NAME } from "@/lib/brand";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not complete registration.");
        setLoading(false);
        return;
      }

      // Auto sign-in
      const signInRes = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (signInRes?.error) {
        // Fall back to login page if immediate auto-auth fails
        router.push("/login?message=AccountCreated");
        return;
      }

      // Direct to hotel onboarding
      router.push("/onboarding");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <HotelFlowBrand />
        </div>
        <h1 className="text-xl font-bold mb-1 text-center">Create your {PRODUCT_NAME} account</h1>
        <p className="text-text-secondary text-sm mb-6 text-center">
          Set up your hotel management workspace.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Full Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-control border border-border px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="e.g. Jane Doe"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Work Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-control border border-border px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="owner@yourhotel.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Phone Number (Optional)
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-control border border-border px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="+254 700 000 000"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-control border border-border px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="At least 8 characters"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Confirm Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-control border border-border px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="Confirm password"
            />
          </div>

          {error && (
            <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? "Creating Account..." : "Create Account & Continue"}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-text-secondary border-t border-border pt-4">
          Already using {PRODUCT_NAME}?{" "}
          <Link href="/login" className="text-primary-600 hover:underline font-medium">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
