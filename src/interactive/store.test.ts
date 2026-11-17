/**
 * InteractiveStore — persistence of the per-message flow state. The scenarios that
 * matter: restart recovery (stale "running" coerced to a restorable stage), defensive
 * loading, eviction, and the serialization traps MessageLedger already taught us
 * about (runtime props, cycles).
 */
import { describe, expect, it } from "vitest";
import { InteractiveStore, interactiveKey, type InteractiveStorage } from "./store";
import type { InteractiveEntry, InteractiveStage } from "./types";
import type TelegramBot from "src/telegram/botApi";

function memoryStorage(initial: string | null = null): InteractiveStorage & { data: string | null } {
	return {
		data: initial,
		async read() {
			return this.data;
		},
		async write(data: string) {
			this.data = data;
		},
	};
}

function msg(chatId: number, messageId: number): TelegramBot.Message {
	return { message_id: messageId, date: 0, chat: { id: chatId, type: "private" }, text: "привет" };
}

function entry(overrides: Partial<InteractiveEntry> = {}): InteractiveEntry {
	return {
		key: interactiveKey(1, 10),
		chatId: 1,
		messageId: 10,
		stage: "menu",
		msg: msg(1, 10),
		thoughts: [],
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

async function makeStore(initial: string | null = null) {
	const storage = memoryStorage(initial);
	const store = new InteractiveStore(storage, { saveDebounceMs: 0 });
	await store.init();
	return { store, storage };
}

describe("create/get/patch/delete", () => {
	it("creates an entry and finds it by chat and message ids", async () => {
		const { store } = await makeStore();
		store.create(msg(5, 77));
		expect(store.get(5, 77)?.key).toBe("5:77");
		expect(store.get(5, 78)).toBeUndefined();
	});

	it("patch merges, stamps and keeps identity fields", async () => {
		const { store } = await makeStore();
		const created = store.create(msg(1, 10));
		const patched = store.patch(created.key, { stage: "preview", result: "готово" });
		expect(patched?.stage).toBe("preview");
		expect(patched?.result).toBe("готово");
		expect(patched?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
		// Identity is not patchable — the key is what callbacks address.
		expect(patched?.key).toBe(created.key);
		expect(patched?.chatId).toBe(1);
	});

	it("patch of a missing key is a no-op", async () => {
		const { store } = await makeStore();
		expect(store.patch("9:9", { stage: "menu" })).toBeUndefined();
	});

	it("delete removes the entry", async () => {
		const { store } = await makeStore();
		store.create(msg(1, 10));
		store.delete("1:10");
		expect(store.get(1, 10)).toBeUndefined();
	});
});

describe("persistence", () => {
	it("flush writes entries; init reads them back", async () => {
		const { store, storage } = await makeStore();
		store.create(msg(1, 10), "preview", { result: "текст результата", actionId: "tldr" });
		await store.flush();

		const { store: reloaded } = await makeStore(storage.data);
		const restored = reloaded.get(1, 10);
		expect(restored?.stage).toBe("preview");
		expect(restored?.result).toBe("текст результата");
		expect(restored?.actionId).toBe("tldr");
	});

	it("a stale running stage recovers to preview when a result exists, else to menu", async () => {
		const running = entry({ stage: "running", result: "уже есть" });
		const runningNoResult = entry({ key: "1:11", messageId: 11, stage: "running" });
		const { store } = await makeStore(JSON.stringify({ version: 1, entries: [running, runningNoResult] }));
		expect(store.get(1, 10)?.stage).toBe("preview");
		expect(store.get(1, 11)?.stage).toBe("menu");
	});

	it("drops broken entries instead of failing the whole load", async () => {
		const good = entry();
		const noMsg = entry({ key: "1:12", messageId: 12, msg: undefined as unknown as TelegramBot.Message });
		const badIds = entry({ key: "abc", chatId: "x" as unknown as number });
		const wrongVersion = JSON.stringify({ version: 2, entries: [good] });
		const { store: v2 } = await makeStore(wrongVersion);
		expect(v2.size()).toBe(0);

		const { store } = await makeStore(JSON.stringify({ version: 1, entries: [good, noMsg, badIds] }));
		expect(store.size()).toBe(1);
		expect(store.get(1, 10)).toBeDefined();
	});

	it("corrupt JSON starts clean", async () => {
		const { store } = await makeStore("{not json");
		expect(store.size()).toBe(0);
	});

	it("coerces non-string thoughts out and repairs invalid stages", async () => {
		const dirty = entry({
			stage: "nonsense" as InteractiveStage,
			thoughts: ["ok", 42 as unknown as string],
			page: Number.NaN,
		});
		const { store } = await makeStore(JSON.stringify({ version: 1, entries: [dirty] }));
		const restored = store.get(1, 10)!;
		expect(restored.stage).toBe("menu");
		expect(restored.thoughts).toEqual(["ok"]);
		expect(restored.page).toBeUndefined();
	});
});

describe("serialization safety", () => {
	it("stores a message with runtime props and cycles without throwing", async () => {
		const { store, storage } = await makeStore();
		const live = msg(1, 10) as TelegramBot.Message & { mediaMessages: unknown };
		live.mediaMessages = [live]; // cycle through a runtime prop
		store.create(live);
		await store.flush();
		expect(storage.data).toContain("привет");
		// The cycle-carrying prop is gone; the payload still parses.
		expect(() => JSON.parse(storage.data!)).not.toThrow();
	});
});

describe("capacity", () => {
	it("evicts the oldest created entry beyond maxEntries", async () => {
		const { store } = await makeStore();
		for (let i = 0; i < 5; i++) store.create(msg(1, i), "menu", undefined);
		// Bump entry 0's updatedAt — it is old by CREATION, and must still be the victim.
		store.patch("1:0", { result: "touched" });
		const small = new InteractiveStore(memoryStorage(), { maxEntries: 3, now: () => 1, saveDebounceMs: 0 });
		await small.init();
		small.create(msg(1, 1));
		small.create(msg(1, 2));
		small.create(msg(1, 3));
		small.create(msg(1, 4));
		expect(small.size()).toBe(3);
		expect(small.get(1, 1)).toBeUndefined(); // oldest created, despite the patch
		expect(small.get(1, 4)).toBeDefined();
	});
});
