import { HotelStatus } from "@prisma/client";
import { SubscriptionStatus } from "@/lib/plans";

/** PAST_DUE, RESTRICTED, and READ_ONLY have no HotelStatus enum equivalent.
 * Access restrictions are enforced by subscription entitlements while the hotel remains ACTIVE. */
export function hotelStatusForSubscription(status: SubscriptionStatus): HotelStatus {
  if (
    status === SubscriptionStatus.PAST_DUE ||
    status === SubscriptionStatus.RESTRICTED ||
    status === SubscriptionStatus.READ_ONLY
  ) {
    return HotelStatus.ACTIVE;
  }
  return status as HotelStatus;
}

/** Do not clear an overdue or restricted billing state merely because an operator enables a hotel. */
export function subscriptionStatusForHotel(status: HotelStatus, current: SubscriptionStatus): SubscriptionStatus {
  if (
    status === HotelStatus.ACTIVE &&
    (current === SubscriptionStatus.PAST_DUE ||
      current === SubscriptionStatus.RESTRICTED ||
      current === SubscriptionStatus.READ_ONLY)
  ) {
    return current;
  }
  return status as SubscriptionStatus;
}
