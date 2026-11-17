/**
 * What the interactive flow looks like in the chat: menu texts and inline keyboards.
 *
 * Pure rendering — no plugin, no side effects — so the layout rules (two buttons per
 * row, quick screen vs catalog pages, preview controls) are pinned by unit tests.
 * Every button's callback_data addresses the source message, so one bubble drives
 * the whole flow no matter how many stages replaced its keyboard.
 */

import type TelegramBot from "src/telegram/botApi";
import { t } from "src/locale/i18n";
import { encodeCallbackData } from "./callbackData";
import {
	CATALOG_PAGE_SIZE,
	enabledActionsFor,
	quickActionsFor,
	type CatalogAction,
	type CatalogSettings,
} from "./catalog";
import type { InteractiveEntry } from "./types";
import type { AIContentType } from "src/ai/contentType";

const BUTTONS_PER_ROW = 2;
/** Telegram messages cap out at 4096 chars; leave room for the hint and the truncation marker. */
export const PREVIEW_MAX_CHARS = 3500;
/** How much of the source shows in the menu header — enough to recognize it, not a wall. */
const SOURCE_HINT_CHARS = 120;

export type MenuMode = { kind: "quick" } | { kind: "catalog"; page: number };

export function actionLabel(action: CatalogAction): string {
	return `${action.icon} ${t(`interactive.actions.${action.id}`)}`;
}

/** "[Voice] buy milk tomorrow…" — the recognizer line above the buttons. */
export function sourceHint(contentType: AIContentType, sourceText: string | undefined): string {
	const typeLabel = t(`interactive.source.${contentType}`);
	const flat = (sourceText || "").replace(/\s+/g, " ").trim();
	if (!flat) return typeLabel;
	const cut = flat.length > SOURCE_HINT_CHARS ? `${flat.slice(0, SOURCE_HINT_CHARS)}…` : flat;
	return `[${typeLabel}] ${cut}`;
}

/**
 * Menu bubble text. `totalPages` comes from the caller (it depends on settings) and is
 * only read in catalog mode.
 */
export function buildMenuText(
	mode: MenuMode,
	contentType: AIContentType,
	sourceText: string | undefined,
	totalPages?: number,
): string {
	if (mode.kind === "quick") {
		return `${sourceHint(contentType, sourceText)}\n\n${t("interactive.menu.whatToDo")}`;
	}
	return `${t("interactive.menu.page", { page: String(mode.page + 1), total: String(totalPages ?? 1) })}`;
}

type Button = { text: string; callback_data: string };

function rows(buttons: Button[]): TelegramBot.InlineKeyboardButton[][] {
	const grid: TelegramBot.InlineKeyboardButton[][] = [];
	for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
		grid.push(buttons.slice(i, i + BUTTONS_PER_ROW));
	}
	return grid;
}

function actionButton(chatId: number, messageId: number, action: CatalogAction): Button {
	return {
		text: actionLabel(action),
		callback_data: encodeCallbackData(chatId, messageId, { kind: "action", actionId: action.id }),
	};
}

/**
 * The quick screen: quick-set actions, then «Ещё…», then «Своя команда».
 * Catalog pages: a CATALOG_PAGE_SIZE slice, then navigation, then «Своя команда».
 */
export function buildMenuKeyboard(
	settings: CatalogSettings,
	contentType: AIContentType,
	chatId: number,
	messageId: number,
	mode: MenuMode,
): TelegramBot.InlineKeyboardMarkup {
	if (mode.kind === "quick") {
		const actions = quickActionsFor(settings, contentType);
		const grid = rows(actions.map((a) => actionButton(chatId, messageId, a)));
		if (enabledActionsFor(settings, contentType).length > actions.length) {
			grid.push([
				{
					text: t("interactive.menu.more"),
					callback_data: encodeCallbackData(chatId, messageId, { kind: "page", page: 0 }),
				},
			]);
		}
		grid.push([
			{
				text: t("interactive.menu.custom"),
				callback_data: encodeCallbackData(chatId, messageId, { kind: "custom" }),
			},
		]);
		return { inline_keyboard: grid };
	}

	const enabled = enabledActionsFor(settings, contentType);
	const total = Math.max(1, Math.ceil(enabled.length / CATALOG_PAGE_SIZE));
	const page = Math.min(Math.max(mode.page, 0), total - 1);
	const slice = enabled.slice(page * CATALOG_PAGE_SIZE, (page + 1) * CATALOG_PAGE_SIZE);
	const grid = rows(slice.map((a) => actionButton(chatId, messageId, a)));

	const nav: Button[] = [];
	if (page > 0) {
		nav.push({
			text: "‹",
			callback_data: encodeCallbackData(chatId, messageId, { kind: "page", page: page - 1 }),
		});
	}
	nav.push({
		text: t("interactive.menu.back"),
		callback_data: encodeCallbackData(chatId, messageId, { kind: "home" }),
	});
	if (page < total - 1) {
		nav.push({
			text: "›",
			callback_data: encodeCallbackData(chatId, messageId, { kind: "page", page: page + 1 }),
		});
	}
	grid.push(nav);
	grid.push([
		{
			text: t("interactive.menu.custom"),
			callback_data: encodeCallbackData(chatId, messageId, { kind: "custom" }),
		},
	]);
	return { inline_keyboard: grid };
}

/** The preview's controls: save, edit, or fall back to the source-only note. */
export function buildPreviewKeyboard(chatId: number, messageId: number): TelegramBot.InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{
					text: "✅",
					callback_data: encodeCallbackData(chatId, messageId, { kind: "confirm" }),
				},
				{
					text: "✏️",
					callback_data: encodeCallbackData(chatId, messageId, { kind: "edit" }),
				},
				{
					text: "↩️",
					callback_data: encodeCallbackData(chatId, messageId, { kind: "cancel" }),
				},
			],
		],
	};
}

/** Result text for the preview bubble, truncated with a marker; the note keeps the full text. */
export function buildPreviewText(result: string): string {
	const body = result.length > PREVIEW_MAX_CHARS ? `${result.slice(0, PREVIEW_MAX_CHARS)}\n…(✂️)` : result;
	return `${body}\n\n${t("interactive.preview.hint")}`;
}

/** One-line recognition hint for an entry, used when re-rendering a recovered menu. */
export function entrySourceHint(entry: InteractiveEntry): string {
	return sourceHint(
		entry.source?.contentType ?? "unknown",
		entry.source?.sourceText ?? entry.msg.text ?? entry.msg.caption,
	);
}
