/**
 * The action catalog of the interactive flow.
 *
 * Every preset action the menu can offer lives here once: its id (also its
 * callback_data token and its locale key), which source types it applies to, its
 * default enablement, and its builtin English prompt — the output-language
 * instruction is appended by the AI layer, exactly like the content-type prompts.
 * Settings override three things per action: enabled, quick-set membership and the
 * prompt (empty override = builtin). Menu labels come from the locale files
 * (`interactive.actions.<id>`), so the catalog itself stays language-free.
 */

import type { AIContentType } from "src/ai/contentType";

export interface CatalogAction {
	/** [a-z0-9-]+ — it travels in callback_data and keys the settings overrides. */
	readonly id: string;
	readonly icon: string;
	/** Source content types the action applies to; "all" for every type. */
	readonly appliesTo: readonly AIContentType[] | "all";
	readonly defaultEnabled: boolean;
	/** Part of the quick set (the first screen) for its applicable types. */
	readonly defaultQuick: boolean;
	/** The builtin English prompt. Appended: injection guard + output language, by the AI layer. */
	readonly prompt: string;
	/** No AI call — the note is the source itself. */
	readonly noAI?: boolean;
	/** The action needs the user to type something first (a question, an instruction). */
	readonly requiresPrompt?: boolean;
}

export interface ActionOverride {
	enabled?: boolean;
	quick?: boolean;
	prompt?: string;
}

/** The settings slice the catalog reads. Kept structural so Settings.ts just embeds it. */
export interface CatalogSettings {
	interactiveActionOverrides?: Record<string, ActionOverride>;
}

/** Buttons per catalog page — Telegram shows ~8 rows comfortably on one screen. */
export const CATALOG_PAGE_SIZE = 8;

const AUDIO_TYPES: readonly AIContentType[] = ["voice", "audio", "video"];

/**
 * Catalog order is menu order: universal actions first, then per-type groups —
 * the same order the spec's §5 numbering follows.
 */
const ACTIONS: readonly CatalogAction[] = [
	// ── universal ────────────────────────────────────────────────────────────
	{
		id: "save-asis",
		icon: "📥",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "",
		noAI: true,
	},
	{
		id: "tldr",
		icon: "⚡",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "Summarize the material as a concise digest: 3–7 bullet points of the essence, then a one-line takeaway. Preserve important numbers, dates and names.",
	},
	{
		id: "full-review",
		icon: "🔬",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Produce a thorough, well-structured breakdown of the material: sections with headings, key facts, arguments, notable quotes, and a short conclusion. Keep important details and the original wording where it matters.",
	},
	{
		id: "extract-tasks",
		icon: "✅",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Extract every actionable item from the material as a Markdown checklist ('- [ ] '), with owners and deadlines where they are mentioned. Add nothing that is not in the material.",
	},
	{
		id: "extract-facts",
		icon: "🔢",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Extract the concrete facts and figures from the material: dates, numbers, amounts, names, places, commitments. Output a compact Markdown list grouped by topic.",
	},
	{
		id: "translate",
		icon: "🌐",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Translate the material faithfully, keeping its structure and Markdown formatting. Translate into the response language.",
	},
	{
		id: "explain-simple",
		icon: "🧒",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Explain the material in simple words, as if to someone new to the topic. Stay accurate; use analogies where they help.",
	},
	{
		id: "critique",
		icon: "🧭",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Review the material critically: strong points, weak points, unsupported claims, contradictions, and what would need fact-checking. Be specific, quote the material.",
	},
	{
		id: "format-note",
		icon: "📝",
		appliesTo: "all",
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "Turn the material into a clean, well-structured note: a clear title line, logical sections with headings, bullet points where they help, key facts preserved. Invent nothing.",
	},
	// ── links ───────────────────────────────────────────────────────────────
	{
		id: "read-article",
		icon: "📖",
		appliesTo: ["url", "text"],
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "Read the article behind the link and produce a structured summary: what it is about, the key points, notable quotes with context, and who/what it concerns.",
	},
	{
		id: "link-card",
		icon: "🔖",
		appliesTo: ["url", "text"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Create a read-later card for the link: title, source/author and date when known, a 2–3 sentence description of what it holds, and key quotes.",
	},
	{
		id: "video-notes",
		icon: "🎬",
		appliesTo: ["url"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Using the transcript of the video or podcast behind the link, write structured notes: topics with timestamps where available, key statements, takeaways. If no transcript is provided, say the transcript is unavailable and describe only what the title and description establish.",
	},
	// ── voice and audio ─────────────────────────────────────────────────────
	{
		id: "transcript-verbatim",
		icon: "🗣",
		appliesTo: AUDIO_TYPES,
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Transcribe the audio verbatim in the original language. Keep the words as spoken; mark unclear passages as [inaudible]. Do not summarize.",
	},
	{
		id: "transcript-clean",
		icon: "🧹",
		appliesTo: AUDIO_TYPES,
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "Write a clean, readable transcript of the audio in the original language: remove filler words and repetitions, fix punctuation and paragraphing, but keep every meaningful statement and the speaker's own wording.",
	},
	{
		id: "meeting-protocol",
		icon: "📋",
		appliesTo: AUDIO_TYPES,
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Produce meeting minutes from the transcript: participants, agenda, decisions made, action items with owners, open questions.",
	},
	{
		id: "lecture-notes",
		icon: "🎓",
		appliesTo: AUDIO_TYPES,
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Write structured study notes from the lecture or podcast transcript: main topics as headings, definitions of key terms, examples, and a short summary at the end.",
	},
	// ── photos and screenshots ──────────────────────────────────────────────
	{
		id: "ocr",
		icon: "🔍",
		appliesTo: ["photo"],
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "Extract ALL visible text from the image as Markdown. Reproduce the layout where it helps readability (headings, lists, tables). Do not translate and do not comment.",
	},
	{
		id: "describe-image",
		icon: "🖼",
		appliesTo: ["photo"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Describe what the image shows in a structured way. If it contains a chart or diagram, read off the data and state its main takeaway.",
	},
	{
		id: "chat-screenshot",
		icon: "💬",
		appliesTo: ["photo"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "This is a screenshot of a chat. Summarize who said what, list the agreements reached and the action items, and quote the key lines verbatim.",
	},
	{
		id: "error-screenshot",
		icon: "🐞",
		appliesTo: ["photo"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "This is a screenshot of an error or an interface. Describe the visible problem in a structured form suitable for a bug report: context, expected vs actual, the error text, the visible UI elements.",
	},
	// ── documents ───────────────────────────────────────────────────────────
	{
		id: "doc-summary",
		icon: "📄",
		appliesTo: ["document"],
		defaultEnabled: true,
		defaultQuick: true,
		prompt: "Summarize the document: its purpose, structure, key points per section, and the most important quotes — with page or section references where available.",
	},
	{
		id: "extract-tables",
		icon: "📊",
		appliesTo: ["document"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Extract every table from the document as Markdown tables, each preceded by a short caption of what it holds. If there are no tables, say so.",
	},
	{
		id: "ask-document",
		icon: "❓",
		appliesTo: ["document"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Using the document, answer the user's question precisely. Quote the passages the answer rests on; say clearly when the document does not answer it.",
		requiresPrompt: true,
	},
	// ── forwarded and dialogs ───────────────────────────────────────────────
	{
		id: "merge-forward",
		icon: "🧵",
		appliesTo: ["text"],
		defaultEnabled: true,
		defaultQuick: false,
		prompt: "Merge the forwarded messages into one coherent note: keep the context of who sent what and when, resolve the discussion into a short summary of what was said, agreed and asked.",
	},
];

export function allActions(): readonly CatalogAction[] {
	return ACTIONS;
}

export function getAction(id: string): CatalogAction | undefined {
	return ACTIONS.find((a) => a.id === id);
}

export function appliesToType(action: CatalogAction, contentType: AIContentType): boolean {
	return action.appliesTo === "all" || action.appliesTo.includes(contentType);
}

export function isActionEnabled(settings: CatalogSettings, action: CatalogAction): boolean {
	const override = settings.interactiveActionOverrides?.[action.id];
	return override?.enabled ?? action.defaultEnabled;
}

export function isQuickAction(settings: CatalogSettings, action: CatalogAction): boolean {
	const override = settings.interactiveActionOverrides?.[action.id];
	return override?.quick ?? action.defaultQuick;
}

/** The builtin prompt with the user's override applied — empty override means builtin. */
export function effectivePrompt(settings: CatalogSettings, action: CatalogAction): string {
	const custom = settings.interactiveActionOverrides?.[action.id]?.prompt?.trim();
	return custom ? custom : action.prompt;
}

/** Enabled actions that apply to the source type, in catalog order. */
export function enabledActionsFor(settings: CatalogSettings, contentType: AIContentType): CatalogAction[] {
	return ACTIONS.filter((a) => appliesToType(a, contentType) && isActionEnabled(settings, a));
}

/** The quick set for the source type: enabled + quick + applicable. */
export function quickActionsFor(settings: CatalogSettings, contentType: AIContentType): CatalogAction[] {
	return enabledActionsFor(settings, contentType).filter((a) => isQuickAction(settings, a));
}

/** Pages over the full catalog for the type (quick actions included — they are all there is on page 0 when everything else is off). */
export function catalogPageCount(settings: CatalogSettings, contentType: AIContentType): number {
	const total = enabledActionsFor(settings, contentType).length;
	return Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
}
