/**
 * prepareSource — per-type source extraction. Each test pins one branch of the type
 * switch: transcription, document extraction, page fetching, passthrough, and the
 * attachment-setting decision. External world (AI providers, web reader, Telegram
 * file API) is mocked; document extraction runs for real on .txt bytes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type TelegramBot from "src/telegram/botApi";

const { fetchWebpageMock, isPrivateNetworkMock, transcriptionProviderMock, getTranscriptionProviderMock } = vi.hoisted(
	() => ({
		fetchWebpageMock: vi.fn(),
		isPrivateNetworkMock: vi.fn(() => false),
		transcriptionProviderMock: {
			transcribe: vi.fn(),
			canTranscribe: () => true,
			hasApiKey: () => true,
		},
		getTranscriptionProviderMock: vi.fn(),
	}),
);

vi.mock("src/utils/webScraper", () => ({ fetchWebpageAsMarkdown: fetchWebpageMock }));
vi.mock("src/utils/privateNetwork", () => ({ isPrivateNetworkUrl: isPrivateNetworkMock }));
vi.mock("src/ai/providers", () => ({ getTranscriptionProvider: getTranscriptionProviderMock }));
// Real extractor by default (the .txt tests exercise it); individual tests may swap in
// a spy to simulate pdf.js buffer behavior.
vi.mock("src/utils/documentExtractor", async (importOriginal) => {
	const actual = await importOriginal<typeof import("src/utils/documentExtractor")>();
	return { ...actual, extractTextFromDocument: vi.fn(actual.extractTextFromDocument) };
});

import { prepareSource } from "./prepare";
import type TelegramSyncPlugin from "src/main";

function makePlugin(opts: { saveAttachments?: boolean; bot?: boolean } = {}): TelegramSyncPlugin {
	const vaultFiles = new Map<string, ArrayBuffer>();
	const plugin = {
		settings: {
			interactiveSaveAttachments: opts.saveAttachments ?? true,
			aiTimeout: 5000,
		},
		createdFilePaths: [],
		bot:
			opts.bot === false
				? undefined
				: {
						async getFileLink(fileId: string) {
							return `https://api.telegram.org/file/botT/${fileId}`;
						},
						async *getFileStream(fileId: string) {
							yield new TextEncoder().encode(fileId === "doc1" ? "внутри документа" : "аудиобайты");
						},
					},
		app: {
			vault: {
				getAbstractFileByPath: () => null,
				async createFolder() {},
				async createBinary(path: string, data: ArrayBuffer) {
					vaultFiles.set(path, data);
				},
			},
		},
	};
	(plugin as Record<string, unknown>).vaultFiles = vaultFiles;
	return plugin as unknown as TelegramSyncPlugin;
}

function baseMsg(fields: Partial<TelegramBot.Message>): TelegramBot.Message {
	return { message_id: 1, date: 1700000000, chat: { id: 1, type: "private" }, ...fields };
}

beforeEach(() => {
	fetchWebpageMock.mockReset();
	isPrivateNetworkMock.mockReset().mockReturnValue(false);
	transcriptionProviderMock.transcribe.mockReset();
	getTranscriptionProviderMock.mockReset().mockImplementation(() => transcriptionProviderMock);
});

describe("text passthrough", () => {
	it("uses the message text as the source", async () => {
		const source = await prepareSource(makePlugin(), baseMsg({ text: "просто текст" }));
		expect(source.sourceText).toBe("просто текст");
		expect(source.aiText).toBe("просто текст");
		expect(source.contentType).toBe("text");
		expect(source.filePath).toBeUndefined();
	});
});

describe("voice transcription", () => {
	it("transcribes and saves the attachment", async () => {
		transcriptionProviderMock.transcribe.mockResolvedValue("расшифровка голоса");
		const plugin = makePlugin();
		const source = await prepareSource(
			plugin,
			baseMsg({ voice: { file_id: "voice1", file_unique_id: "v", duration: 3 } }),
		);

		expect(source.sourceText).toBe("расшифровка голоса");
		expect(source.contentType).toBe("voice");
		expect(source.filePath).toBeDefined();
		expect((plugin as unknown as { vaultFiles: Map<string, unknown> }).vaultFiles.size).toBe(1);
	});

	it("throws a chat-ready error when no transcription provider is configured", async () => {
		getTranscriptionProviderMock.mockReturnValueOnce(null);
		await expect(
			prepareSource(makePlugin(), baseMsg({ voice: { file_id: "v", file_unique_id: "v", duration: 3 } })),
		).rejects.toMatchObject({ localeKey: "interactive.prepare.noTranscriber" });
	});

	it("throws when the provider returns an empty transcript", async () => {
		transcriptionProviderMock.transcribe.mockResolvedValue("   ");
		await expect(
			prepareSource(makePlugin(), baseMsg({ voice: { file_id: "v", file_unique_id: "v", duration: 3 } })),
		).rejects.toMatchObject({ localeKey: "interactive.prepare.transcriptEmpty" });
	});
});

describe("documents", () => {
	it("saves the attachment BEFORE extraction: a detached buffer must not kill the save", async () => {
		// pdf.js transfers (detaches) the ArrayBuffer it is handed. Reproduce that exact
		// behavior in the extractor spy: after it runs, file.bytes is dead memory — the
		// save that already happened must survive it.
		const { extractTextFromDocument } = await import("src/utils/documentExtractor");
		const sawBytesBeforeDetach = vi.fn();
		vi.mocked(extractTextFromDocument).mockImplementationOnce(async (bytes: Uint8Array) => {
			sawBytesBeforeDetach(bytes.byteLength);
			try {
				structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
			} catch {
				// Some Node buffers refuse detaching — the call order assertion below still
				// pins the regression independently.
			}
			return { success: true, text: "извлечённый текст", metadata: { format: "txt" } };
		});

		const plugin = makePlugin();
		const vaultFiles = (plugin as unknown as { vaultFiles: Map<string, unknown> }).vaultFiles;
		const createBinarySpy = vi.spyOn(plugin.app.vault, "createBinary");

		const source = await prepareSource(
			plugin,
			baseMsg({
				document: {
					file_id: "doc1",
					file_unique_id: "d",
					file_name: "отчёт.txt",
					mime_type: "text/plain",
					file_size: 10,
				},
			}),
		);

		// Order: createBinary ran while bytes were still alive (before the extractor).
		expect(createBinarySpy.mock.invocationCallOrder[0]).toBeLessThan(
			sawBytesBeforeDetach.mock.invocationCallOrder[0],
		);
		expect(vaultFiles.size).toBe(1);
		expect(source.sourceText).toBe("извлечённый текст");
		expect(source.filePath).toBeDefined();
	});

	it("extracts local text and saves the file", async () => {
		const plugin = makePlugin();
		const source = await prepareSource(
			plugin,
			baseMsg({
				document: {
					file_id: "doc1",
					file_unique_id: "d",
					file_name: "заметка.txt",
					mime_type: "text/plain",
					file_size: 15,
				},
			}),
		);

		expect(source.sourceText).toContain("внутри документа");
		expect(source.filePath).toBeDefined();
		expect(source.fileName).toBe("заметка.txt");
	});

	it("with attachment saving off, still extracts text but keeps no file", async () => {
		const plugin = makePlugin({ saveAttachments: false });
		const source = await prepareSource(
			plugin,
			baseMsg({
				document: {
					file_id: "doc1",
					file_unique_id: "d",
					file_name: "заметка.txt",
					mime_type: "text/plain",
					file_size: 15,
				},
			}),
		);
		expect(source.sourceText).toContain("внутри документа");
		expect(source.filePath).toBeUndefined();
	});

	it("an opaque document with saving off is a PrepareError, not a silent nothing", async () => {
		const plugin = makePlugin({ saveAttachments: false });
		await expect(
			prepareSource(
				plugin,
				baseMsg({
					document: {
						file_id: "doc1",
						file_unique_id: "d",
						file_name: "bin.zip",
						mime_type: "application/zip",
						file_size: 15,
					},
				}),
			),
		).rejects.toMatchObject({ localeKey: "interactive.prepare.documentOpaque" });
	});
});

describe("links", () => {
	it("fetches the page and truncates it into the source", async () => {
		fetchWebpageMock.mockResolvedValue("x".repeat(40050));
		const source = await prepareSource(makePlugin(), baseMsg({ text: "https://example.com/a" }));
		expect(source.contentType).toBe("url");
		expect(source.sourceText).toContain("Web content from https://example.com/a");
		expect(source.sourceText).toContain("(truncated)");
	});

	it("an unreadable page falls back to the raw link text", async () => {
		fetchWebpageMock.mockRejectedValue(new Error("down"));
		const source = await prepareSource(makePlugin(), baseMsg({ text: "https://example.com/a" }));
		expect(source.sourceText).toContain("https://example.com/a");
	});

	it("private network addresses are never fetched", async () => {
		isPrivateNetworkMock.mockReturnValue(true);
		const source = await prepareSource(makePlugin(), baseMsg({ text: "http://192.168.1.1/admin" }));
		expect(fetchWebpageMock).not.toHaveBeenCalled();
		expect(source.sourceText).toContain("192.168.1.1");
	});
});

describe("photos", () => {
	it("uses only the caption; no download attempted", async () => {
		const plugin = makePlugin({ bot: false });
		const source = await prepareSource(
			plugin,
			baseMsg({ photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }], caption: "подпись" }),
		);
		expect(source.contentType).toBe("photo");
		expect(source.sourceText).toBe("подпись");
		expect(source.filePath).toBeUndefined();
	});
});

describe("guard rails", () => {
	it("a big file is refused with a chat-ready error", async () => {
		await expect(
			prepareSource(
				makePlugin(),
				baseMsg({
					document: {
						file_id: "d",
						file_unique_id: "d",
						file_name: "big.pdf",
						file_size: 21 * 1024 * 1024,
					},
				}),
			),
		).rejects.toMatchObject({ localeKey: "interactive.prepare.tooBig" });
	});

	it("without a bot connection, media fails but text still passes", async () => {
		const plugin = makePlugin({ bot: false });
		await expect(
			prepareSource(plugin, baseMsg({ voice: { file_id: "v", file_unique_id: "v", duration: 3 } })),
		).rejects.toMatchObject({ localeKey: "interactive.prepare.botOffline" });

		const source = await prepareSource(plugin, baseMsg({ text: "текст без бота" }));
		expect(source.sourceText).toBe("текст без бота");
	});
});
