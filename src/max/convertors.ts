/**
 * MAX ↔ Telegram-shape convertors.
 *
 * The interactive core (catalog, flow, composer) speaks the Telegram message shape —
 * it predates the MAX channel and everything downstream of prepare() is channel-blind
 * by design. The convertors are the seam: MAX JSON in, TelegramBot.Message (or a
 * CallbackQuery) out, or null when the update cannot be addressed numerically.
 *
 * MAX message ids (`mid`) are numeric strings; non-numeric mids have no place in our
 * ledger keys or callback_data, so such updates are skipped rather than fudged.
 */

import type TelegramBot from "src/telegram/botApi";
import type { MaxInlineKeyboardAttachment, MaxMessage, MaxMessageCallback } from "./types";

/** Our keyboards are built Telegram-style; MAX wants an inline_keyboard attachment. */
export function convertKeyboardToMax(markup: TelegramBot.InlineKeyboardMarkup): MaxInlineKeyboardAttachment {
	return {
		type: "inline_keyboard",
		payload: {
			buttons: markup.inline_keyboard.map((row) =>
				row
					.filter((button) => button.callback_data)
					.map((button) => ({
						type: "callback" as const,
						text: button.text,
						payload: button.callback_data!,
					})),
			),
		},
	};
}

/** Telegram-shaped message for a MAX text message, or null when it cannot be addressed. */
export function maxMessageToTelegram(payload: MaxMessage): TelegramBot.Message | null {
	const chatId = payload.recipient?.chat_id;
	const mid = payload.body?.mid;
	if (!Number.isFinite(Number(chatId)) || !/^-?\d+$/.test(mid ?? "")) return null;

	const sender = payload.sender;
	const name = sender?.name || sender?.username || "user";
	return {
		message_id: Number(mid),
		date: Number.isFinite(payload.timestamp) ? payload.timestamp : 0,
		chat: { id: chatId, type: "private" },
		from: sender
			? { id: sender.user_id, first_name: name, ...(sender.username ? { username: sender.username } : {}) }
			: undefined,
		text: payload.body?.text || "",
	};
}

/** Telegram-shaped CallbackQuery for a MAX button press, or null when unaddressable. */
export function maxCallbackToQuery(payload: MaxMessageCallback): TelegramBot.CallbackQuery | null {
	if (!payload.callback_id) return null;
	const message = payload.message ? maxMessageToTelegram(payload.message) : null;
	if (!message || !payload.user) return null;
	// Chat id = the presser's user id: a MAX dialog's own chat id is not the user's
	// (unlike Telegram private chats), and the flow's access shim compares the chat id
	// against the whitelist — user semantics, exactly like a Telegram private chat.
	return {
		id: payload.callback_id,
		from: {
			id: payload.user.user_id,
			first_name: payload.user.name || payload.user.username || "user",
			...(payload.user.username ? { username: payload.user.username } : {}),
		},
		data: payload.payload,
		message: {
			message_id: message.message_id,
			date: message.date,
			chat: { id: payload.user.user_id, type: "private" },
		},
	};
}
