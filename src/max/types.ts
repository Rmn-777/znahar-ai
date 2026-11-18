/**
 * MAX Bot API shapes — the subset the MAX channel of the interactive flow reads.
 *
 * Field names follow MAX's own JSON (dev.max.ru): snake_case, `update_type`/`payload`
 * on updates, `callback_id`+`payload` on callback presses. Message ids (`mid`) are
 * numeric STRINGS; the convertor refuses anything Number() cannot represent, so our
 * ledger keys and callback_data stay numeric end to end.
 */

export type MaxUpdateType =
	| "message_created"
	| "message_edited"
	| "message_removed"
	| "message_callback"
	| "bot_started"
	| "chat_unavailable";

export interface MaxUser {
	user_id: number;
	username?: string;
	name?: string;
	is_bot?: boolean;
}

export interface MaxRecipient {
	chat_type: "dialog" | "chat";
	chat_id: number;
}

export interface MaxAttachment {
	type: string;
	payload?: unknown;
}

export interface MaxMessageBody {
	mid?: string;
	text?: string;
	attachments?: MaxAttachment[];
}

export interface MaxMessage {
	sender?: MaxUser;
	recipient: MaxRecipient;
	timestamp: number;
	body?: MaxMessageBody;
}

export interface MaxMessageCallback {
	callback_id: string;
	user?: MaxUser;
	message?: MaxMessage;
	/** The string the button was created with — our "ia:..." command. */
	payload?: string;
}

export interface MaxUpdate {
	update_type: MaxUpdateType;
	timestamp: number;
	payload: unknown;
}

/** GET /updates response: the batch plus the marker to pass on the next poll. */
export interface MaxUpdatesResponse {
	updates: MaxUpdate[];
	marker?: number;
}

/** Inline keyboard in MAX travels as a message attachment. */
export interface MaxInlineKeyboardAttachment {
	type: "inline_keyboard";
	payload: {
		buttons: { type: "callback"; text: string; payload: string }[][];
	};
}

export function inlineKeyboardAttachment(buttons: { text: string; payload: string }[][]): MaxInlineKeyboardAttachment {
	return {
		type: "inline_keyboard",
		payload: { buttons: buttons.map((row) => row.map((b) => ({ type: "callback" as const, ...b }))) },
	};
}
