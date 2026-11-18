/**
 * providerErrorHint — the vendor-speak → user-action mapping. Each rule is pinned by
 * a REAL error string seen in the wild (Gemini's geo refusal is verbatim).
 */
import { describe, expect, it } from "vitest";
import { providerErrorHint, shortRawError } from "./errors";

describe("providerErrorHint", () => {
	it("maps Gemini's geo refusal — the exact string a Russian user hit", () => {
		const raw =
			"Error processing with Gemini (attempt 1/3): Gemini API error: User location is not supported for the API use.";
		expect(providerErrorHint(raw)).toBe("interactive.errors.geo");
	});

	it("maps bad-key failures across vendors", () => {
		expect(providerErrorHint("API key not valid. Please pass a valid API key.")).toBe("interactive.errors.key");
		expect(providerErrorHitHelper("Incorrect API key provided: sk-abc***.")).toBe("interactive.errors.key");
		expect(providerErrorHitHelper("401 Unauthorized")).toBe("interactive.errors.key");
	});

	it("maps rate limits and quotas", () => {
		expect(providerErrorHitHelper("429 Too Many Requests")).toBe("interactive.errors.limit");
		expect(providerErrorHitHelper("RESOURCE_EXHAUSTED: quota exceeded")).toBe("interactive.errors.limit");
		expect(providerErrorHitHelper("Rate limit reached for gpt-4o-mini")).toBe("interactive.errors.limit");
	});

	it("maps timeouts", () => {
		expect(providerErrorHitHelper("Request timed out after 30000 ms")).toBe("interactive.errors.timeout");
		expect(providerErrorHitHelper("ETIMEDOUT")).toBe("interactive.errors.timeout");
	});

	it("unknown errors get no hint — the raw text passes through untouched", () => {
		expect(providerErrorHint("Something entirely novel happened")).toBeNull();
	});

	it("shortRawError flattens whitespace and truncates", () => {
		expect(shortRawError("a\n\n  b")).toBe("a b");
		const long = shortRawError("x".repeat(200));
		expect(long.length).toBe(161); // 160 + ellipsis
		expect(long.endsWith("…")).toBe(true);
	});
});

/** tiny indirection so the table above reads cleanly */
function providerErrorHitHelper(raw: string): string | null {
	return providerErrorHint(raw);
}
