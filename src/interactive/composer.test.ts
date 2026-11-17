/**
 * The provenance composer — pins the spec §4 note shape: three distinct layers,
 * omit-when-empty behavior, frontmatter fields, YAML-safe quoting, attachment embed.
 */
import { describe, expect, it } from "vitest";
import type TelegramBot from "src/telegram/botApi";
import type TelegramSyncPlugin from "src/main";
import { t } from "src/locale/i18n";
import type { InteractiveEntry } from "./types";
import { buildFrontmatter, composeNote, composeNoteBody } from "./composer";

// The composer reads two callout-name settings plus noteFrontmatterIds.
function makePlugin(settings: Record<string, unknown> = {}): TelegramSyncPlugin {
	return {
		settings: {
			interactiveSourceCallout: "SOURCE",
			interactiveAICallout: "AI",
			noteFrontmatterIds: true,
			...settings,
		},
	} as unknown as TelegramSyncPlugin;
}

function msg(): TelegramBot.Message {
	// 2026-11-14 10:13:20 UTC — a fixed date so the rendered stamp is assertable.
	return { message_id: 42, date: 1763110400, chat: { id: 7, type: "private" }, text: "x" };
}

function entry(overrides: Partial<InteractiveEntry> = {}): InteractiveEntry {
	return {
		key: "7:42",
		chatId: 7,
		messageId: 42,
		stage: "preview",
		msg: msg(),
		thoughts: [],
		createdAt: 0,
		updatedAt: 0,
		source: { sourceText: "исходный материал", aiText: "исходный материал", contentType: "voice" },
		result: "результат модели",
		actionId: "tldr",
		provider: "gemini/gemini-flash",
		...overrides,
	};
}

describe("buildFrontmatter", () => {
	it("quotes strings safely, keeps numbers raw, renders empty lists", () => {
		const block = buildFrontmatter([
			["title", 'Конспект: "важное"'],
			["count", 3],
			["tags", []],
			["multi", ["a", "b"]],
		]);
		expect(block).toBe('---\ntitle: "Конспект: \\"важное\\""\ncount: 3\ntags: []\nmulti:\n  - "a"\n  - "b"\n---');
	});
});

describe("composeNoteBody layers", () => {
	it("renders all three layers distinctly for a full entry", () => {
		const body = composeNoteBody(makePlugin(), msg(), entry({ thoughts: ["моя мысль"] }));
		expect(body).toContain("> [!SOURCE] Исходник — Telegram,");
		expect(body).toContain("> исходный материал");
		expect(body).toContain("## Мои мысли");
		expect(body).toContain("- моя мысль");
		expect(body).toContain(`> [!AI] Обработка ИИ — ${t("interactive.actions.tldr")} (gemini/gemini-flash)`);
		expect(body).toContain("> результат модели");
		// Ordering: source first, thoughts middle, AI last.
		const sourceAt = body.indexOf("[!SOURCE]");
		const thoughtsAt = body.indexOf("Мои мысли");
		const aiAt = body.indexOf("[!AI]");
		expect(sourceAt).toBeLessThan(thoughtsAt);
		expect(thoughtsAt).toBeLessThan(aiAt);
	});

	it("omits the thoughts section when there are none", () => {
		const body = composeNoteBody(makePlugin(), msg(), entry());
		expect(body).not.toContain("Мои мысли");
	});

	it("a no-AI save omits the AI callout entirely", () => {
		const body = composeNoteBody(
			makePlugin(),
			msg(),
			entry({ actionId: "save-asis", provider: "none", result: "исходный материал" }),
		);
		expect(body).not.toContain("[!AI]");
		expect(body).toContain("[!SOURCE]");
	});

	it("multi-line source is quoted line by line, blanks become bare > ", () => {
		const body = composeNoteBody(
			makePlugin(),
			msg(),
			entry({
				source: { sourceText: "строка один\n\nстрока два", aiText: "x", contentType: "text" },
				result: undefined,
				actionId: undefined,
				provider: undefined,
			}),
		);
		expect(body).toContain("> строка один");
		expect(body).toContain(">\n> строка два");
		expect(body).not.toContain("[!AI]");
	});

	it("embeds the saved attachment after the source callout", () => {
		const body = composeNoteBody(
			makePlugin(),
			msg(),
			entry({
				source: {
					sourceText: "транскрипт",
					aiText: "транскрипт",
					contentType: "voice",
					filePath: "Telegram/voices/запись.oga",
				},
			}),
		);
		expect(body).toContain("> ![[запись.oga]]");
	});

	it("a leading YAML block in the source cannot become the note's properties", () => {
		const body = composeNoteBody(
			makePlugin(),
			msg(),
			entry({
				source: { sourceText: "---\ntitle: злой\n---\nтекст", aiText: "x", contentType: "text" },
				result: undefined,
				actionId: undefined,
				provider: undefined,
			}),
		);
		expect(body).toContain("> ---");
		expect(body).toContain("> title: злой");
	});
});

describe("composeNote", () => {
	it("frontmatter carries provenance fields and telegram ids", () => {
		const note = composeNote(makePlugin(), msg(), entry(), "Мой заголовок");
		expect(note).toContain('title: "Мой заголовок"');
		expect(note).toContain('source: "telegram"');
		expect(note).toContain('type: "voice"');
		expect(note).toContain('action: "tldr"');
		expect(note).toContain('provider: "gemini/gemini-flash"');
		expect(note).toContain('status: "inbox"');
		expect(note).toContain("telegram-chat-id: 7");
		expect(note).toContain("telegram-message-id: 42");
		// Deterministic: the plain message timestamp (1763110400s), not unixTime2Date's
		// live milliseconds.
		expect(note).toContain('collected: "2025-11-14T08:53:20.000Z"');
	});

	it("telegram id stamps follow the existing setting", () => {
		const note = composeNote(makePlugin({ noteFrontmatterIds: false }), msg(), entry(), "t");
		expect(note).not.toContain("telegram-chat-id");
	});
});
