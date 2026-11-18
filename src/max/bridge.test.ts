/**
 * The MAX bridge end-to-end: a real store + ledger + maxBot spy. Pins the channel
 * promises — menu posted through MAX (not Telegram), entries carry channel "max",
 * ledger sealed at menu-post, denial answers with the user id, callbacks route to
 * the flow and are answered via MAX.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { activeProviderMock, providerConfiguredMock } = vi.hoisted(() => ({
	activeProviderMock: {
		id: "custom",
		getModel: vi.fn(() => "test-model"),
		process: vi.fn(),
		processWithVision: vi.fn(),
	},
	providerConfiguredMock: vi.fn(() => true),
}));

vi.mock("src/ai/providers", () => ({
	getActiveProvider: vi.fn(() => activeProviderMock),
	isProviderConfigured: providerConfiguredMock,
	getTranscriptionProvider: vi.fn(() => null),
}));

import { MessageLedger } from "src/processing/MessageLedger";
import { InteractiveStore } from "src/interactive/store";
import { encodeCallbackData } from "src/interactive/callbackData";
import { handleCallbackFromMax, handleMessageFromMax } from "./bridge";
import type TelegramSyncPlugin from "src/main";

function makePlugin(opts: { allowed?: string[] } = {}) {
	const sentMessages: { chat: number; text: string; keyboard?: unknown }[] = [];
	const answered: { id: string; text?: string }[] = [];
	const notes = new Map<string, string>();

	const maxBot = {
		async sendMessage(chat: number, text: string, keyboard?: unknown) {
			sentMessages.push({ chat, text, keyboard });
			return { body: { mid: String(7000 + sentMessages.length) } };
		},
		async editMessageText(chat: number, mid: string, text: string, keyboard?: unknown) {
			return { body: { mid } };
		},
		async answerCallback(id: string, text?: string) {
			answered.push({ id, text });
		},
	};

	const ledger = new MessageLedger({ read: async () => null, write: async () => {} }, { saveDebounceMs: 0 });
	const store = new InteractiveStore({ read: async () => null, write: async () => {} }, { saveDebounceMs: 0 });

	const plugin = {
		settings: {
			aiEnabled: true,
			aiProvider: "custom",
			allowedChats: opts.allowed ?? ["7"],
			interactiveDisabled: false,
			interactiveInboxFolder: "_Входящие",
			interactiveSaveAttachments: false,
			interactiveActionOverrides: {},
			aiOutputLanguage: "auto",
			noteFrontmatterIds: false,
			aiTimeout: 5000,
			maxEnabled: true,
		},
		maxBot,
		createdFilePaths: [],
		messageLedger: ledger,
		interactiveStore: store,
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (notes.has(p) ? { path: p } : null),
				async createFolder() {},
				async create(path: string, data: string) {
					notes.set(path, data);
				},
			},
		},
	};
	(plugin as Record<string, unknown>).__harness = { sentMessages, answered, notes, ledger, store, maxBot };
	return plugin as unknown as TelegramSyncPlugin & {
		__harness: {
			sentMessages: { chat: number; text: string; keyboard?: unknown }[];
			answered: { id: string; text?: string }[];
			notes: Map<string, string>;
			ledger: MessageLedger;
			store: InteractiveStore;
			maxBot: { sendMessage: (chat: number, text: string, kb?: unknown) => Promise<{ body: { mid: string } }> };
		};
	};
}

function maxText(text = "привет из MAX") {
	return {
		sender: { user_id: 7, username: "roman", name: "Роман" },
		recipient: { chat_type: "dialog" as const, chat_id: -66329287241 },
		timestamp: 1763110400,
		body: { mid: "5710327117067269", text },
	};
}

beforeEach(() => {
	activeProviderMock.process.mockReset().mockResolvedValue("ответ модели");
	providerConfiguredMock.mockReset().mockReturnValue(true);
});

describe("MAX bridge → interactive core", () => {
	it("posts the menu through MAX and marks the entry channel=max", async () => {
		const plugin = makePlugin();
		await handleMessageFromMax(plugin, maxText());

		const h = plugin.__harness;
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].keyboard).toBeDefined(); // MAX inline keyboard attachment
		const entry = h.store.get(-66329287241, 5710327117067269);
		expect(entry?.channel).toBe("max");
		expect(entry?.stage).toBe("menu");
		// Sealed at menu-post: the ledger must never replay a MAX message through Telegram.
		expect(h.ledger.isProcessed("-66329287241:5710327117067269")).toBe(true);
	});

	it("a duplicate delivery is skipped", async () => {
		const plugin = makePlugin();
		await handleMessageFromMax(plugin, maxText());
		await handleMessageFromMax(plugin, maxText());
		expect(plugin.__harness.sentMessages).toHaveLength(1);
	});

	it("denies a stranger with their user id, no menu", async () => {
		const plugin = makePlugin({ allowed: ["someoneelse"] });
		await handleMessageFromMax(plugin, maxText());
		const h = plugin.__harness;
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].text).toContain('"7"'); // the id to whitelist
		expect(h.store.get(-66329287241, 5710327117067269)).toBeUndefined();
	});

	it("a callback runs the action and is answered via MAX", async () => {
		const plugin = makePlugin();
		await handleMessageFromMax(plugin, maxText());
		await handleCallbackFromMax(plugin, {
			callback_id: "cb1",
			user: { user_id: 7, username: "roman" },
			message: maxText(),
			payload: encodeCallbackData(-66329287241, 5710327117067269, { kind: "action", actionId: "tldr" }),
		});

		const h = plugin.__harness;
		expect(h.answered).toHaveLength(1);
		const entry = h.store.get(-66329287241, 5710327117067269);
		expect(entry?.stage).toBe("preview");
		expect(entry?.result).toBe("ответ модели");
	});

	it("a stranger's callback is answered denied and runs nothing", async () => {
		const plugin = makePlugin({ allowed: ["7"] });
		await handleMessageFromMax(plugin, maxText());
		activeProviderMock.process.mockClear();
		await handleCallbackFromMax(plugin, {
			callback_id: "cb2",
			user: { user_id: 99, username: "mallory" },
			message: maxText(),
			payload: encodeCallbackData(-66329287241, 5710327117067269, { kind: "action", actionId: "tldr" }),
		});
		expect(activeProviderMock.process).not.toHaveBeenCalled();
		expect(plugin.__harness.answered[0]?.text).toBeTruthy();
	});

	it("follow-up text claims the awaiting flow of the MAX channel", async () => {
		const plugin = makePlugin();
		await handleMessageFromMax(plugin, maxText());
		await handleCallbackFromMax(plugin, {
			callback_id: "cb3",
			user: { user_id: 7, username: "roman" },
			message: maxText(),
			payload: encodeCallbackData(-66329287241, 5710327117067269, { kind: "custom" }),
		});
		const claimed = await import("./bridge").then((b) =>
			b.handleTextFromMax(plugin, {
				...maxText("найди даты"),
				body: { mid: "5710327117067270", text: "найди даты" },
			}),
		);
		expect(claimed).toBe(true);
		const entry = plugin.__harness.store.get(-66329287241, 5710327117067269);
		expect(entry?.stage).toBe("preview");
		expect(entry?.actionId).toBe("custom");
	});
});
