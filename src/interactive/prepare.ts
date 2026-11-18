/**
 * Prepares the source material of an interactive entry.
 *
 * Ran once per message (cached on the entry), it turns the raw Telegram update into
 * the text the actions work on: a transcript for voice, extracted text for documents,
 * the fetched page for links, the message text itself otherwise. This is the same
 * work the automatic pipeline does inline — pulled out so a second action on the same
 * message never downloads or transcribes twice.
 *
 * Attachments follow the interactive attachment setting: files are saved into the
 * vault here (so «Сохранить как есть» and the final note can embed them) or skipped,
 * in which case documents contribute their extracted text and the file stays in
 * Telegram. Photos are never downloaded here — the Vision call at action time
 * fetches the image itself.
 */

import TelegramBot from "src/telegram/botApi";
import TelegramSyncPlugin from "src/main";
import type { AIContentType } from "src/ai/contentType";
import { getTranscriptionProvider } from "src/ai/providers";
import { canExtractTextLocally, extractTextFromDocument } from "src/utils/documentExtractor";
import { extensionForMime } from "src/utils/mimeExtension";
import { concatBytes } from "src/utils/bytes";
import { getUniqueFilePath } from "src/utils/fsUtils";
import { convertMessageTextToMarkdown } from "src/telegram/bot/message/convertToMarkdown";
import { getUrls } from "src/telegram/bot/message/getters";
import { unixTime2Date } from "src/utils/dateUtils";
import { applyFilesPathTemplate } from "src/telegram/bot/message/processors";
import type { MessageDistributionRule } from "src/settings/messageDistribution";
import { defaultFileNameTemplate, defaultTelegramFolder } from "src/settings/messageDistribution";
import type { PreparedSource } from "./types";

/** Preparation failed for a reason the user should see in the chat. */
export class PrepareError extends Error {
	readonly localeKey: string;

	constructor(localeKey: string) {
		super(localeKey);
		this.name = "PrepareError";
		this.localeKey = localeKey;
	}
}

interface DownloadedFile {
	bytes: Uint8Array;
	fileName: string;
	extension: string;
	fileType: string;
	fileId: string;
	mimeType?: string;
}

/** The message's single downloadable file, in memory. Throws what the chat should show. */
async function downloadFile(plugin: TelegramSyncPlugin, msg: TelegramBot.Message): Promise<DownloadedFile | null> {
	let fileId = "";
	let fileName = "";
	let mimeType: string | undefined;
	let fileSize = 0;
	let fileType = "file";

	if (msg.voice) {
		fileId = msg.voice.file_id;
		mimeType = msg.voice.mime_type;
		fileSize = msg.voice.file_size ?? 0;
		fileType = "voice";
	} else if (msg.audio) {
		fileId = msg.audio.file_id;
		mimeType = msg.audio.mime_type;
		fileSize = msg.audio.file_size ?? 0;
		fileName = msg.audio.file_name || "";
		fileType = "audio";
	} else if (msg.video) {
		fileId = msg.video.file_id;
		mimeType = msg.video.mime_type;
		fileSize = msg.video.file_size ?? 0;
		fileName = msg.video.file_name || "";
		fileType = "video";
	} else if (msg.video_note) {
		fileId = msg.video_note.file_id;
		fileSize = msg.video_note.file_size ?? 0;
		fileType = "video";
	} else if (msg.document) {
		fileId = msg.document.file_id;
		mimeType = msg.document.mime_type;
		fileSize = msg.document.file_size ?? 0;
		fileName = msg.document.file_name || "";
		fileType = "document";
	} else {
		return null;
	}

	// The bot is only needed once the message actually carries a file: a text message
	// must prepare fine with the bot offline, so the check lives past the field scan.
	const bot = plugin.bot;
	if (!bot) throw new PrepareError("interactive.prepare.botOffline");

	if (fileSize > 20 * 1024 * 1024) {
		// Same Bot API cap as the automatic pipeline; the user-account fallback is not
		// wired into the interactive flow yet, and saying so beats a bare refusal.
		throw new PrepareError("interactive.prepare.tooBig");
	}

	const link = await bot.getFileLink(fileId);
	if (!fileName) fileName = link.split("/").pop() || "";

	const chunks: Uint8Array[] = [];
	for await (const chunk of bot.getFileStream(fileId)) {
		chunks.push(chunk);
	}
	const bytes = concatBytes(chunks);

	const extension = fileName.includes(".") ? fileName.split(".").pop() || "" : extensionForMime(mimeType || "");
	return { bytes, fileName, extension: extension || "file", fileType, fileId, mimeType };
}

/** Saves a downloaded file into the vault and returns its path; null when saving is off. */
async function saveAttachment(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	file: DownloadedFile,
	distributionRule: MessageDistributionRule | undefined,
): Promise<string | undefined> {
	if (!plugin.settings.interactiveSaveAttachments) return undefined;

	const template = distributionRule?.filePathTemplate || `${defaultTelegramFolder}/${defaultFileNameTemplate}`;
	let filePath = await applyFilesPathTemplate(plugin, template, msg, file.fileType, file.extension, file.fileName);
	filePath = await getUniqueFilePath(
		plugin.app.vault,
		plugin.createdFilePaths,
		filePath,
		unixTime2Date(msg.date, msg.message_id),
		file.extension,
	);
	const timestampMs = unixTime2Date(msg.date, msg.message_id).getTime();
	await plugin.app.vault.createBinary(filePath, new Uint8Array(file.bytes).buffer, {
		ctime: timestampMs,
		mtime: timestampMs,
	});
	return filePath;
}

/** The SOURCE text for voice/audio/video: the provider transcript. */
async function transcribeMedia(plugin: TelegramSyncPlugin, file: DownloadedFile): Promise<string> {
	const provider = getTranscriptionProvider(plugin);
	if (!provider) throw new PrepareError("interactive.prepare.noTranscriber");

	const transcript = await provider.transcribe(plugin, new Uint8Array(file.bytes).buffer, file.extension);
	if (!transcript?.trim()) throw new PrepareError("interactive.prepare.transcriptEmpty");
	return transcript.trim();
}

/** The SOURCE text for documents: local text extraction, no AI involved. */
async function extractDocumentText(file: DownloadedFile): Promise<string | null> {
	if (!canExtractTextLocally(file.fileName, file.mimeType)) return null;
	const result = await extractTextFromDocument(file.bytes, file.fileName, file.mimeType);
	return result.success && result.text.trim() ? result.text.trim() : null;
}

/** The SOURCE text for link messages: fetched pages as Markdown, truncated like the pipeline does. */
async function fetchPages(plugin: TelegramSyncPlugin, msg: TelegramBot.Message): Promise<string | null> {
	const urls = getUrls(msg);
	if (urls.length === 0) return null;

	const { fetchWebpageAsMarkdown } = await import("src/utils/webScraper");
	const { isPrivateNetworkUrl } = await import("src/utils/privateNetwork");

	let combined = "";
	let loaded = 0;
	for (const url of urls) {
		if (isPrivateNetworkUrl(url)) continue;
		try {
			const md = await fetchWebpageAsMarkdown(url, undefined, plugin.settings.aiTimeout);
			const limit = 40000;
			const sliced = md.length > limit ? md.substring(0, limit) + "...(truncated)" : md;
			combined += `\n\n--- Web content from ${url} ---\n${sliced}\n--- End of content ---\n`;
			loaded++;
		} catch {
			// An unreadable page falls back to the raw link text below.
		}
	}
	return loaded > 0 ? combined.trim() : null;
}

/**
 * Builds the PreparedSource for a message. Throws PrepareError with a locale key the
 * flow renders into the chat; the note composer falls back to the raw message when
 * the caller decides to save the source anyway.
 */
export async function prepareSource(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	distributionRule?: MessageDistributionRule,
): Promise<PreparedSource> {
	const contentType = getMessageContentTypeInteractive(msg);

	// Media with a downloadable file: transcript and/or extracted text, attachment saved.
	// Photos never download here (Vision fetches at action time); text has no file at all.
	const downloaded =
		contentType === "voice" || contentType === "audio" || contentType === "video" || contentType === "document"
			? await downloadFile(plugin, msg)
			: null;

	if (downloaded && (contentType === "voice" || contentType === "audio" || contentType === "video")) {
		const transcript = await transcribeMedia(plugin, downloaded);
		const filePath = await saveAttachment(plugin, msg, downloaded, distributionRule);
		return { sourceText: transcript, aiText: transcript, contentType, filePath, fileName: downloaded.fileName };
	}

	if (downloaded && contentType === "document") {
		// Save FIRST, extract SECOND: pdf.js takes ownership of the buffer it is handed
		// (the ArrayBuffer gets detached), and a createBinary that runs after extraction
		// constructs a Uint8Array over dead memory — "Cannot perform Construct on a
		// detached ArrayBuffer" (user-reported on a real PDF). Extraction is last.
		const filePath = await saveAttachment(plugin, msg, downloaded, distributionRule);
		const extracted = await extractDocumentText(downloaded);
		if (!extracted && !filePath) throw new PrepareError("interactive.prepare.documentOpaque");
		const text = extracted || "";
		return { sourceText: text, aiText: text, contentType, filePath, fileName: downloaded.fileName };
	}

	if (contentType === "url") {
		const pages = await fetchPages(plugin, msg);
		const fallback = convertMessageTextToMarkdown(msg).trim();
		const text = pages || fallback;
		if (!text) throw new PrepareError("interactive.prepare.pageUnreadable");
		return { sourceText: text, aiText: text, contentType };
	}

	// text / photo / unknown: the message's own text. Photos route through Vision at
	// action time; here only the caption becomes the source text.
	const text = convertMessageTextToMarkdown(msg).trim();
	return { sourceText: text, aiText: text, contentType };
}

/** Content type for the interactive flow — upstream's voice bucket, uncached, local. */
function getMessageContentTypeInteractive(msg: TelegramBot.Message): AIContentType {
	if (msg.voice || msg.video_note) return "voice";
	if (msg.photo) return "photo";
	if (msg.video) return "video";
	if (msg.audio) return "audio";
	if (msg.document) return "document";
	if (msg.text) {
		// A bare link (possibly with a caption) reads as a link so pages get fetched.
		return getUrls(msg).length > 0 && (msg.text || "").trim().length < 2000 ? "url" : "text";
	}
	return "unknown";
}
