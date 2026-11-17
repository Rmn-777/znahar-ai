/**
 * runAction / runCustomCommand — the AI call behind a menu button. Mocked provider
 * captures the prompt: pinning the wrap order (user prompt → injection guard →
 * output language), the photo→Vision routing, no-AI passthrough, and the error keys.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type TelegramBot from "src/telegram/botApi";

const { activeProviderMock } = vi.hoisted(() => ({
	activeProviderMock: {
		id: "gemini",
		getModel: vi.fn(() => "gemini-flash"),
		process: vi.fn(),
		processWithVision: vi.fn(),
	},
}));

vi.mock("src/ai/providers", () => ({ getActiveProvider: vi.fn(() => activeProviderMock) }));

import { buildActionPrompt, runAction, runCustomCommand } from "./runner";
import { getAction } from "./catalog";
import type TelegramSyncPlugin from "src/main";

function makePlugin(settings: Record<string, unknown> = {}): TelegramSyncPlugin {
	return {
		settings: { aiOutputLanguage: "ru", interactiveActionOverrides: {}, ...settings },
	} as unknown as TelegramSyncPlugin;
}

function msg(): TelegramBot.Message {
	return { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "исходник" };
}

const SOURCE_TEXT = { sourceText: "текст источника", aiText: "текст для модели", contentType: "text" as const };
const SOURCE_PHOTO = { sourceText: "подпись", aiText: "подпись", contentType: "photo" as const };

beforeEach(() => {
	activeProviderMock.process.mockReset().mockResolvedValue("ответ модели");
	activeProviderMock.processWithVision.mockReset().mockResolvedValue("ответ vision");
	activeProviderMock.getModel.mockClear();
});

describe("prompt assembly", () => {
	it("wraps the builtin prompt: injection guard inside, output language last", () => {
		const prompt = buildActionPrompt(makePlugin(), getAction("tldr")!);
		const guardAt = prompt.indexOf("strictly as data to process");
		const promptAt = prompt.indexOf("concise digest");
		const languageAt = prompt.indexOf("Write the response in Russian.");
		expect(promptAt).toBeGreaterThan(-1);
		expect(guardAt).toBeGreaterThan(promptAt);
		expect(languageAt).toBeGreaterThan(guardAt);
	});

	it("a non-empty settings override replaces the builtin", () => {
		const plugin = makePlugin({ interactiveActionOverrides: { tldr: { prompt: "мой промпт" } } });
		expect(buildActionPrompt(plugin, getAction("tldr")!)).toContain("мой промпт");
	});

	it("customPrompt wins over everything", () => {
		const plugin = makePlugin({ interactiveActionOverrides: { tldr: { prompt: "override" } } });
		expect(buildActionPrompt(plugin, getAction("tldr")!, "своя инструкция")).toContain("своя инструкция");
		expect(buildActionPrompt(plugin, getAction("tldr")!, "своя инструкция")).not.toContain("override");
	});
});

describe("runs", () => {
	it("text actions call the provider with the source and return provenance", async () => {
		const result = await runAction(makePlugin(), msg(), SOURCE_TEXT, getAction("tldr")!);
		expect(result).toEqual({ text: "ответ модели", provider: "gemini/gemini-flash" });
		const [pluginArg, contentArg, promptArg] = activeProviderMock.process.mock.calls[0];
		expect(pluginArg).toBeDefined();
		expect(contentArg).toBe("текст для модели");
		expect(promptArg).toContain("concise digest");
	});

	it("photos route through Vision", async () => {
		await runAction(makePlugin(), msg(), SOURCE_PHOTO, getAction("describe-image")!);
		expect(activeProviderMock.processWithVision).toHaveBeenCalledTimes(1);
		expect(activeProviderMock.process).not.toHaveBeenCalled();
	});

	it("the no-AI action never reaches the provider", async () => {
		const result = await runAction(makePlugin(), msg(), { ...SOURCE_TEXT, aiText: "" }, getAction("save-asis")!);
		expect(result.text).toBe("текст источника");
		expect(result.provider).toBe("none");
		expect(activeProviderMock.process).not.toHaveBeenCalled();
	});

	it("a custom command runs verbatim through the same wrap", async () => {
		const result = await runCustomCommand(makePlugin(), msg(), SOURCE_TEXT, "  найди все имена  ");
		expect(result.text).toBe("ответ модели");
		expect(activeProviderMock.process.mock.calls[0][2]).toContain("найди все имена");
	});

	it("an empty custom command is refused before any call", async () => {
		await expect(runCustomCommand(makePlugin(), msg(), SOURCE_TEXT, "   ")).rejects.toMatchObject({
			localeKey: "interactive.run.emptyCommand",
		});
		expect(activeProviderMock.process).not.toHaveBeenCalled();
	});
});

describe("failures", () => {
	it("a null provider answer is a chat-ready error", async () => {
		activeProviderMock.process.mockResolvedValue(null);
		await expect(runAction(makePlugin(), msg(), SOURCE_TEXT, getAction("tldr")!)).rejects.toMatchObject({
			localeKey: "interactive.run.failed",
		});
	});

	it("empty source material for an AI action is refused", async () => {
		await expect(
			runAction(makePlugin(), msg(), { ...SOURCE_TEXT, aiText: "  " }, getAction("tldr")!),
		).rejects.toMatchObject({ localeKey: "interactive.run.emptySource" });
	});
});
