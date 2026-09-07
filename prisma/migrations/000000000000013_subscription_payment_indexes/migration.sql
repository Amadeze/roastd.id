-- Migration: subscription_payment_indexes (013)
-- Query superadmin (/superadmin/subscriptions) memfilter status (aggregate PENDING)
-- dan mengurutkan createdAt lintas tenant tanpa index — sebelumnya seq scan penuh.

CREATE INDEX IF NOT EXISTS "subscription_payments_status_idx"
  ON "subscription_payments" ("status");

CREATE INDEX IF NOT EXISTS "subscription_payments_createdAt_idx"
  ON "subscription_payments" ("createdAt");
