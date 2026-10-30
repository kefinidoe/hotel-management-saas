import { Building2 } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/brand";
import clsx from "clsx";

type HotelFlowBrandProps = {
  className?: string;
  iconOnly?: boolean;
  iconClassName?: string;
  light?: boolean;
};

export default function HotelFlowBrand({
  className,
  iconOnly = false,
  iconClassName,
  light = false,
}: HotelFlowBrandProps) {
  return (
    <span className={clsx("inline-flex items-center gap-2.5", className)}>
      <span
        className={clsx(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white",
          iconClassName
        )}
        aria-hidden="true"
      >
        <Building2 size={21} strokeWidth={1.9} />
      </span>
      {!iconOnly && (
        <span
          className={clsx(
            "text-lg font-bold tracking-tight",
            light ? "text-sidebar-text" : "text-text-primary"
          )}
        >
          {PRODUCT_NAME}
        </span>
      )}
    </span>
  );
}
