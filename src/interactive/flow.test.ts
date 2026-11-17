/**
 * The interactive flow state machine. Real store, real ledger, real composer; the
 * bot, the AI provider and the web reader are mocks. Each scenario pins one promise
 * the integration leans on: menu posting and resume, no-AI straight save, callback
 * routing with access control, action execution with cached preparation, confirm /
 * cancel sealing, and follow-up text claiming.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type TelegramBot from "src/telegram/botApi";

const {
	activeProviderMock,
	providerConfiguredMock,
	transcriptionProviderMock,
	getTranscriptionProviderMock,
	fetchWebpageMock,
	isPrivateNetworkMock,
} = vi.hoisted(() => ({
	activeProviderMock: {
		id: "gemini",
		getModel: vi.fn(() => "gemini-flash"),
		process: vi.fn(),
		processWithVision: vi.fn(),
	},
	providerConfiguredMock: vi.fn(() => true),
	transcriptionProviderMock: {
		transcribe: vi.fn(),
		canTranscribe: () => true,
		hasApiKey: () => true,
	},
	getTranscriptionProviderMock: vi.fn(),
	fetchWebpageMock: vi.fn(),
	isPrivateNetworkMock: vi.fn(() => false),
}));

vi.mock("src/ai/providers", () => ({
	getActiveProvider: vi.fn(() => activeProviderMock),
	isProviderConfigured: providerConfiguredMock,
	getTranscriptionProvider: getTranscriptionProviderMock,
}));
vi.mock("src/utils/webScraper", () => ({ fetchWebpageAsMarkdown: fetchWebpageMock }));
vi.mock("src/utils/privateNetwork", () => ({ isPrivateNetworkUrl: isPrivateNetworkMock }));

import { MessageLedger } from "src/processing/MessageLedger";
import { InteractiveStore } from "./store";
import { encodeCallbackData } from "./callbackData";
import {
	handleInteractiveCallback,
	handleInteractiveText,
	shouldStartInteractiveFlow,
	startInteractiveFlow,
} from "./flow";
import type TelegramSyncPlugin from "src/main";

// ─── harness ──────────────────────────────────────────────────────────────────

function makePlugin(overrides: Record<string, unknown> = {}) {
	const sentMessages: { chat: number; text: string; keyboard?: unknown }[] = [];
	const editedMessages: { chat: number; id: number; text: string; keyboard?: unknown }[] = [];
	const answered: { id: string; text?: string }[] = [];
	const notes = new Map<string, string>();

	const bot = {
		async sendMessage(chat: number, text: string, options?: { reply_markup?: unknown }) {
			const message = { message_id: 900 + sentMessages.length, chat: { id: chat } };
			sentMessages.push({ chat, text, keyboard: options?.reply_markup });
			return message;
		},
		async editMessageText(chat: number, id: number, text: string, options?: { reply_markup?: unknown }) {
			editedMessages.push({ chat, id, text, keyboard: options?.reply_markup });
			return true;
		},
		async answerCallbackQuery(id: string, options?: { text?: string }) {
			answered.push({ id, text: options?.text });
			return true;
		},
		async getFileLink(fileId: string) {
			return `https://api.telegram.org/file/botT/${fileId}`;
		},
		async *getFileStream(fileId: string) {
			yield new TextEncoder().encode(`байты ${fileId}`);
		},
	};

	const ledgerStorage = { data: null as string | null };
	const ledger = new MessageLedger(
		{
			read: async () => ledgerStorage.data,
			write: async (data: string) => {
				ledgerStorage.data = data;
			},
		},
		{ saveDebounceMs: 0 },
	);

	const flowStorage = { data: null as string | null };
	const store = new InteractiveStore(
		{
			read: async () => flowStorage.data,
			write: async (data: string) => {
				flowStorage.data = data;
			},
		},
		{ saveDebounceMs: 0 },
	);

	const plugin = {
		settings: {
			aiEnabled: true,
			aiProvider: "gemini",
			allowedChats: ["tester"],
			interactiveDisabled: false,
			interactiveInboxFolder: "_Входящие",
			interactiveSaveAttachments: false,
			interactiveActionOverrides: {},
			aiOutputLanguage: "auto",
			noteFrontmatterIds: false,
			aiTimeout: 5000,
			...overrides,
		},
		bot,
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
				async createBinary() {},
				async process() {},
			},
		},
	};
	(plugin as Record<string, unknown>).__harness = { sentMessages, editedMessages, answered, notes, ledger, store };
	return plugin as unknown as TelegramSyncPlugin & {
		__harness: {
			sentMessages: { chat: number; text: string; keyboard?: unknown }[];
			editedMessages: { chat: number; id: number; text: string; keyboard?: unknown }[];
			answered: { id: string; text?: string }[];
			notes: Map<string, string>;
			ledger: MessageLedger;
			store: InteractiveStore;
		};
	};
}

function textMsg(text = "текст сообщения", chat = 1, id = 10): TelegramBot.Message {
	return {
		message_id: id,
		date: 1763110400,
		chat: { id: chat, type: "private" },
		from: { id: 7, first_name: "T", username: "tester" },
		text,
	};
}

function voiceMsg(chat = 1, id = 11): TelegramBot.Message {
	return {
		...textMsg("", chat, id),
		text: undefined,
		voice: { file_id: "voice1", file_unique_id: "v", duration: 5 },
	};
}

function callback(plugin: TelegramSyncPlugin, data: string, from = { id: 7, first_name: "T", username: "tester" }) {
	return {
		id: `cb_${Math.random().toString(36).slice(2)}`,
		from,
		data,
		message: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
	} as TelegramBot.CallbackQuery;
}

beforeEach(async () => {
	activeProviderMock.process.mockReset().mockResolvedValue("ответ модели");
	activeProviderMock.processWithVision.mockReset().mockResolvedValue("vision ответ");
	transcriptionProviderMock.transcribe.mockReset().mockResolvedValue("транскрипт голосового");
	getTranscriptionProviderMock.mockReset().mockImplementation(() => transcriptionProviderMock);
	providerConfiguredMock.mockReset().mockReturnValue(true);
	fetchWebpageMock.mockReset();
	isPrivateNetworkMock.mockReset().mockReturnValue(false);
});

// ─── gates ────────────────────────────────────────────────────────────────────

describe("shouldStartInteractiveFlow", () => {
	it("refuses channel posts, edits and the disabled setting", () => {
		const plugin = makePlugin();
		expect(shouldStartInteractiveFlow(plugin, textMsg(), true)).toBe(false);
		expect(shouldStartInteractiveFlow(plugin, { ...textMsg(), edit_date: 1 }, false)).toBe(false);
		expect(shouldStartInteractiveFlow(makePlugin({ interactiveDisabled: true }), textMsg(), false)).toBe(false);
		expect(shouldStartInteractiveFlow(plugin, textMsg(), false)).toBe(true);
	});
});

// ─── start ────────────────────────────────────────────────────────────────────

describe("startInteractiveFlow", () => {
	it("posts a menu with a keyboard and records the bubble", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		const h = plugin.__harness;
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].keyboard).toBeDefined();
		const entry = h.store.get(1, 10);
		expect(entry?.stage).toBe("menu");
		expect(entry?.menuMessageId).toBe(900);
	});

	it("resumes an existing flow by editing, not by posting a second menu", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		await startInteractiveFlow(plugin, textMsg());
		const h = plugin.__harness;
		expect(h.sentMessages).toHaveLength(1);
		expect(h.editedMessages).toHaveLength(1);
		expect(h.editedMessages[0].id).toBe(900);
	});

	it("without usable AI, saves the source straight to the inbox and seals", async () => {
		const plugin = makePlugin({ aiEnabled: false });
		await startInteractiveFlow(plugin, textMsg("важная заметка"));
		const h = plugin.__harness;
		expect(h.sentMessages.map((m) => m.keyboard)).toEqual([undefined]); // no menu, only the receipt
		expect(h.notes.size).toBe(1);
		const [path, content] = [...h.notes.entries()][0];
		expect(path.startsWith("_Входящие/")).toBe(true);
		expect(content).toContain("[!SOURCE]");
		expect(content).toContain("важная заметка");
		expect(content).not.toContain("[!AI]");
		expect(h.ledger.isProcessed("1:10")).toBe(true);
		expect(h.store.get(1, 10)).toBeUndefined();
	});

	it("AI on but key missing behaves like no AI", async () => {
		providerConfiguredMock.mockReturnValue(false);
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		expect(plugin.__harness.notes.size).toBe(1);
	});
});

// ─── callbacks ────────────────────────────────────────────────────────────────

describe("handleInteractiveCallback", () => {
	it("ignores foreign payloads", async () => {
		const plugin = makePlugin();
		expect(await handleInteractiveCallback(plugin, callback(plugin, "update_progress"))).toBe(false);
	});

	it("answers expired for an unknown flow and consumes the press", async () => {
		const plugin = makePlugin();
		const data = encodeCallbackData(1, 999, { kind: "confirm" });
		expect(await handleInteractiveCallback(plugin, callback(plugin, data))).toBe(true);
		expect(plugin.__harness.answered[0]?.text).toBeTruthy();
	});

	it("refuses a sender outside the whitelist", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		const data = encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" });
		await handleInteractiveCallback(
			plugin,
			callback(plugin, data, { id: 99, first_name: "X", username: "stranger" }),
		);
		expect(plugin.__harness.answered[0]?.text).toBeTruthy();
		expect(activeProviderMock.process).not.toHaveBeenCalled();
	});

	it("runs an action: prepares, calls the provider, renders the preview", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, voiceMsg());
		const data = encodeCallbackData(1, 11, { kind: "action", actionId: "transcript-clean" });
		await handleInteractiveCallback(plugin, callback(plugin, data));

		const h = plugin.__harness;
		expect(h.answered[0]?.text).toBeTruthy(); // "running"
		expect(transcriptionProviderMock.transcribe).toHaveBeenCalledTimes(1);
		const entry = h.store.get(1, 11);
		expect(entry?.stage).toBe("preview");
		expect(entry?.result).toBe("ответ модели");
		expect(entry?.provider).toContain("gemini");
		// The bubble was edited to a preview carrying confirm/edit/cancel.
		expect(h.editedMessages.at(-1)?.keyboard).toBeDefined();
	});

	it("a second action on the same flow reuses the cached transcript", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, voiceMsg());
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 11, { kind: "action", actionId: "transcript-clean" })),
		);
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 11, { kind: "action", actionId: "tldr" })),
		);
		expect(transcriptionProviderMock.transcribe).toHaveBeenCalledTimes(1);
	});

	it("a prepare failure lands back on the menu with the error on the bubble", async () => {
		getTranscriptionProviderMock.mockReturnValue(null);
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, voiceMsg());
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 11, { kind: "action", actionId: "transcript-clean" })),
		);

		const h = plugin.__harness;
		const entry = h.store.get(1, 11);
		expect(entry?.stage).toBe("menu");
		expect(h.editedMessages.at(-1)?.text).toContain("⚠️");
		expect(h.editedMessages.at(-1)?.keyboard).toBeDefined();
	});

	it("confirm writes the note, seals and closes the flow", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg("текст"));
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" })),
		);
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "confirm" })));

		const h = plugin.__harness;
		expect(h.notes.size).toBe(1);
		const [path, content] = [...h.notes.entries()][0];
		expect(path.startsWith("_Входящие/")).toBe(true);
		expect(content).toContain("[!SOURCE]");
		expect(content).toContain("[!AI]");
		expect(content).toContain("ответ модели");
		expect(h.ledger.isProcessed("1:10")).toBe(true);
		expect(h.store.get(1, 10)).toBeUndefined();
		// Receipt replaced the preview keyboard.
		expect(h.editedMessages.at(-1)?.keyboard).toBeUndefined();
	});

	it("cancel keeps only the source layer", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg("текст"));
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" })),
		);
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "cancel" })));

		const h = plugin.__harness;
		expect(h.notes.size).toBe(1);
		const [, content] = [...h.notes.entries()][0];
		expect(content).toContain("[!SOURCE]");
		expect(content).not.toContain("[!AI]");
		expect(h.ledger.isProcessed("1:10")).toBe(true);
	});

	it("a running flow answers busy and executes nothing", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		const entry = plugin.__harness.store.get(1, 10)!;
		plugin.__harness.store.patch(entry.key, { stage: "running" });
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" })),
		);
		expect(activeProviderMock.process).not.toHaveBeenCalled();
		expect(plugin.__harness.answered[0]?.text).toBeTruthy();
	});

	it("paging switches the bubble to the catalog page", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "page", page: 1 })));
		const entry = plugin.__harness.store.get(1, 10);
		expect(entry?.stage).toBe("menu");
		expect(entry?.page).toBe(1);
		expect(plugin.__harness.editedMessages.at(-1)?.text).toContain("2");
	});
});

// ─── follow-up text ───────────────────────────────────────────────────────────

describe("handleInteractiveText", () => {
	it("claims nothing when no flow awaits input", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg()); // stage: menu
		expect(await handleInteractiveText(plugin, textMsg("просто текст", 1, 20))).toBe(false);
	});

	it("a typed command runs as a custom action titled custom", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "custom" })));
		expect(await handleInteractiveText(plugin, textMsg("найди все имена", 1, 20))).toBe(true);

		const entry = plugin.__harness.store.get(1, 10);
		expect(entry?.stage).toBe("preview");
		expect(entry?.actionId).toBe("custom");
		const prompt = activeProviderMock.process.mock.calls.at(-1)?.[2] as string;
		expect(prompt).toContain("найди все имена");
	});

	it("a reply to the flow bubble wins over other flows", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg("первое", 1, 10));
		await startInteractiveFlow(plugin, textMsg("второе", 1, 11));
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 11, { kind: "custom" })));

		const reply = {
			...textMsg("команда для второго", 1, 20),
			reply_to_message: { message_id: plugin.__harness.store.get(1, 11)!.menuMessageId },
		} as TelegramBot.Message;
		expect(await handleInteractiveText(plugin, reply)).toBe(true);
		expect(plugin.__harness.store.get(1, 11)?.stage).toBe("preview");
		expect(plugin.__harness.store.get(1, 10)?.stage).toBe("menu");
	});

	it("+ text in editing appends a thought without touching the provider", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" })),
		);
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "edit" })));
		const callsBefore = activeProviderMock.process.mock.calls.length;

		expect(await handleInteractiveText(plugin, textMsg("+ моя мысль", 1, 20))).toBe(true);
		const entry = plugin.__harness.store.get(1, 10);
		expect(entry?.thoughts).toEqual(["моя мысль"]);
		expect(entry?.stage).toBe("preview");
		expect(activeProviderMock.process.mock.calls.length).toBe(callsBefore);
	});

	it("a revision instruction rewrites the result through the model", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" })),
		);
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "edit" })));
		activeProviderMock.process.mockResolvedValueOnce("пересмотренный ответ");

		expect(await handleInteractiveText(plugin, textMsg("сократи вдвое", 1, 20))).toBe(true);
		const entry = plugin.__harness.store.get(1, 10);
		expect(entry?.result).toBe("пересмотренный ответ");
		expect(entry?.stage).toBe("preview");
		const [, content, prompt] = activeProviderMock.process.mock.calls.at(-1) as [unknown, string, string];
		expect(content).toContain("Revision instruction");
		expect(prompt).toContain("revised note");
	});

	it("a thought survives into the confirmed note's Мои мысли layer", async () => {
		const plugin = makePlugin();
		await startInteractiveFlow(plugin, textMsg());
		await handleInteractiveCallback(
			plugin,
			callback(plugin, encodeCallbackData(1, 10, { kind: "action", actionId: "tldr" })),
		);
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "edit" })));
		await handleInteractiveText(plugin, textMsg("+ помнить про дедлайн", 1, 20));
		await handleInteractiveCallback(plugin, callback(plugin, encodeCallbackData(1, 10, { kind: "confirm" })));

		const [, note] = [...plugin.__harness.notes.entries()][0];
		expect(note).toContain("Мои мысли");
		expect(note).toContain("помнить про дедлайн");
	});
});
