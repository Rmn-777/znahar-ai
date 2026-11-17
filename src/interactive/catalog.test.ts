/**
 * The action catalog: ordering guarantees the menu leans on, settings overrides,
 * and per-type applicability — the quick set for a voice message must not offer OCR.
 */
import { describe, expect, it } from "vitest";
import { encodeCallbackData } from "./callbackData";
import {
	CATALOG_PAGE_SIZE,
	allActions,
	catalogPageCount,
	enabledActionsFor,
	effectivePrompt,
	getAction,
	quickActionsFor,
	type CatalogSettings,
} from "./catalog";

describe("catalog integrity", () => {
	it("ids are unique and callback-safe", () => {
		const ids = allActions().map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const action of allActions()) {
			expect(action.id).toMatch(/^[a-z0-9-]+$/);
		}
	});

	it("every action id fits callback_data with a long negative chat id", () => {
		for (const action of allActions()) {
			expect(() =>
				encodeCallbackData(-1001234567890, 999999, { kind: "action", actionId: action.id }),
			).not.toThrow();
		}
	});

	it("exactly one action is the no-AI save", () => {
		expect(
			allActions()
				.filter((a) => a.noAI)
				.map((a) => a.id),
		).toEqual(["save-asis"]);
	});
});

describe("per-type quick set", () => {
	const settings: CatalogSettings = {};

	it("voice offers the transcript action, not OCR or doc summaries", () => {
		const ids = quickActionsFor(settings, "voice").map((a) => a.id);
		expect(ids).toContain("save-asis");
		expect(ids).toContain("tldr");
		expect(ids).toContain("format-note");
		expect(ids).toContain("transcript-clean");
		expect(ids).not.toContain("ocr");
		expect(ids).not.toContain("doc-summary");
		expect(ids).not.toContain("read-article");
	});

	it("photo quick set is OCR; document quick set is the summary; url quick set reads the article", () => {
		expect(quickActionsFor(settings, "photo").map((a) => a.id)).toContain("ocr");
		expect(quickActionsFor(settings, "document").map((a) => a.id)).toContain("doc-summary");
		expect(quickActionsFor(settings, "url").map((a) => a.id)).toContain("read-article");
	});

	it("audio-only actions never leak into text", () => {
		const ids = enabledActionsFor(settings, "text").map((a) => a.id);
		expect(ids).not.toContain("transcript-verbatim");
		expect(ids).not.toContain("meeting-protocol");
	});
});

describe("settings overrides", () => {
	it("a disabled action leaves both the catalog and the quick set", () => {
		const settings: CatalogSettings = { interactiveActionOverrides: { tldr: { enabled: false } } };
		expect(enabledActionsFor(settings, "text").map((a) => a.id)).not.toContain("tldr");
		expect(quickActionsFor(settings, "text").map((a) => a.id)).not.toContain("tldr");
	});

	it("a quick override promotes an action to the first screen", () => {
		const settings: CatalogSettings = { interactiveActionOverrides: { critique: { quick: true } } };
		expect(quickActionsFor(settings, "text").map((a) => a.id)).toContain("critique");
	});

	it("a non-empty prompt override replaces the builtin; empty keeps builtin", () => {
		const custom = "Мой собственный промпт.";
		const withOverride: CatalogSettings = { interactiveActionOverrides: { tldr: { prompt: custom } } };
		const withEmpty: CatalogSettings = { interactiveActionOverrides: { tldr: { prompt: "   " } } };
		const action = getAction("tldr")!;
		expect(effectivePrompt(withOverride, action)).toBe(custom);
		expect(effectivePrompt(withEmpty, action)).toBe(action.prompt);
	});
});

describe("pagination", () => {
	it("at least one page; grows by CATALOG_PAGE_SIZE steps", () => {
		const settings: CatalogSettings = {};
		const text = catalogPageCount(settings, "text");
		expect(text).toBeGreaterThanOrEqual(1);
		expect(text).toBe(Math.ceil(enabledActionsFor(settings, "text").length / CATALOG_PAGE_SIZE));
	});

	it("collapses to a single page when almost everything is disabled", () => {
		const overrides = Object.fromEntries(
			allActions()
				.filter((a) => a.id !== "save-asis")
				.map((a) => [a.id, { enabled: false }]),
		);
		const settings: CatalogSettings = { interactiveActionOverrides: overrides };
		expect(enabledActionsFor(settings, "photo").map((a) => a.id)).toEqual(["save-asis"]);
		expect(catalogPageCount(settings, "photo")).toBe(1);
	});
});
