/**
 * callback_data codec — the whole interactive flow routes on these 64 bytes, so
 * the round-trip and every rejection path are pinned here.
 */
import { describe, expect, it } from "vitest";
import { encodeCallbackData, isValidActionId, parseCallbackData, type CallbackCommand } from "./callbackData";

describe("encodeCallbackData", () => {
	it("round-trips every command kind", () => {
		const commands: CallbackCommand[] = [
			{ kind: "action", actionId: "tldr" },
			{ kind: "action", actionId: "transcript-clean" },
			{ kind: "page", page: 2 },
			{ kind: "custom" },
			{ kind: "confirm" },
			{ kind: "edit" },
			{ kind: "cancel" },
		];
		for (const command of commands) {
			const data = encodeCallbackData(-1001234567890, 999999, command);
			expect(parseCallbackData(data)).toEqual({ chatId: -1001234567890, messageId: 999999, command });
		}
	});

	it("rejects a payload over Telegram's 64-byte cap", () => {
		expect(() => encodeCallbackData(1, 2, { kind: "action", actionId: "a".repeat(70) })).toThrow(/64/);
	});

	it("fits the longest catalog-like id under the cap", () => {
		expect(() =>
			encodeCallbackData(-1001234567890, 999999, { kind: "action", actionId: "error-screenshot" }),
		).not.toThrow();
	});
});

describe("parseCallbackData", () => {
	it("ignores foreign payloads", () => {
		expect(parseCallbackData("update_progress")).toBeNull();
		expect(parseCallbackData("cb:1:2:x")).toBeNull();
		expect(parseCallbackData("ia:abc:1:a:tldr")).toBeNull();
		expect(parseCallbackData("ia:1:2:unknown")).toBeNull();
		expect(parseCallbackData("")).toBeNull();
	});

	it("rejects malformed action ids, not just unknown ones", () => {
		// Uppercase or dotted ids must not resolve — the catalog only issues [a-z0-9-].
		expect(parseCallbackData("ia:1:2:a:TLDR")).toBeNull();
		expect(parseCallbackData("ia:1:2:a:doc.summary")).toBeNull();
	});
});

describe("isValidActionId", () => {
	it("accepts catalog-style ids and nothing else", () => {
		expect(isValidActionId("tldr")).toBe(true);
		expect(isValidActionId("transcript-clean")).toBe(true);
		expect(isValidActionId("UPPER")).toBe(false);
		expect(isValidActionId("with space")).toBe(false);
		expect(isValidActionId("dot.id")).toBe(false);
		expect(isValidActionId("")).toBe(false);
	});
});
