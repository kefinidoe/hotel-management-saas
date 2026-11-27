import { HotelStatus } from "@prisma/client";
import { SubscriptionStatus } from "@/lib/plans";

/** PAST_DUE has no hotel enum equivalent. Its grace period is enforced by the
 * subscription entitlement, while the hotel remains ACTIVE. */
export function hotelStatusForSubscription(status: SubscriptionStatus): HotelStatus {
  return status === SubscriptionStatus.PAST_DUE ? HotelStatus.ACTIVE : status as HotelStatus;
}

/** Do not clear an overdue billing state merely because an operator enables a hotel. */
export function subscriptionStatusForHotel(status: HotelStatus, current: SubscriptionStatus): SubscriptionStatus {
  return status === HotelStatus.ACTIVE && current === SubscriptionStatus.PAST_DUE
    ? SubscriptionStatus.PAST_DUE : status as SubscriptionStatus;
}
