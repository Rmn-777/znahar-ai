/**
 * Interactive "Коллектор" flow — shared types.
 *
 * The flow turns a received message into: source saved → action menu → AI result
 * preview → user edits → confirmed note in the inbox folder. An InteractiveEntry is
 * the per-message state of that pipeline, persisted so the flow survives restarts
 * and the Telegram buttons keep working after Obsidian comes back.
 */

import TelegramBot from "src/telegram/botApi";
import type { AIContentType } from "src/ai/contentType";
import type { MessageDistributionRule } from "src/settings/messageDistribution";

/** Where an interactive entry is in its lifecycle. */
export type InteractiveStage =
	/** The action menu is (or must be) in the chat; nothing prepared yet. */
	| "menu"
	/** An action is executing. Further button presses are answered, not acted on. */
	| "running"
	/** A result is in the chat awaiting confirm / edit / cancel. */
	| "preview"
	/** The next plain text from the chat is a revision instruction (or "+ thought"). */
	| "editing"
	/** The next plain text from the chat is the custom action prompt. */
	| "awaiting_custom";

/**
 * Source material prepared for processing, cached on the entry so a second action
 * (translate after transcribe) skips the download and the transcription again.
 */
export interface PreparedSource {
	/** The SOURCE-callout text: transcript, extracted document text, fetched page, message text. */
	sourceText: string;
	/** The body handed to the AI — may differ from sourceText (e.g. the fetched page body). */
	aiText: string;
	/** Prompt content type for the AI call; photo routes through the Vision path. */
	contentType: AIContentType;
	/** Attachment already written into the vault, if the preparation downloaded one. */
	filePath?: string;
	/** File name as Telegram reported it. */
	fileName?: string;
}

/** The messenger the flow lives in. Telegram is the original channel; MAX rides the same core. */
export type FlowChannel = "telegram" | "max";

export interface InteractiveEntry {
	/** Ledger key of the source message: "chatId:messageId". Edits never enter the flow. */
	key: string;
	chatId: number;
	messageId: number;
	/** Which messenger owns this flow; defaults to telegram when absent (legacy entries). */
	channel?: FlowChannel;
	stage: InteractiveStage;
	/** The chat bubble whose buttons drive the flow — edited in place on every stage change. */
	menuMessageId?: number;
	/** The raw source message, stored in the same storable shape MessageLedger keeps. */
	msg: TelegramBot.Message;
	/** The distribution rule matched when the message arrived; supplies file path templates. */
	rule?: MessageDistributionRule;
	/** Prepared material, cached between actions. */
	source?: PreparedSource;
	/** Current AI result shown in the preview. */
	result?: string;
	/** The action that produced `result`. */
	actionId?: string;
	/** The prompt when the user chose «Своя команда». */
	customPrompt?: string;
	/** Provider that produced `result` — provenance for the note's AI section. */
	provider?: string;
	/** The user's own additions for the note's «Мои мысли» section. */
	thoughts: string[];
	/** Catalog page the user is browsing from the «Ещё…» screen. */
	page?: number;
	createdAt: number;
	updatedAt: number;
}
