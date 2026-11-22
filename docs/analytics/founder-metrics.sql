-- Run manually as an authorised administrator only, after confirming the
-- reporting purpose and lawful basis. Not an app endpoint or migration.
-- Assumes Prisma tables and Supabase auth are in this database.
-- UTC reporting dates; current records only, excludes deleted records.
BEGIN TRANSACTION READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '15s';

SELECT count(*) AS registered_accounts FROM auth.users;
SELECT date_trunc('month', created_at)::date AS month, count(*) AS registrations
FROM auth.users GROUP BY 1 ORDER BY 1 DESC;

SELECT count(*) AS gigs,
 count(DISTINCT "userId") AS users_with_gigs,
 count(*) FILTER (WHERE "date" >= current_date::text) AS upcoming_or_today,
 count(*) FILTER (WHERE "date" < current_date::text) AS past,
 round(count(*)::numeric / nullif(count(DISTINCT "userId"),0),2) AS mean_gigs_per_logger
FROM public."Gig";

SELECT date_trunc('week', "createdAt")::date AS week,
 count(*) AS gigs_added, count(DISTINCT "userId") AS distinct_gig_loggers
FROM public."Gig" WHERE "createdAt" >= now() - interval '12 weeks'
GROUP BY 1 ORDER BY 1 DESC;

-- Suppress small groups; never expose individual gig histories.
SELECT lower(trim(artist)) AS artist, count(*) AS gigs
FROM public."Gig" GROUP BY 1 HAVING count(DISTINCT "userId") >= 5
ORDER BY 2 DESC LIMIT 20;
SELECT lower(trim(city)) AS city, count(*) AS gigs
FROM public."Gig" GROUP BY 1 HAVING count(DISTINCT "userId") >= 5
ORDER BY 2 DESC LIMIT 20;
SELECT lower(trim(venue)) AS venue, lower(trim(city)) AS city, count(*) AS gigs
FROM public."Gig" GROUP BY 1,2 HAVING count(DISTINCT "userId") >= 5
ORDER BY 3 DESC LIMIT 20;

-- Check actual environment labels before interpreting purchase counts.
-- Product quantities are not net revenue; reconcile against store reports.
SELECT platform, environment, "productId", count(*) AS recorded_purchases,
 count(*) FILTER (WHERE "revokedAt" IS NOT NULL) AS revoked,
 count(*) FILTER (WHERE "revokedAt" IS NULL) AS not_revoked
FROM public."SupportPurchase" GROUP BY 1,2,3 ORDER BY 1,2,3;
ROLLBACK;
