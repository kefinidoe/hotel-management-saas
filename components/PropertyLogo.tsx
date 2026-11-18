"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";
import { isSafeLogoUrl } from "@/lib/branding";
import clsx from "clsx";

/** Only the browser loads external assets; failed or unsafe URLs use the icon. */
export default function PropertyLogo({ logoUrl, className }: { logoUrl: string | null | undefined; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const show = logoUrl && isSafeLogoUrl(logoUrl) && failedUrl !== logoUrl;
  return <span aria-hidden="true" className={clsx("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-white overflow-hidden", className)}>
    {show ? (
      // Remote tenant-managed URLs are not proxied through Next's image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain bg-white" onError={() => setFailedUrl(logoUrl)} />
    ) : <Building2 size={21} strokeWidth={1.9} />}
  </span>;
}
