/**
 * MAX → Telegram-shape convertors: numeric addressing only, denial of anything our
 * ledger keys or callback_data could not carry.
 */
import { describe, expect, it } from "vitest";
import { maxCallbackToQuery, maxMessageToTelegram } from "./convertors";
import type { MaxMessage, MaxMessageCallback } from "./types";

const TEXT_MESSAGE: MaxMessage = {
	sender: { user_id: 7, username: "roman", name: "Роман Л" },
	recipient: { chat_type: "dialog", chat_id: -66329287241 },
	timestamp: 1763110400,
	body: { mid: "5710327117067269", text: "привет из MAX" },
};

describe("maxMessageToTelegram", () => {
	it("converts a text message keeping user, chat, timestamp and text", () => {
		const msg = maxMessageToTelegram(TEXT_MESSAGE)!;
		expect(msg.message_id).toBe(5710327117067269);
		expect(msg.chat).toEqual({ id: -66329287241, type: "private" });
		expect(msg.date).toBe(1763110400);
		expect(msg.text).toBe("привет из MAX");
		expect(msg.from?.username).toBe("roman");
		expect(msg.from?.first_name).toBe("Роман Л");
	});

	it("null for a non-numeric mid (cannot enter ledger keys or callback_data)", () => {
		expect(maxMessageToTelegram({ ...TEXT_MESSAGE, body: { mid: "chat.abc.def", text: "x" } })).toBeNull();
		expect(maxMessageToTelegram({ ...TEXT_MESSAGE, body: { text: "no mid at all" } })).toBeNull();
	});

	it("null without a chat id", () => {
		expect(
			maxMessageToTelegram({ ...TEXT_MESSAGE, recipient: { chat_type: "dialog" } as MaxMessage["recipient"] }),
		).toBeNull();
	});

	it("a message without a sender keeps converting (channel posts have none)", () => {
		const msg = maxMessageToTelegram({ ...TEXT_MESSAGE, sender: undefined })!;
		expect(msg.text).toBe("привет из MAX");
	});
});

describe("maxCallbackToQuery", () => {
	it("carries callback_id, our ia-payload and the presser", () => {
		const payload: MaxMessageCallback = {
			callback_id: "cb-1",
			user: { user_id: 7, username: "roman" },
			message: TEXT_MESSAGE,
			payload: "ia:-66329287241:5710327117067269:a:tldr",
		};
		const query = maxCallbackToQuery(payload)!;
		expect(query.id).toBe("cb-1");
		expect(query.data).toBe("ia:-66329287241:5710327117067269:a:tldr");
		// Dialog chat id = the presser's user id: the flow's access shim compares chat.id
		// against the whitelist, and a MAX dialog's own id is NOT the user's.
		expect(query.message?.chat.id).toBe(7);
		expect(query.from.username).toBe("roman");
	});

	it("null when the pressed bubble's message is unaddressable", () => {
		const payload: MaxMessageCallback = {
			callback_id: "cb-2",
			user: { user_id: 7 },
			message: { ...TEXT_MESSAGE, body: { mid: "oops", text: "x" } },
			payload: "ia:1:2:ok",
		};
		expect(maxCallbackToQuery(payload)).toBeNull();
	});
});
