/**
 * Menu layout — the rules the chat surface leans on: two buttons per row, the quick
 * screen's trailing «Ещё…»/«Своя команда» rows, catalog paging and navigation, and
 * preview truncation. Asserts callback structure, never localized label text.
 */
import { describe, expect, it } from "vitest";
import type TelegramBot from "src/telegram/botApi";
import { parseCallbackData } from "./callbackData";
import { catalogPageCount, enabledActionsFor, type CatalogSettings } from "./catalog";
import {
	PREVIEW_MAX_CHARS,
	buildMenuKeyboard,
	buildMenuText,
	buildPreviewKeyboard,
	buildPreviewText,
	sourceHint,
} from "./menuView";

const SETTINGS: CatalogSettings = {};
const CHAT = -1001234567890;
const MSG = 4242;

function allButtons(kb: TelegramBot.InlineKeyboardMarkup): TelegramBot.InlineKeyboardButton[] {
	return kb.inline_keyboard.flat();
}

function allCommands(kb: TelegramBot.InlineKeyboardMarkup) {
	// URL buttons carry no callback_data at all; the flow never emits them, but the
	// type is optional and must not reach parseCallbackData as undefined.
	return allButtons(kb).map((b) => (b.callback_data ? parseCallbackData(b.callback_data)?.command : undefined));
}

function actionIds(kb: TelegramBot.InlineKeyboardMarkup): string[] {
	return allCommands(kb)
		.filter((c): c is { kind: "action"; actionId: string } => !!c && c.kind === "action")
		.map((c) => c.actionId);
}

describe("quick screen", () => {
	it("every button addresses the source message and rows stay at most two wide", () => {
		const kb = buildMenuKeyboard(SETTINGS, "text", CHAT, MSG, { kind: "quick" });
		for (const row of kb.inline_keyboard) expect(row.length).toBeLessThanOrEqual(2);
		for (const button of allButtons(kb)) {
			expect(button.callback_data && parseCallbackData(button.callback_data)).toMatchObject({
				chatId: CHAT,
				messageId: MSG,
			});
		}
	});

	it("ends with the custom-command row and offers more when the catalog is deeper", () => {
		const kb = buildMenuKeyboard(SETTINGS, "text", CHAT, MSG, { kind: "quick" });
		const commands = allCommands(kb);
		expect(commands.at(-1)).toEqual({ kind: "custom" });
		expect(commands).toContainEqual({ kind: "page", page: 0 });
	});

	it("hides the more row when everything enabled is already quick", () => {
		const overrides = Object.fromEntries(
			enabledActionsFor(SETTINGS, "text")
				.filter((a) => !a.defaultQuick)
				.map((a) => [a.id, { enabled: false }]),
		);
		const kb = buildMenuKeyboard({ interactiveActionOverrides: overrides }, "text", CHAT, MSG, { kind: "quick" });
		expect(allCommands(kb)).not.toContainEqual({ kind: "page", page: 0 });
	});

	it("voice quick set carries the transcript action, text does not", () => {
		const voice = actionIds(buildMenuKeyboard(SETTINGS, "voice", CHAT, MSG, { kind: "quick" }));
		const text = actionIds(buildMenuKeyboard(SETTINGS, "text", CHAT, MSG, { kind: "quick" }));
		expect(voice).toContain("transcript-clean");
		expect(text).not.toContain("transcript-clean");
	});
});

describe("catalog pages", () => {
	it("page 1 shows the second slice, a back-home button and no next on the last page", () => {
		const total = catalogPageCount(SETTINGS, "text");
		expect(total).toBeGreaterThanOrEqual(2);

		const kb = buildMenuKeyboard(SETTINGS, "text", CHAT, MSG, { kind: "catalog", page: 1 });
		const ids = actionIds(kb);
		const enabled = enabledActionsFor(SETTINGS, "text").map((a) => a.id);
		// The union of both pages covers the catalog without overlap.
		const page0 = actionIds(buildMenuKeyboard(SETTINGS, "text", CHAT, MSG, { kind: "catalog", page: 0 }));
		expect(new Set([...page0, ...ids])).toEqual(new Set(enabled));
		expect(page0.filter((id) => ids.includes(id))).toEqual([]);

		const commands = allCommands(kb);
		expect(commands).toContainEqual({ kind: "home" });
		expect(commands).toContainEqual({ kind: "page", page: 0 });
		expect(commands).not.toContainEqual({ kind: "page", page: 2 });
	});

	it("clamps an out-of-range page into range", () => {
		const kb = buildMenuKeyboard(SETTINGS, "text", CHAT, MSG, { kind: "catalog", page: 99 });
		const last = catalogPageCount(SETTINGS, "text") - 1;
		expect(allCommands(kb)).toContainEqual({ kind: "page", page: last - 1 });
	});
});

describe("preview", () => {
	it("keyboard is one row of confirm, edit, cancel", () => {
		const commands = allCommands(buildPreviewKeyboard(CHAT, MSG));
		expect(commands).toEqual([{ kind: "confirm" }, { kind: "edit" }, { kind: "cancel" }]);
	});

	it("short results pass through; long ones truncate with a marker", () => {
		const short = buildPreviewText("короткий результат");
		expect(short).toContain("короткий результат");

		const long = buildPreviewText("x".repeat(PREVIEW_MAX_CHARS + 500));
		expect(long.length).toBeLessThan(PREVIEW_MAX_CHARS + 200);
		expect(long).toContain("✂️");
	});
});

describe("menu text and source hint", () => {
	it("source hint flattens whitespace and cuts at 120 chars", () => {
		const hint = sourceHint("voice", "слова\n\nслова\tслова " + "д".repeat(200));
		expect(hint).not.toContain("\n");
		expect(hint.endsWith("…")).toBe(true);
		// Bound follows the localized label's own length (label-only has no brackets);
		// +4 covers "[", "]", the separator space and the ellipsis.
		const labelOnly = sourceHint("voice", "");
		expect(hint.length).toBeLessThanOrEqual(labelOnly.length + 120 + 4);
	});

	it("no source text leaves just the type label", () => {
		expect(sourceHint("text", "")).toBe(sourceHint("text", undefined));
	});

	it("catalog text numbers pages from 1", () => {
		const text = buildMenuText({ kind: "catalog", page: 1 }, "text", "x", 3);
		expect(text).toContain("2");
		expect(text).toContain("3");
	});
});
