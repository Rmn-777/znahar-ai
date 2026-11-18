/**
 * Turns raw provider error text into a localized, actionable hint.
 *
 * Provider/API error strings arrive in the vendor's language ("User location is not
 * supported for the API use") and name nothing the user can act on. The raw text is
 * still shown — verbatim, truncated — but a one-line hint above it tells the user what
 * to actually do, in their language.
 */

export type ProviderHintKey =
	| "interactive.errors.geo"
	| "interactive.errors.key"
	| "interactive.errors.limit"
	| "interactive.errors.timeout";

const HINT_RULES: readonly { key: ProviderHintKey; pattern: RegExp }[] = [
	// Google's geo refusal and its generic cousins.
	{
		key: "interactive.errors.geo",
		pattern: /location is not supported|not supported (for|in) (the )?(api|region|country)|region.?not.?support/i,
	},
	// Bad key: explicit 401s and every "invalid/incorrect/wrong key" phrasing vendors use.
	{
		key: "interactive.errors.key",
		pattern:
			/\b401\b|unauthorized|(invalid|incorrect|wrong)[ _-]?(api[ _-]?)?key|api[ _-]?key not valid|permission denied|no auth/i,
	},
	// Quotas: hard 429s, "rate limit", "quota exceeded", per-day caps.
	{
		key: "interactive.errors.limit",
		pattern: /\b429\b|rate[ _-]?limit|quota|too many requests|resource.?exhausted/i,
	},
	// Network-side timeouts (our own deadline text says "timed out after N ms").
	{ key: "interactive.errors.timeout", pattern: /timed?[ _-]?out|timeout|etimedout|econnaborted|deadline/i },
];

/** The hint key for a raw provider error, or null when nothing matches. */
export function providerErrorHint(raw: string): ProviderHintKey | null {
	const hit = HINT_RULES.find(({ pattern }) => pattern.test(raw));
	return hit ? hit.key : null;
}

/** The raw text under the hint — enough to recognize, not a wall. */
export function shortRawError(raw: string, maxChars = 160): string {
	const flat = raw.replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}
