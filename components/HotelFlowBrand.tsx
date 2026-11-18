import { Building2 } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/brand";
import clsx from "clsx";

type HotelFlowBrandProps = {
  className?: string;
  iconOnly?: boolean;
  iconClassName?: string;
  light?: boolean;
  hotelName?: string | null;
  hotelLogo?: string | null;
};

export default function HotelFlowBrand({
  className,
  iconOnly = false,
  iconClassName,
  light = false,
  hotelName,
  hotelLogo,
}: HotelFlowBrandProps) {
  const displayName = hotelName || PRODUCT_NAME;

  return (
    <span className={clsx("inline-flex items-center gap-2.5", className)}>
      <span
        className={clsx(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl overflow-hidden bg-primary-500 text-white shadow-sm border border-white/10",
          iconClassName
        )}
        aria-hidden="true"
      >
        {hotelLogo ? (
          <img src={hotelLogo} alt={displayName} className="w-full h-full object-cover" />
        ) : (
          <Building2 size={21} strokeWidth={1.9} />
        )}
      </span>
      {!iconOnly && (
        <span
          className={clsx(
            "text-lg font-bold tracking-tight truncate max-w-[160px]",
            light ? "text-sidebar-text" : "text-text-primary"
          )}
          title={displayName}
        >
          {displayName}
        </span>
      )}
    </span>
  );
}