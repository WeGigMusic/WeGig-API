# Support payments: API foundation

This patch adds authenticated GET /support/status and POST /support/verify.
Payments remain unavailable unless SUPPORT_PAYMENTS_ENABLED=true. Do not enable
this in production until the mobile purchase flow and refund handling are ready.

## Install and check locally

Run npm install, npm run build, then node --test tests/supportPolicy.test.cjs.
The build requires your existing API environment, including DATABASE_URL.
The new migration is additive and does not change Gig or Artist data.
Run npm run migrate:deploy only against the intended database after reviewing it.
Do not use prisma migrate reset or prisma db push for this change.

## Server-only configuration (next stage)

- APPLE_IAP_PRIVATE_KEY_PATH: filesystem path to the Apple In-App Purchase key
  PEM (.p8). Use a secret file on the server, never the mobile app or git.
- APPLE_IAP_KEY_ID and APPLE_IAP_ISSUER_ID: that key's identifiers.
- APPLE_IAP_APP_ID: numeric App Store Connect app ID (6778116125 for WeGig).
- GOOGLE_PLAY_SERVICE_ACCOUNT_PATH: secret JSON file with Android Publisher
  access to WeGig and permission to view/manage purchases.
- IAP_TEST_USER_IDS: comma-separated Supabase user UUIDs explicitly permitted
  to verify sandbox/test purchases. Never grant production status for these.
- SUPPORT_PAYMENTS_ENABLED: leave unset until the remaining implementation and
  live store tests are complete.

The checked-in Apple certificates are public trust roots, not private keys.
They were downloaded from Apple's certificate authority website.

## Mobile contract

Use the authenticated status response's appleAppAccountToken or
Google googleObfuscatedAccountId when starting a purchase. The API rejects
purchases without the matching account binding.

POST /support/verify takes {platform:"apple", productId, transactionId} or
{platform:"google", productId, purchaseToken}. Only finish/consume a transaction
after verified:true; retry server/network failures without granting a badge.
Pending purchases must wait for the store's completion event.

Production bundle/package IDs are com.wegig.mobile and com.wegig.app. The .dev
variants do not share those store catalogues. Google IDs must use
com.wegig.app.support. plus small, medium, large, extra1, extra20, extra50 or
extra100. Apple uses com.wegig.mobile.support. with the same suffixes.

## Privacy and remaining release work

No email, payment-card details, receipt payload, private key, or raw Google
purchase token is stored in SupportPurchase. It stores the user's UUID, store,
environment, product ID, transaction identifier (hashed Google token), and dates.
The transaction unique constraint prevents duplicate recording across retries.
Provider errors are not logged because they can contain purchase tokens.

Still required before release: mobile billing integration, store credentials,
real sandbox/TestFlight and Play internal-test purchases, database migration
validation against a test PostgreSQL database, refund/revocation notification
processing, and account deletion/retention handling for purchase records.
Status currently reflects recorded verified purchases; it does not automatically
remove supporter status for a refund issued after verification. Do not enable
production payments until that lifecycle is implemented.

Validation performed for this patch: Prisma Client generation, TypeScript build,
and seven automated policy tests. No real store calls or database migration were
performed, because store credentials and a test database were not supplied.
