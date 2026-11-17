/**
 * Encoding of the inline-button callback payloads of the interactive flow.
 *
 * Telegram caps `callback_data` at 64 bytes, so the whole state travels in a short
 * string: "ia:<chatId>:<messageId>:<command>". The two ids identify the source
 * message (its ledger key — edits never enter the flow, so no edit suffix appears).
 * Every command is one letter or a short pair; action ids are restricted to
 * [a-z0-9-] (see catalog.ts), which keeps even the longest payload far under the cap.
 */

export type CallbackCommand =
	| { kind: "action"; actionId: string }
	| { kind: "page"; page: number }
	| { kind: "home" }
	| { kind: "custom" }
	| { kind: "confirm" }
	| { kind: "edit" }
	| { kind: "cancel" };

const PREFIX = "ia";
/** Telegram's hard limit on callback_data. */
const MAX_BYTES = 64;

const ID_PATTERN = /^[a-z0-9-]+$/;

/** Serializes a button command. Throws before Telegram would reject the keyboard. */
export function encodeCallbackData(chatId: number, messageId: number, command: CallbackCommand): string {
	const rest =
		command.kind === "action"
			? `a:${command.actionId}`
			: command.kind === "page"
				? `p:${command.page}`
				: command.kind === "home"
					? "h"
					: command.kind === "custom"
						? "c"
						: command.kind === "confirm"
							? "ok"
							: command.kind === "edit"
								? "ed"
								: "x";
	const data = `${PREFIX}:${chatId}:${messageId}:${rest}`;
	if (data.length > MAX_BYTES) {
		// A bug, not user input: action ids come from the catalog, pages are integers.
		throw new Error(`callback_data over ${MAX_BYTES} bytes: "${data}"`);
	}
	return data;
}

/** Parses a callback payload. Null for anything the flow did not encode — ignored quietly. */
export function parseCallbackData(
	data: string,
): { chatId: number; messageId: number; command: CallbackCommand } | null {
	const parts = data.split(":");
	if (parts.length < 4 || parts[0] !== PREFIX) return null;
	// Numeric ids only: a hand-crafted callback must not point anywhere but a message key.
	if (!/^-?\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;

	const chatId = Number(parts[1]);
	const messageId = Number(parts[2]);
	const rest = parts.slice(3).join(":");

	if (rest === "h") return { chatId, messageId, command: { kind: "home" } };
	if (rest === "ok") return { chatId, messageId, command: { kind: "confirm" } };
	if (rest === "ed") return { chatId, messageId, command: { kind: "edit" } };
	if (rest === "x") return { chatId, messageId, command: { kind: "cancel" } };
	if (rest === "c") return { chatId, messageId, command: { kind: "custom" } };

	const page = rest.match(/^p:(\d+)$/);
	if (page) return { chatId, messageId, command: { kind: "page", page: Number(page[1]) } };

	const action = rest.match(/^a:([a-z0-9-]+)$/);
	if (action) return { chatId, messageId, command: { kind: "action", actionId: action[1] } };

	return null;
}

/** Whether an action id is safe to encode — catalog ids are, but settings overrides may not be. */
export function isValidActionId(id: string): boolean {
	return ID_PATTERN.test(id);
}
