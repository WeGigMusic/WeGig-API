# Support payment refund notifications

This patch adds verified server notifications and an additive database migration.
It does not issue refunds or move money. Apple and Google decide and process
refunds; these endpoints update the corresponding contribution's status.

## Review and check

Run npm run build, then
node --test tests/supportPolicy.test.cjs tests/supportRefundPolicy.test.cjs.
These 16 policy tests do not connect to a database or the stores.

Additional tests live in tests/supportRefundLedger.test.cjs and
 tests/supportNotifications.test.cjs. They require SUPPORT_TEST_DATABASE_URL
pointing to a dedicated LOCAL PostgreSQL database whose name ends in _test.
They never fall back to the normal DATABASE_URL. Apply the migrations to that
test database first, then run both files with node --test. Do not point these
tests at your hosted database. Tests create uniquely identified records and
remove their own fixtures afterwards.

Validation performed here: TypeScript build, all 16 policy tests, and 10 HTTP/
ledger integration tests against a fresh temporary PostgreSQL 18 database. All
three migrations applied successfully there. The tests cover concurrent claims,
refund-before-confirmation, simultaneous refund/confirmation, preserving other
contributions, Apple refund reversals, stale/replayed events, sandbox separation,
and rejecting forged/unsigned notifications. No real store notification, live
store purchase or hosted database has been exercised.

## Database behaviour

SupportPurchase gains nullable revokedAt. SupportStoreState holds the latest
refund decision per store/environment/transaction, including notifications that
arrive before a purchase claim. A PostgreSQL transaction advisory lock is shared
by verification and notification handling for each transaction. This prevents
concurrent requests from reactivating a refunded contribution.

Older events cannot override newer ones. Repeated events are idempotent. Apple
REFUND_REVERSED can restore a previously refunded contribution. At an identical
event timestamp, revocation takes precedence. Only unrevoked contributions count
towards supporter status. Another unrefunded contribution preserves the badge.
Test-store events remain separate from production. Refund requests, declined
refunds, subscriptions and unrelated products do not revoke support payments.

The mobile app refreshes supporter status when launched, brought to the
foreground, or when Retry confirmation is tapped. It does not instantly push a
badge change to a phone while that phone is idle.

## Configuration after deployment (do not enable payments yet)

Use your actual public HTTPS API origin in place of API_URL.

Apple App Store Server Notifications Version 2:
- Production URL: API_URL/support/notifications/apple/production
- Sandbox URL: API_URL/support/notifications/apple/sandbox
- APPLE_IAP_APP_ID must be set to 6778116125. The bundled public Apple trust roots
  verify the outer notification and nested transaction, with matching app and
  environment. The Apple private API key is not used to authenticate these pushes.

Google Play RTDN, with a wrapped authenticated Pub/Sub push subscription:
- URL: API_URL/support/notifications/google
- GOOGLE_PLAY_PUBSUB_AUDIENCE: exactly the audience configured for that push
  subscription, normally the complete URL above.
- GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT: exact email of the push-auth service account.
- GOOGLE_PLAY_PUBSUB_SUBSCRIPTION: full projects/PROJECT/subscriptions/SUBSCRIPTION.
- GOOGLE_PLAY_SERVICE_ACCOUNT_PATH: existing Android Publisher secret JSON path.
- Enable one-time product and voided-purchase notifications for com.wegig.app.
- Restrict who can publish to the topic and impersonate the push-auth account.
  Follow Google's Pub/Sub authentication setup; do not use an unauthenticated
  push subscription. Configure retry/dead-letter handling and review failures.

The route verifies Google's ID-token signature, expiry, audience, issuer and
verified service-account email, plus the subscription and app package. It reads
purchase details from Android Publisher and hashes the token before storage.
No raw receipt, signed payload, Google purchase token or provider exception is
written to application logs or the database.

Set SUPPORT_NOTIFICATIONS_ENABLED=true only once migrations and notification
configuration are ready. It stays independent of SUPPORT_PAYMENTS_ENABLED, so
refund handling continues if new contributions are disabled. The purchase API
now requires BOTH flags to accept purchases or expose payment account details.
Do not enable new payments until store tests and the remaining release work pass.

## Delivery and remaining release work

A notification is acknowledged only after a successful database commit. Database
and temporary provider failures return a retryable non-success response. Apple
and Pub/Sub delivery can be delayed or exhaust retries: monitor endpoint failures
and dead-letter messages, and recover missed events through Apple's notification
history or Google Play's Voided Purchases API before treating status as current.
This patch does not add a scheduled historical reconciliation job.

Still required: account-deletion/retention handling for purchase records, store
credentials and notification configuration, real sandbox/internal-test purchases
and refunds, and deployment/migration of the reviewed changes. Keep payments off
until these are completed. No new npm dependencies are introduced by this patch.

Primary references:
- https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
- https://developer.android.com/google/play/billing/rtdn-reference
- https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
