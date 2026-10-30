-- PROPOSAL ONLY — untracked migration draft; not applied or approved for deployment.
-- Department is hotel-specific staff metadata, not a global user profile field.
-- Add it as nullable; keep User.department for compatibility during transition.
ALTER TABLE "HotelMembership" ADD COLUMN "department" TEXT;

-- A legacy user department is unambiguous only when the user has exactly one
-- hotel membership. Leave multi-hotel memberships NULL rather than guessing.
UPDATE "HotelMembership" AS membership
SET "department" = staff."department"
FROM "User" AS staff
WHERE staff."id" = membership."userId"
  AND staff."department" IS NOT NULL
  AND membership."department" IS NULL
  AND (
    SELECT COUNT(*)
    FROM "HotelMembership" AS membership_count
    WHERE membership_count."userId" = membership."userId"
  ) = 1;
