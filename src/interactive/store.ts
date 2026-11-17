/**
 * Interactive flow state, persisted.
 *
 * One entry per source message, from the moment its action menu is posted until the
 * note is confirmed. The entry is what the Telegram buttons address: a callback only
 * carries the chat and message ids, so everything else — stage, prepared source,
 * current result, the user's thoughts — lives here and must survive a restart, or a
 * button pressed after Obsidian came back would meet an empty pipeline.
 *
 * Modeled on MessageLedger: storage injected (vault.adapter in the plugin, memory in
 * tests), writes debounced, serialization defensive. Far smaller in scope: no retry
 * counters — the ledger owns reliability; this is UI state only.
 */

import type { InteractiveEntry, InteractiveStage } from "./types";
import type TelegramBot from "src/telegram/botApi";

/** Where the store persists itself. The plugin passes vault.adapter; tests pass memory. */
export interface InteractiveStorage {
	read(): Promise<string | null>;
	write(data: string): Promise<void>;
}

export interface InteractiveStoreOptions {
	/** Upper bound on live entries; the oldest created flow falls off beyond it. */
	maxEntries?: number;
	saveDebounceMs?: number;
	/** Clock, injectable for tests. */
	now?: () => number;
}

const DEFAULTS: Required<InteractiveStoreOptions> = {
	maxEntries: 100,
	saveDebounceMs: 500,
	now: () => Date.now(),
};

const STAGES: readonly InteractiveStage[] = ["menu", "running", "preview", "editing", "awaiting_custom"];

interface StoreFile {
	version: 1;
	entries: InteractiveEntry[];
}

/** The key an entry lives under — the ledger key of the source message, without edit suffixes. */
export function interactiveKey(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

/**
 * A JSON-safe copy of a message. Same rationale as MessageLedger.toStorable: handlers
 * attach runtime properties (cycles, class instances) that break JSON.stringify, and a
 * throw inside the serializer must not cost the entry.
 */
function toStorable(msg: unknown): unknown {
	const runtimeProps = new Set(["mediaMessages", "userMsg", "originalUserMsg"]);
	const seen = new WeakSet<object>();
	try {
		return JSON.parse(
			JSON.stringify(msg, (propKey, value: unknown) => {
				if (runtimeProps.has(propKey)) return undefined;
				if (typeof value === "object" && value !== null) {
					if (seen.has(value)) return undefined;
					seen.add(value);
				}
				return value;
			}),
		);
	} catch {
		const m = msg as { chat?: { id?: number }; message_id?: number; date?: number; text?: string };
		return { chat: { id: m?.chat?.id }, message_id: m?.message_id, date: m?.date, text: m?.text };
	}
}

export class InteractiveStore {
	private readonly storage: InteractiveStorage;
	private readonly opts: Required<InteractiveStoreOptions>;

	private entries = new Map<string, InteractiveEntry>();
	private saveTimer?: ReturnType<typeof setTimeout>;
	private saving: Promise<void> = Promise.resolve();

	constructor(storage: InteractiveStorage, options: InteractiveStoreOptions = {}) {
		this.storage = storage;
		this.opts = { ...DEFAULTS, ...options };
	}

	async init(): Promise<void> {
		let raw: string | null = null;
		try {
			raw = await this.storage.read();
		} catch {
			raw = null;
		}
		if (!raw) return;

		try {
			const data = JSON.parse(raw) as Partial<StoreFile>;
			if (data.version !== 1 || !Array.isArray(data.entries)) return;
			for (const candidate of data.entries) {
				const entry = sanitizeEntry(candidate);
				if (entry) this.entries.set(entry.key, entry);
			}
		} catch {
			// Unreadable state — start fresh. UI state, not user data; the ledger owns the sources.
		}
	}

	get(chatId: number, messageId: number): InteractiveEntry | undefined {
		return this.entries.get(interactiveKey(chatId, messageId));
	}

	/**
	 * Creates or resets the entry for a message — the start of a flow. The stored message
	 * is the storable copy; the caller keeps the live one for this session's work.
	 */
	create(
		msg: TelegramBot.Message,
		stage: InteractiveStage = "menu",
		extra?: Partial<Omit<InteractiveEntry, "key" | "chatId" | "messageId" | "stage" | "msg" | "thoughts">>,
	): InteractiveEntry {
		const key = interactiveKey(msg.chat.id, msg.message_id);
		const now = this.opts.now();
		const entry: InteractiveEntry = {
			key,
			chatId: msg.chat.id,
			messageId: msg.message_id,
			stage,
			msg: toStorable(msg) as TelegramBot.Message,
			thoughts: [],
			createdAt: now,
			updatedAt: now,
			...extra,
		};
		this.entries.set(key, entry);
		this.evictOverCapacity();
		this.scheduleSave();
		return entry;
	}

	/** Merges a patch into an entry and stamps it. Undefined key is a no-op (flow already gone). */
	patch(key: string, patch: Partial<InteractiveEntry>): InteractiveEntry | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		Object.assign(entry, patch, { key: entry.key, updatedAt: this.opts.now() });
		this.scheduleSave();
		return entry;
	}

	delete(key: string): void {
		if (this.entries.delete(key)) this.scheduleSave();
	}

	size(): number {
		return this.entries.size;
	}

	/**
	 * Live entries, newest-updated first. The callback and follow-up-text routing scan
	 * them (which bubble was replied to, which flow awaits input in this chat) — a copy,
	 * so a scan cannot be confused by an entry vanishing mid-iteration.
	 */
	all(): InteractiveEntry[] {
		return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * Replaces an entry's stored message with a fresh storable copy. A replay after a
	 * restart carries the message's edited text; without this the flow would keep
	 * quoting the pre-edit version it was originally opened with.
	 */
	refreshMsg(key: string, msg: TelegramBot.Message): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.msg = toStorable(msg) as TelegramBot.Message;
		entry.updatedAt = this.opts.now();
		this.scheduleSave();
	}

	/** Oldest-created entries fall off first — an abandoned "menu" from weeks ago must not evict a live flow. */
	private evictOverCapacity(): void {
		const ordered = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
		for (let i = 0; i < ordered.length - this.opts.maxEntries; i++) {
			this.entries.delete(ordered[i].key);
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		// Bare setTimeout on purpose (see MessageLedger.scheduleSave): this module also runs
		// under Node in tests, where `window` does not exist.
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush();
		}, this.opts.saveDebounceMs);
	}

	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		// Serialised through a chain so two flushes cannot interleave their writes.
		this.saving = this.saving.then(async () => {
			const data: StoreFile = { version: 1, entries: [...this.entries.values()] };
			try {
				await this.storage.write(JSON.stringify(data));
			} catch {
				// A failed write costs durability, not correctness — same policy as the ledger.
			}
		});
		await this.saving;
	}

	/** Stops the debounce timer and writes the final state. Call from onunload. */
	async dispose(): Promise<void> {
		await this.flush();
	}
}

/**
 * Validates and repairs a loaded entry. Null drops it; a stale "running" stage is
 * coerced back to a restorable point — the process that set it died with the restart.
 */
function sanitizeEntry(raw: unknown): InteractiveEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Partial<InteractiveEntry> & Record<string, unknown>;

	if (typeof e.key !== "string" || e.msg === undefined || typeof e.msg !== "object") return null;

	const chatId = asNumber(e.chatId);
	const messageId = asNumber(e.messageId);
	// NaN from asNumber, not a Number() coercion: JSON round-trips NaN as null, and
	// Number(null) === 0 — without the typeof check a null id would resurrect as 0.
	if (chatId === undefined || messageId === undefined) return null;

	const stage = STAGES.includes(e.stage as InteractiveStage) ? (e.stage as InteractiveStage) : "menu";
	const coercedStage: InteractiveStage =
		stage === "running" ? (typeof e.result === "string" && e.result ? "preview" : "menu") : stage;

	return {
		key: e.key,
		chatId,
		messageId,
		stage: coercedStage,
		menuMessageId: asNumber(e.menuMessageId),
		msg: e.msg,
		rule: isPlainObject(e.rule) ? e.rule : undefined,
		source: isPlainObject(e.source) ? e.source : undefined,
		result: typeof e.result === "string" ? e.result : undefined,
		actionId: typeof e.actionId === "string" ? e.actionId : undefined,
		customPrompt: typeof e.customPrompt === "string" ? e.customPrompt : undefined,
		provider: typeof e.provider === "string" ? e.provider : undefined,
		thoughts: Array.isArray(e.thoughts) ? e.thoughts.filter((t): t is string => typeof t === "string") : [],
		page: asNumber(e.page),
		createdAt: asNumber(e.createdAt) ?? 0,
		updatedAt: asNumber(e.updatedAt) ?? 0,
	};
}

function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a persisted number, or undefined for anything else (null, NaN-as-null, strings). */
function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
