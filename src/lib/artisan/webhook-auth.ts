import { Prisma } from "@prisma/client";
import { hashWebhookToken } from "@/lib/artisan/connector-auth";
import { timingSafeEqualText } from "@/lib/webhook-inbox";

 
type TransactionClient = any;

const TENANT_SELECT = {
  id: true,
  isActive: true,
  isArtisanEnabled: true,
  subscriptionTier: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  nextBillingDate: true,
} as const;

type TenantByTokenRow = Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }> & {
  artisanWebhookTokenHash: string | null;
};

type TenantByLegacyRow = Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }> & {
  artisanWebhookToken: string | null;
  artisanWebhookTokenHash: string | null;
};

/**
 * Resolve the tenant that owns an Artisan webhook bearer token.
 *
 * Tokens are stored hashed (sha256 with pepper). Newly provisioned tokens are
 * matched by `artisanWebhookTokenHash`. Tokens that predate hashing are matched
 * through the legacy plaintext column with a timing-safe equality check, and
 * lazily migrated to the hashed column so connectors keep working.
 *
 * Returns the tenant row or null when the token matches nothing.
 */
export async function findTenantByArtisanWebhookToken(
  client: TransactionClient,
  token: string,
): Promise<TenantByTokenRow | null> {
  const tokenHash = hashWebhookToken(token);

  const byHash = (await client.tenant.findUnique({
    where: { artisanWebhookTokenHash: tokenHash },
    select: { ...TENANT_SELECT, artisanWebhookTokenHash: true },
  })) as TenantByTokenRow | null;
  if (byHash) {
    // Defense in depth: the unique-index lookup already matched the exact
    // digest; re-verify with a timing-safe comparison anyway.
    return timingSafeEqualText(byHash.artisanWebhookTokenHash ?? "", tokenHash)
      ? byHash
      : null;
  }

  const byLegacy = (await client.tenant.findFirst({
    where: { artisanWebhookToken: token },
    select: { ...TENANT_SELECT, artisanWebhookToken: true, artisanWebhookTokenHash: true },
  })) as TenantByLegacyRow | null;
  if (!byLegacy || !timingSafeEqualText(byLegacy.artisanWebhookToken ?? "", token)) {
    return null;
  }

  if (byLegacy.artisanWebhookTokenHash !== tokenHash) {
    await client.tenant
      .update({
        where: { id: byLegacy.id },
        data: { artisanWebhookTokenHash: tokenHash },
        select: { id: true },
      })
      .catch(() => undefined);
    byLegacy.artisanWebhookTokenHash = tokenHash;
  }
  return byLegacy;
}
