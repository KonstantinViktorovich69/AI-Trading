/**
 * Single Source of Truth for AI Model Identifiers.
 * Only verified models returned by Google Gemini API models.list for the project key are allowed.
 */

export const DEFAULT_AI_MODEL = process.env.GEMINI_MODEL || 'gemini-4-hydrogen';

export const FALLBACK_AI_MODEL = 'gemini-flash-latest';

/**
 * Resolves the effective primary AI model at call time (respects runtime GEMINI_MODEL overrides).
 */
export function getDefaultAiModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_AI_MODEL;
}
