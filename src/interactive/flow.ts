/**
 * The interactive flow — orchestration and state machine.
 *
 * One Telegram message becomes one flow: a menu bubble whose inline buttons drive
 * menu → action → preview → confirmation → a provenance note in the inbox folder.
 * The buttons address the SOURCE message's key (chat:messageId), which is the same
 * key the message ledger uses — so the flow and the reliability layer agree on
 * identity without sharing state.
 *
 * Ownership boundaries, decided against the pipeline's own semantics:
 *
 *   - The hook in handleMessage runs right after ledger.track(): the raw message is
 *     on disk, so any failure from here on replays through the ledger's retries.
 *     A menu that fails to post is a retryable failure like any other.
 *   - The message stays pending+inFlight while the flow is open — the retry scheduler
 *     skips in-flight entries, so an open flow is never double-driven. After a
 *     restart (inFlight is not persisted) one replay re-renders the flow for its
 *     current stage; the entry in the persisted store makes that idempotent.
 *   - Processing-history tracking completes when the menu is posted: the pipeline's
 *     job — handing the message to the user — is done; the note is the user's act.
 *     Completing it later (with a trackingId that died with the session) would
 *     corrupt the tracker's live active-count.
 *   - markProcessed happens only when the note is written (confirm, cancel or the
 *     no-AI straight save). An abandoned flow simply stays pending.
 */

import TelegramBot from "src/telegram/botApi";
import TelegramSyncPlugin from "src/main";
import { t } from "src/locale/i18n";
import { debugLog } from "src/utils/debugLog";
import { appendContentToNote, getUniqueFilePath, sanitizeFileName, sanitizeFilePath } from "src/utils/fsUtils";
import { enqueue } from "src/utils/queues";
import { formatDateTime, messageTimestampMs, unixTime2Date } from "src/utils/dateUtils";
import { isProviderConfigured } from "src/ai/providers";
import { getMessageContentType } from "src/ai/contentType";
import { isSenderAllowed } from "src/telegram/bot/message/accessControl";
import { registerNoteForMessage } from "src/telegram/bot/message/contentHandler";
import { MessageDistributionRule } from "src/settings/messageDistribution";
import { recordProcessingDone } from "src/processing/ProcessingTracker";
import type { InteractiveEntry, PreparedSource } from "./types";
import { parseCallbackData, encodeCallbackData } from "./callbackData";
import { appliesToType, catalogPageCount, getAction, isActionEnabled } from "./catalog";
import { buildMenuKeyboard, buildMenuText, buildPreviewKeyboard, buildPreviewText, type MenuMode } from "./menuView";
import { prepareSource, PrepareError } from "./prepare";
import { runAction, runCustomCommand, ActionRunError } from "./runner";
import { composeNote } from "./composer";

/** Filename cap for the date+title stem — Windows path limits start at 260 chars. */
const TITLE_MAX_CHARS = 60;

/** Whether the AI-backed menu makes sense: AI on AND a usable provider configured. */
export function interactiveMenuAvailable(plugin: TelegramSyncPlugin): boolean {
	return plugin.settings.aiEnabled && isProviderConfigured(plugin, plugin.settings.aiProvider);
}

/**
 * Gate for the handleMessage hook. Channel posts keep the automatic pipeline (a bot
 * cannot hold a button conversation in a channel); edits route through the edit
 * handler; the interactiveDisabled setting turns the whole flow off.
 */
export function shouldStartInteractiveFlow(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	isChannelPost: boolean,
): boolean {
	if (isChannelPost) return false;
	if (msg.edit_date) return false;
	return !plugin.settings.interactiveDisabled;
}

/**
 * Entry point from handleMessage. Posts (or resumes) the flow for a message; with no
 * usable AI, saves the source straight to the inbox instead — the menu would offer
 * nothing but failures. Throws on failure so the ledger's retry path owns the error.
 */
export async function startInteractiveFlow(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	distributionRule?: MessageDistributionRule,
	trackingId?: string,
): Promise<"menu" | "saved"> {
	const store = plugin.interactiveStore;
	if (!store) throw new Error("Interactive store not initialized");

	const existing = store.get(msg.chat.id, msg.message_id);
	if (existing) {
		// A replay (restart, redelivery): resume the persisted flow rather than open a
		// second one, and re-render for the stage it actually is in.
		store.refreshMsg(existing.key, msg);
	} else {
		store.create(msg, "menu", { rule: distributionRule });
	}

	if (!interactiveMenuAvailable(plugin)) {
		// No AI (or no key): straight to the inbox as source — the user sorts it out
		// in Obsidian. Best effort: documents still get their local text extraction;
		// media without a transcriber degrades to the caption instead of failing.
		const entry = store.get(msg.chat.id, msg.message_id)!;
		const notePath = await saveSourceOnly(plugin, entry);
		if (trackingId) recordProcessingDone(trackingId);
		void replyQuietly(plugin, entry.chatId, t("interactive.flow.savedSource", { path: notePath }));
		return "saved";
	}

	const entry = store.get(msg.chat.id, msg.message_id)!;
	await renderForStage(plugin, entry);
	if (trackingId) recordProcessingDone(trackingId);
	return "menu";
}

/** Renders the flow bubble for whatever stage the entry is in (resume-safe). */
async function renderForStage(plugin: TelegramSyncPlugin, entry: InteractiveEntry): Promise<void> {
	if (entry.stage === "preview" && entry.result) {
		await renderPreview(plugin, entry);
		return;
	}
	if (entry.stage === "awaiting_custom" || entry.stage === "editing") {
		await renderPrompt(plugin, entry, entry.stage === "awaiting_custom");
		return;
	}
	// menu, running (coerced to menu on load) and anything unexpected.
	await renderMenu(plugin, entry, menuModeOf(entry));
}

function menuModeOf(entry: InteractiveEntry): MenuMode {
	return entry.page === undefined ? { kind: "quick" } : { kind: "catalog", page: entry.page };
}

// ─── chat surface ─────────────────────────────────────────────────────────────

/** Edits the flow bubble, or posts a fresh one when the old is gone/uneditable. */
async function editOrSend(
	plugin: TelegramSyncPlugin,
	entry: InteractiveEntry,
	text: string,
	keyboard?: TelegramBot.InlineKeyboardMarkup,
): Promise<void> {
	const bot = plugin.bot;
	if (!bot) throw new Error("Bot disconnected while rendering the interactive flow");
	if (entry.menuMessageId) {
		try {
			await bot.editMessageText(entry.chatId, entry.menuMessageId, text, {
				reply_markup: keyboard,
			});
			return;
		} catch (e) {
			// The bubble was deleted or is too old to edit — post a fresh one. This is
			// the same self-healing a restart replay relies on.
			debugLog("Interactive", "menu bubble edit failed, reposting:", e);
		}
	}
	const sent = await bot.sendMessage(entry.chatId, text, { reply_markup: keyboard });
	plugin.interactiveStore?.patch(entry.key, { menuMessageId: sent.message_id });
}

async function renderMenu(plugin: TelegramSyncPlugin, entry: InteractiveEntry, mode: MenuMode): Promise<void> {
	const contentType = entry.source?.contentType ?? getMessageContentType(entry.msg);
	const totalPages = catalogPageCount(plugin.settings, contentType);
	const hint = entry.source?.sourceText ?? entry.msg.text ?? entry.msg.caption;
	await editOrSend(
		plugin,
		entry,
		buildMenuText(mode, contentType, hint, totalPages),
		buildMenuKeyboard(plugin.settings, contentType, entry.chatId, entry.messageId, mode),
	);
}

async function renderPreview(plugin: TelegramSyncPlugin, entry: InteractiveEntry): Promise<void> {
	await editOrSend(
		plugin,
		entry,
		buildPreviewText(entry.result ?? ""),
		buildPreviewKeyboard(entry.chatId, entry.messageId),
	);
}

/** The "type your command / revision" bubble; a lone Back button is the way out. */
async function renderPrompt(plugin: TelegramSyncPlugin, entry: InteractiveEntry, isCustom: boolean): Promise<void> {
	const back = {
		inline_keyboard: [
			[
				{
					text: t("interactive.menu.back"),
					callback_data: encodeCallbackData(entry.chatId, entry.messageId, { kind: "home" }),
				},
			],
		],
	};
	await editOrSend(plugin, entry, t(isCustom ? "interactive.flow.awaitCustom" : "interactive.flow.awaitEdit"), back);
}

async function replyQuietly(plugin: TelegramSyncPlugin, chatId: number, text: string): Promise<void> {
	try {
		await plugin.bot?.sendMessage(chatId, text);
	} catch (e) {
		// Cosmetic: the note (or menu) already exists; a failed confirmation reply must
		// not turn into a ledger retry that duplicates it.
		debugLog("Interactive", "confirmation reply failed:", e);
	}
}

// ─── note writing ─────────────────────────────────────────────────────────────

/** A filename-safe title: first words of the AI result or the source, markdown stripped. */
function deriveTitle(entry: Pick<InteractiveEntry, "result" | "source" | "msg">): string {
	const raw = (entry.result?.trim() || entry.source?.sourceText || entry.msg.text || entry.msg.caption || "")
		.split("\n")
		.find((line) => line.trim().length > 0);
	const flat = (raw || "")
		.replace(/[#*`>\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.slice(0, TITLE_MAX_CHARS) || "note";
}

/**
 * Writes the composed note into the inbox folder and registers it for the message.
 * Called with the entry's CURRENT result — pass a copy without it for a source-only
 * save (the composer then omits the AI callout).
 */
async function writeNote(plugin: TelegramSyncPlugin, entry: InteractiveEntry): Promise<string> {
	const title = deriveTitle(entry);
	const folder = sanitizeFilePath((plugin.settings.interactiveInboxFolder || "").trim() || "_Входящие");
	const stamp = formatDateTime(unixTime2Date(entry.msg.date, entry.msg.message_id), "YYYY-MM-DD HH-mm");
	const stem = sanitizeFileName(`${stamp} ${title}`).slice(0, 100) || "note";
	let notePath = `${folder}/${stem}.md`;
	notePath = await enqueue(
		getUniqueFilePath,
		plugin.app.vault,
		plugin.createdFilePaths,
		notePath,
		new Date(messageTimestampMs(entry.msg.date)),
		"md",
	);
	const content = composeNote(plugin, entry.msg, entry, title);
	await enqueue(appendContentToNote, plugin.app.vault, notePath, content, "", "", false);
	registerNoteForMessage(plugin, entry.msg, notePath, true);
	return notePath;
}

/** Straight save used when no AI is available: source layers only, no menu. */
async function saveSourceOnly(plugin: TelegramSyncPlugin, entry: InteractiveEntry): Promise<string> {
	let source: PreparedSource;
	try {
		source = await prepareSource(plugin, entry.msg, entry.rule);
	} catch (e) {
		if (e instanceof PrepareError) {
			// Degraded, not dead: keep saving what the message itself says.
			source = {
				sourceText: entry.msg.text || entry.msg.caption || "",
				aiText: "",
				contentType: getMessageContentType(entry.msg),
			};
		} else {
			throw e;
		}
	}
	const forNote: InteractiveEntry = { ...entry, source, result: undefined, actionId: undefined, provider: undefined };
	const notePath = await writeNote(plugin, forNote);
	await plugin.messageLedger?.markProcessed(entry.key);
	plugin.interactiveStore?.delete(entry.key);
	return notePath;
}

/**
 * Confirm (includeResult) or cancel (source only): both write the note, seal the
 * message and close the flow — the difference is only whether the AI layer ships.
 */
async function confirmFlow(plugin: TelegramSyncPlugin, entry: InteractiveEntry, includeResult: boolean): Promise<void> {
	const forNote: InteractiveEntry = includeResult
		? entry
		: { ...entry, result: undefined, actionId: undefined, provider: undefined };
	const notePath = await writeNote(plugin, forNote);
	await plugin.messageLedger?.markProcessed(entry.key);
	plugin.interactiveStore?.delete(entry.key);
	await editOrSend(plugin, entry, t("interactive.flow.saved", { path: notePath }));
}

// ─── execution ────────────────────────────────────────────────────────────────

/** Prepares the source once per flow; later actions reuse the cached material. */
async function ensurePrepared(plugin: TelegramSyncPlugin, entry: InteractiveEntry): Promise<PreparedSource> {
	if (entry.source) return entry.source;
	const source = await prepareSource(plugin, entry.msg, entry.rule);
	plugin.interactiveStore?.patch(entry.key, { source });
	return source;
}

/** Runs an action end-to-end and moves the flow to preview (or back to menu on failure). */
async function runFlowAction(
	plugin: TelegramSyncPlugin,
	entry: InteractiveEntry,
	actionId: string,
	customPrompt?: string,
): Promise<void> {
	const store = plugin.interactiveStore!;
	const action = getAction(actionId);
	if (
		!action ||
		!appliesToType(action, entry.source?.contentType ?? getMessageContentType(entry.msg)) ||
		!isActionEnabled(plugin.settings, action)
	) {
		// Catalog drift (settings changed since the menu was rendered) — re-render.
		store.patch(entry.key, { stage: "menu" });
		await renderMenu(plugin, store.get(entry.chatId, entry.messageId)!, menuModeOf(entry));
		return;
	}

	if (action.requiresPrompt && customPrompt === undefined) {
		// «Спросить документ»: the typed text becomes the prompt for this action.
		store.patch(entry.key, { stage: "awaiting_custom", actionId });
		await renderPrompt(plugin, store.get(entry.chatId, entry.messageId)!, true);
		return;
	}

	store.patch(entry.key, { stage: "running" });
	try {
		const source = await ensurePrepared(plugin, entry);
		const result = await runAction(plugin, entry.msg, source, action, customPrompt);
		const updated = store.patch(entry.key, {
			stage: "preview",
			result: result.text,
			provider: result.provider,
			actionId,
			source,
		});
		await renderPreview(plugin, updated ?? entry);
	} catch (e) {
		await showErrorAndMenu(plugin, store.get(entry.chatId, entry.messageId) ?? entry, e);
	}
}

/** Failure landing for the menu stages: error on the bubble, keyboard intact, stage menu. */
async function showErrorAndMenu(plugin: TelegramSyncPlugin, entry: InteractiveEntry, e: unknown): Promise<void> {
	const message = flowErrorMessage(e);
	plugin.interactiveStore?.patch(entry.key, { stage: "menu" });
	const current = plugin.interactiveStore?.get(entry.chatId, entry.messageId) ?? entry;
	const contentType = current.source?.contentType ?? getMessageContentType(current.msg);
	const totalPages = catalogPageCount(plugin.settings, contentType);
	const hint = current.source?.sourceText ?? current.msg.text ?? current.msg.caption;
	await editOrSend(
		plugin,
		current,
		`⚠️ ${message}\n\n${buildMenuText(menuModeOf(current), contentType, hint, totalPages)}`,
		buildMenuKeyboard(plugin.settings, contentType, current.chatId, current.messageId, menuModeOf(current)),
	);
}

/** Failure landing for the editing stage: the previous result stays, error above it. */
async function showErrorAndPreview(plugin: TelegramSyncPlugin, entry: InteractiveEntry, e: unknown): Promise<void> {
	const message = flowErrorMessage(e);
	plugin.interactiveStore?.patch(entry.key, { stage: "preview" });
	const current = plugin.interactiveStore?.get(entry.chatId, entry.messageId) ?? entry;
	await editOrSend(
		plugin,
		current,
		`⚠️ ${message}\n\n${buildPreviewText(current.result ?? "")}`,
		buildPreviewKeyboard(current.chatId, current.messageId),
	);
}

function flowErrorMessage(e: unknown): string {
	if (e instanceof PrepareError || e instanceof ActionRunError) return t(e.localeKey);
	return String(e instanceof Error ? e.message : e);
}

// ─── callback routing ─────────────────────────────────────────────────────────

/**
 * Handles a callback_query. Returns true when the flow consumed it (always answer it
 * then — Telegram keeps the button's spinner until answered).
 */
export async function handleInteractiveCallback(
	plugin: TelegramSyncPlugin,
	query: TelegramBot.CallbackQuery,
): Promise<boolean> {
	const parsed = query.data ? parseCallbackData(query.data) : null;
	if (!parsed) return false;
	const { chatId, messageId, command } = parsed;
	const bot = plugin.bot;
	if (!bot) return false;

	const answer = (text?: string) =>
		bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {
			// An unanswered query only leaves a spinner for a few seconds.
		});

	// The whitelist governs button presses like it governs messages: the bubble lives
	// in the chat, and in a group anyone could press. A private chat's id equals the
	// presser's, so the shim's fallback keeps private chats working for old messages.
	const shim = {
		from: query.from,
		chat: { id: query.message?.chat?.id ?? query.from.id },
	} as TelegramBot.Message;
	if (!isSenderAllowed(plugin.settings, shim)) {
		await answer(t("interactive.flow.denied"));
		return true;
	}

	const store = plugin.interactiveStore;
	const entry = store?.get(chatId, messageId);
	if (!store || !entry) {
		await answer(t("interactive.flow.expired"));
		return true;
	}

	if (entry.stage === "running") {
		await answer(t("interactive.flow.busy"));
		return true;
	}

	switch (command.kind) {
		case "action":
			await answer(t("interactive.flow.running"));
			await runFlowAction(plugin, entry, command.actionId);
			return true;
		case "page":
			await answer();
			store.patch(entry.key, { stage: "menu", page: command.page });
			await renderMenu(plugin, store.get(chatId, messageId)!, { kind: "catalog", page: command.page });
			return true;
		case "home":
			await answer();
			store.patch(entry.key, { stage: "menu", page: undefined, customPrompt: undefined });
			await renderMenu(plugin, store.get(chatId, messageId)!, { kind: "quick" });
			return true;
		case "custom":
			await answer();
			store.patch(entry.key, { stage: "awaiting_custom", actionId: undefined });
			await renderPrompt(plugin, store.get(chatId, messageId)!, true);
			return true;
		case "edit":
			await answer();
			store.patch(entry.key, { stage: "editing" });
			await renderPrompt(plugin, store.get(chatId, messageId)!, false);
			return true;
		case "confirm":
			await answer();
			await confirmFlow(plugin, entry, true);
			return true;
		case "cancel":
			await answer();
			await confirmFlow(plugin, entry, false);
			return true;
	}
}

// ─── follow-up text routing ───────────────────────────────────────────────────

/** The instruction sent to the model for a preview revision. */
const REVISION_COMMAND =
	"The text above the separator is the current version of a note. The bracketed instruction below the separator says how to revise it. Apply the instruction and output only the complete revised note, preserving its language and Markdown structure.";

/**
 * Claims a plain text message for an open flow: the typed answer to «Своя команда» /
 * a revision instruction / a "+ thought". A reply to the flow bubble always wins;
 * otherwise the newest flow in this chat that awaits input. Returns true when
 * consumed — the message must then NOT enter the ordinary pipeline.
 */
export async function handleInteractiveText(plugin: TelegramSyncPlugin, msg: TelegramBot.Message): Promise<boolean> {
	const store = plugin.interactiveStore;
	if (!store || !msg.text || !msg.text.trim()) return false;

	let entry: InteractiveEntry | undefined;
	if (msg.reply_to_message) {
		entry = store
			.all()
			.find(
				(candidate) =>
					candidate.chatId === msg.chat.id && candidate.menuMessageId === msg.reply_to_message!.message_id,
			);
	}
	if (!entry) {
		entry = store
			.all()
			.find(
				(candidate) =>
					candidate.chatId === msg.chat.id &&
					(candidate.stage === "awaiting_custom" || candidate.stage === "editing"),
			);
	}
	if (!entry) return false;

	const text = msg.text.trim();

	if (entry.stage === "awaiting_custom") {
		const current = store.get(entry.chatId, entry.messageId)!;
		const promptAction =
			current.actionId && getAction(current.actionId)?.requiresPrompt ? current.actionId : undefined;
		if (promptAction) {
			// The typed text completes a prompt-needing action («Спросить документ»).
			await runFlowAction(plugin, current, promptAction, text);
			return true;
		}
		// A free-form command: not a catalog action, so the runner is driven directly
		// and the note's AI layer is titled as a custom command.
		store.patch(entry.key, { stage: "running", actionId: "custom" });
		try {
			const source = await ensurePrepared(plugin, current);
			const result = await runCustomCommand(plugin, current.msg, source, text);
			store.patch(entry.key, {
				stage: "preview",
				result: result.text,
				provider: result.provider,
				actionId: "custom",
				source,
			});
			await renderPreview(plugin, store.get(entry.chatId, entry.messageId)!);
		} catch (e) {
			await showErrorAndMenu(plugin, store.get(entry.chatId, entry.messageId) ?? current, e);
		}
		return true;
	}

	// editing
	if (text.startsWith("+")) {
		const thought = text.slice(1).trim();
		if (thought) {
			store.patch(entry.key, { thoughts: [...entry.thoughts, thought], stage: "preview" });
			await renderPreview(plugin, store.get(entry.chatId, entry.messageId)!);
		}
		return true;
	}

	store.patch(entry.key, { stage: "running" });
	try {
		const revised = await runCustomCommand(
			plugin,
			entry.msg,
			{
				sourceText: entry.source?.sourceText ?? "",
				aiText: `${entry.result ?? ""}\n\n---\n[Revision instruction]: ${text}`,
				contentType: entry.source?.contentType ?? "text",
			},
			REVISION_COMMAND,
		);
		store.patch(entry.key, { stage: "preview", result: revised.text, provider: revised.provider });
		await renderPreview(plugin, store.get(entry.chatId, entry.messageId)!);
	} catch (e) {
		await showErrorAndPreview(plugin, store.get(entry.chatId, entry.messageId) ?? entry, e);
	}
	return true;
}
