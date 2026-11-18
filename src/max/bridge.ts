/**
 * The MAX channel bridge — wires the MAX polling client into the interactive core.
 *
 * Mirrors the Telegram safety block for its channel: access control with a helpful
 * user-id denial, ledger dedup + track (nothing is lost, exactly-once holds), then the
 * same startInteractiveFlow the Telegram path uses — the core is channel-blind.
 *
 * MVP scope, on purpose: TEXT messages and the button dialog. Media from MAX (photos,
 * documents, voice) is not downloaded here — those updates are skipped with a log line
 * and documented in the instruction; the Telegram channel keeps full media coverage.
 */

import TelegramSyncPlugin from "src/main";
import TelegramBot from "src/telegram/botApi";
import { MaxBotClient } from "./client";
import { maxCallbackToQuery, maxMessageToTelegram } from "./convertors";
import type { MaxMessage, MaxMessageCallback } from "./types";
import { MessageLedger } from "src/processing/MessageLedger";
import { isSenderAllowed } from "src/telegram/bot/message/accessControl";
import { enqueueByCondition } from "src/utils/queues";
import { debugLog } from "src/utils/debugLog";
import { t } from "src/locale/i18n";
import { readSecret } from "src/utils/secretStore";

const channel = "max" as const;

let maxClient: MaxBotClient | undefined;

export function maxBotOf(plugin: TelegramSyncPlugin): MaxBotClient | undefined {
	return plugin.maxBot;
}

/** Connects the MAX channel when enabled and keyed; silent no-op otherwise. */
export async function connectMax(plugin: TelegramSyncPlugin): Promise<void> {
	if (!plugin.settings.maxEnabled) return;
	const token = readSecret(plugin, "maxToken");
	if (!token) {
		debugLog("MAX", "channel enabled but no token — staying offline");
		return;
	}
	await disconnectMax(plugin);
	const client = new MaxBotClient(token);
	client.on("message_created", (message) => {
		void (async () => {
			await enqueueByCondition(!plugin.settings.parallelMessageProcessing, handleMessageFromMax, plugin, message);
		})().catch((e: unknown) => debugLog("MAX", "message handling failed:", e));
	});
	client.on("message_callback", (callback) => {
		void (async () => {
			await handleCallbackFromMax(plugin, callback);
		})().catch((e: unknown) => debugLog("MAX", "callback handling failed:", e));
	});
	client.on("polling_error", (error) => debugLog("MAX", "polling error:", error));
	maxClient = client;
	plugin.maxBot = client;
	await client.startPolling();
}

export async function disconnectMax(plugin: TelegramSyncPlugin): Promise<void> {
	try {
		await maxClient?.stopPolling();
	} finally {
		maxClient = undefined;
		plugin.maxBot = undefined;
	}
}

/** One text message from MAX: follow-ups first, then access, dedup, flow. */
export async function handleMessageFromMax(plugin: TelegramSyncPlugin, payload: MaxMessage): Promise<void> {
	const converted = maxMessageToTelegram(payload);
	if (!converted) {
		debugLog("MAX", "update skipped: not addressable (non-numeric mid or no chat id)");
		return;
	}
	// Follow-up text (custom command / revision / «+ thought») outranks a new flow.
	const { handleInteractiveText, startInteractiveFlow } = await import("src/interactive/flow");
	if (await handleInteractiveText(plugin, converted, channel)) return;

	const ledger = plugin.messageLedger;
	const ledgerKey = MessageLedger.keyFor(converted);
	if (ledger?.isProcessed(ledgerKey)) {
		debugLog("MAX", `skipped duplicate: ${ledgerKey}`);
		return;
	}

	// Access semantics are "who sent it": in a MAX DIALOG the chat id is NOT the user id
	// (unlike Telegram private chats), so the whitelist check runs against the sender's
	// user id; a group chat keeps its own id (whitelist the group, not each member).
	const accessMsg: TelegramBot.Message =
		payload.recipient?.chat_type === "dialog" && payload.sender
			? { ...converted, chat: { ...converted.chat, id: payload.sender.user_id } }
			: converted;
	if (!isSenderAllowed(plugin.settings, accessMsg)) {
		const userId = accessMsg.chat.id;
		const client = plugin.maxBot;
		if (client) {
			await client
				.sendMessage(
					converted.chat.id,
					`Access denied. Add your MAX user id "${userId}" to Allowed Chats (digits).`,
				)
				.catch(() => {});
		}
		return;
	}

	ledger?.track(ledgerKey, converted);
	await startInteractiveFlow(plugin, converted, undefined, undefined, channel);
	// Sealed as soon as the menu is up. The MAX entry lives in the interactive store, so
	// button presses keep working across restarts — but a ledger-sealed message must
	// NEVER reach the Telegram replay loop: the replay would re-run it through the
	// TELEGRAM pipeline (wrong whitelist, duplicate notes). An abandoned MAX menu is
	// simply closed by the user sending a new message.
	await ledger?.markProcessed(ledgerKey);
}

/** One button press from MAX. */
export async function handleCallbackFromMax(plugin: TelegramSyncPlugin, payload: MaxMessageCallback): Promise<void> {
	const query = maxCallbackToQuery(payload);
	if (!query) return;
	// The whitelist applies to pressers like it applies to senders; dialog presses check
	// the presser's user id (see the dialog note in handleMessageFromMax).
	const shim = {
		from: query.from,
		chat: { id: query.from.id, type: "private" },
	} as TelegramBot.Message;
	if (!isSenderAllowed(plugin.settings, shim)) {
		await plugin.maxBot?.answerCallback(query.id, t("interactive.flow.denied")).catch(() => {});
		return;
	}
	const { handleInteractiveCallback } = await import("src/interactive/flow");
	await handleInteractiveCallback(plugin, query, channel);
}

/** Follow-up text typed in MAX (custom command, revision, «+ thought»). */
export async function handleTextFromMax(plugin: TelegramSyncPlugin, message: MaxMessage): Promise<boolean> {
	const converted = maxMessageToTelegram(message);
	if (!converted) return false;
	const { handleInteractiveText } = await import("src/interactive/flow");
	return await handleInteractiveText(plugin, converted, channel);
}
