/**
 * Canonical owner identity configuration.
 *
 * NOTE: The fallback default matches the existing repository owner ID to prevent
 * orphaning existing stored database records. The repository owner should set the
 * OWNER_ID environment variable in production and consider rotating credentials.
 */
export const DEFAULT_OWNER_ID = "polyakovats3110@gmail.com";

export function getOwnerId(): string {
  return process.env.OWNER_ID || DEFAULT_OWNER_ID;
}

export const OWNER_ID = process.env.OWNER_ID || DEFAULT_OWNER_ID;
