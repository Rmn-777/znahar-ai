/**
 * The MAX Bot API client — transport for the interactive flow's second channel.
 *
 * Same shape of contract as TelegramBotClient, a fraction of the surface: the MAX
 * channel of the MVP carries text messages and the button dialog; media, albums and
 * the user-account catch-up stay Telegram-only (documented in the instruction).
 *
 *   - Ordinary calls go through Obsidian's requestUrl with `Authorization: <token>`
 *     (MAX dropped query-parameter tokens).
 *   - GET /updates long-polls with `marker`; the returned marker is the ack —
 *     identical ack semantics to Telegram's offset, same stop-check-before-ack rule.
 *   - Errors surface as TelegramApiError-shaped responses (ETELEGRAM code +
 *     response.body.error_code) so the existing error machinery keeps matching.
 */

import { requestUrl } from "obsidian";
import { redactSecrets } from "src/utils/secretRedaction";
import * as Types from "./types";
import type { MaxInlineKeyboardAttachment } from "./types";

const DEFAULT_API_ROOT = "https://platform-api2.max.ru";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const POLL_ERROR_BACKOFF_MS = 5_000;

interface MaxErrorBody {
	code?: string;
	message?: string;
}

export class MaxApiError extends Error {
	readonly code = "ETELEGRAM";
	readonly response: { body: MaxErrorBody };

	constructor(method: string, body: MaxErrorBody) {
		super(`MAX ${body.code ?? "error"} ${body.message ?? "unknown"} (${method})`);
		this.name = "MaxApiError";
		this.response = { body };
	}
}

export class MaxFatalError extends Error {
	readonly code = "EFATAL";

	constructor(method: string, cause: unknown) {
		super(`EFATAL ${method}: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "MaxFatalError";
	}
}

interface MaxEvents {
	message_created: (message: Types.MaxMessage) => void;
	message_callback: (callback: Types.MaxMessageCallback) => void;
	polling_error: (error: unknown) => void;
}

export class MaxBotClient {
	private readonly token: string;
	private readonly apiRoot: string;
	private readonly pollTimeoutSeconds: number;

	private listeners = new Map<keyof MaxEvents, Set<(payload: never) => void>>();
	private polling = false;
	private pollGeneration = 0;
	private pollAbort?: AbortController;
	/** MAX's cursor: echoed back as ?marker= on the next poll; absent means "from oldest". */
	private marker?: number;
	/** Set after the first fetch failed on this network: raw fetch never worked here. */
	private pollWithRequestUrl = false;
	/** A fetch poll has completed once — the transport works on this network. */
	private fetchPollSucceeded = false;

	constructor(token: string, options?: { pollTimeoutSeconds?: number }) {
		this.token = token;
		this.apiRoot = DEFAULT_API_ROOT;
		this.pollTimeoutSeconds = options?.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
	}

	on<E extends keyof MaxEvents>(event: E, listener: MaxEvents[E]): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
	}

	private emit<E extends keyof MaxEvents>(event: E, payload: Parameters<MaxEvents[E]>[0]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of set) {
			try {
				(listener as (p: typeof payload) => void)(payload);
			} catch (e) {
				console.error(`MAX ${event} listener failed: ${redactSecrets(String(e))}`);
			}
		}
	}

	private methodUrl(method: string, query?: Record<string, string | number | undefined>): string {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) search.set(key, String(value));
		}
		const qs = search.toString();
		return `${this.apiRoot}/${method}${qs ? `?${qs}` : ""}`;
	}

	private async call<T>(
		method: string,
		init?: { query?: Record<string, string | number | undefined>; body?: unknown },
	): Promise<T> {
		let response;
		let timerId: number | undefined;
		try {
			const request = requestUrl({
				url: this.methodUrl(method, init?.query),
				method: "POST",
				contentType: "application/json",
				headers: { Authorization: this.token },
				body: JSON.stringify(init?.body ?? {}),
				throw: false,
			});
			response = await Promise.race([
				request,
				new Promise<never>((_, reject) => {
					timerId = window.setTimeout(
						() => reject(new Error(`timed out after ${REQUEST_TIMEOUT_MS} ms`)),
						REQUEST_TIMEOUT_MS,
					);
				}),
			]);
		} catch (e) {
			throw new MaxFatalError(method, e);
		} finally {
			if (timerId !== undefined) window.clearTimeout(timerId);
		}
		let payload: unknown;
		try {
			payload = response.json;
		} catch (e) {
			throw new MaxFatalError(method, e);
		}
		return this.unwrap<T>(method, payload);
	}

	private unwrap<T>(method: string, payload: unknown): T {
		const body = payload as
			| ({ success?: boolean; code?: string; message?: string } & Record<string, unknown>)
			| null;
		// MAX signals refusals both as ok:false shapes and as HTTP-200 {success:false}.
		if (body && body.success === false) {
			throw new MaxApiError(method, { code: body.code, message: body.message });
		}
		return payload as T;
	}

	isPolling(): boolean {
		return this.polling;
	}

	async startPolling(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		const generation = ++this.pollGeneration;
		void this.pollLoop(generation);
	}

	async stopPolling(): Promise<void> {
		this.polling = false;
		this.pollAbort?.abort();
	}

	private dispatch(update: Types.MaxUpdate): void {
		if (update.update_type === "message_created") this.emit("message_created", update.payload as Types.MaxMessage);
		if (update.update_type === "message_callback")
			this.emit("message_callback", update.payload as Types.MaxMessageCallback);
	}

	private async pollLoop(generation: number): Promise<void> {
		while (this.polling && generation === this.pollGeneration) {
			try {
				const response = await this.getUpdates();
				for (const update of response.updates) {
					// Ack-by-marker, same rule as Telegram's offset: stop before advancing,
					// so an unhandled tail is redelivered instead of lost.
					if (!this.polling || generation !== this.pollGeneration) return;
					if (response.marker !== undefined) this.marker = response.marker;
					this.dispatch(update);
				}
			} catch (e) {
				if (!this.polling || generation !== this.pollGeneration) return;
				this.emit("polling_error", e);
				await new Promise((resolve) => window.setTimeout(resolve, POLL_ERROR_BACKOFF_MS));
			}
		}
	}

	private async getUpdates(): Promise<Types.MaxUpdatesResponse> {
		// Unlike api.telegram.org, platform-api2.max.ru does not promise CORS headers, and
		// desktop Obsidian enforces them on raw fetch — the first fetch fails with a
		// TypeError and every poll would burn in retry purgatory. First fetch failure
		// switches to requestUrl permanently (the same pattern TelegramBotClient uses);
		// an abort is still a routine non-event, and a fetch that HAS worked once keeps
		// being the primary transport (network drops stay recoverable).
		if (this.pollWithRequestUrl) {
			return this.call<Types.MaxUpdatesResponse>("updates", {
				query: { marker: this.marker, timeout: this.pollTimeoutSeconds },
			});
		}
		const abort = new AbortController();
		this.pollAbort = abort;
		const watchdog = window.setTimeout(() => abort.abort(), (this.pollTimeoutSeconds + 15) * 1000);
		try {
			const url = this.methodUrl("updates", { marker: this.marker, timeout: this.pollTimeoutSeconds });
			const response = await fetch(url, {
				method: "GET",
				headers: { Authorization: this.token },
				signal: abort.signal,
			});
			const result = this.unwrap<Types.MaxUpdatesResponse>("updates", await response.json());
			this.fetchPollSucceeded = true;
			return result ?? { updates: [] };
		} catch (e) {
			if (abort.signal.aborted) return { updates: [] };
			if (e instanceof TypeError && !this.fetchPollSucceeded) {
				// CORS or an unrouteable transport — requestUrl is exempt from CORS in Obsidian.
				this.pollWithRequestUrl = true;
				return this.getUpdates();
			}
			throw new MaxFatalError("updates", e);
		} finally {
			window.clearTimeout(watchdog);
			if (this.pollAbort === abort) this.pollAbort = undefined;
		}
	}

	// ─── methods the MAX bridge uses ─────────────────────────────────────────

	async sendMessage(chatId: number, text: string, keyboard?: MaxInlineKeyboardAttachment): Promise<Types.MaxMessage> {
		const attachments = keyboard ? [keyboard] : undefined;
		return this.call<Types.MaxMessage>("messages", {
			query: { chat_id: chatId },
			body: { text, ...(attachments ? { attachments } : {}) },
		});
	}

	/** PUT /messages edits the text (and keyboard) of a sent message in place. */
	async editMessageText(
		chatId: number,
		messageId: string,
		text: string,
		keyboard?: MaxInlineKeyboardAttachment,
	): Promise<Types.MaxMessage> {
		const attachments = keyboard ? [keyboard] : undefined;
		return this.call<Types.MaxMessage>("messages", {
			query: { message_id: messageId, chat_id: chatId },
			body: { text, ...(attachments ? { attachments } : {}) },
		});
	}

	/** POST /answers acknowledges a button press; toast text rides the body. */
	async answerCallback(callbackId: string, text?: string): Promise<void> {
		await this.call<unknown>("answers", { query: { callback_id: callbackId }, body: text ? { text } : {} });
	}
}
