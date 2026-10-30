# Handover evidence

`owner-handover-verification.txt` is the output of

    node scripts/owner-test/verify-handover.mjs

run against the preview instance (port 3100, database `hotel_saas_demo_owner`) on
2026-10-30, immediately after `owner:env reset`. It signs in as every demo account
with its own password, records the page matrix each role opens, switches the owner
between Riverside Grand and Lakeview Lodge and back, and creates then removes a
temporary receptionist to prove that removal revokes access. 69/69 checks.

No password appears in the file: the script prints roles and e-mails only.
