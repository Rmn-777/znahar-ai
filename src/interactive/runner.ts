/**
 * Runs one catalog action (or a custom command) against prepared source material.
 *
 * The prompt is the action's own — builtin, or the user's settings override, or the
 * free-form text typed after «Своя команда» — wrapped the same way the automatic
 * pipeline wraps its content-type prompts: injection guard first, output-language
 * instruction last. The provider call routes photos through Vision and everything
 * else through plain completion, mirroring processWithAI's split.
 *
 * Deliberately NOT reusing processWithAI: that one selects prompts by content type,
 * while the interactive flow selects them by the user's chosen action.
 */

import TelegramBot from "src/telegram/botApi";
import TelegramSyncPlugin from "src/main";
import { withInjectionGuard } from "src/ai/processor";
import { withOutputLanguage } from "src/ai/outputLanguage";
import { getActiveProvider } from "src/ai/providers";
import type { CatalogAction } from "./catalog";
import { effectivePrompt } from "./catalog";
import type { PreparedSource } from "./types";

/** The action produced nothing the user could confirm. */
export class ActionRunError extends Error {
	readonly localeKey: string;

	constructor(localeKey: string) {
		super(localeKey);
		this.name = "ActionRunError";
		this.localeKey = localeKey;
	}
}

export interface ActionResult {
	text: string;
	/** "provider/model" provenance line for the note's AI section; "none" for no-AI actions. */
	provider: string;
}

/**
 * The prompt for one run. `customPrompt` wins for free-form commands; an empty
 * settings override falls back to the builtin; a no-AI action never gets here.
 */
export function buildActionPrompt(plugin: TelegramSyncPlugin, action: CatalogAction, customPrompt?: string): string {
	const own = customPrompt?.trim() || effectivePrompt(plugin.settings, action);
	return withOutputLanguage(withInjectionGuard(own), plugin);
}

/** Runs an action. Throws ActionRunError with a locale key when the provider returns nothing. */
export async function runAction(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	source: PreparedSource,
	action: CatalogAction,
	customPrompt?: string,
): Promise<ActionResult> {
	const prompt = buildActionPrompt(plugin, action, customPrompt);
	return await runPrompt(plugin, msg, source, prompt, action.noAI === true);
}

/** Runs a free-form command typed after «Своя команда». */
export async function runCustomCommand(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	source: PreparedSource,
	command: string,
): Promise<ActionResult> {
	const trimmed = command.trim();
	if (!trimmed) throw new ActionRunError("interactive.run.emptyCommand");
	const prompt = withOutputLanguage(withInjectionGuard(trimmed), plugin);
	return await runPrompt(plugin, msg, source, prompt, false);
}

async function runPrompt(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	source: PreparedSource,
	prompt: string,
	noAI: boolean,
): Promise<ActionResult> {
	if (noAI) {
		// «Сохранить как есть»: the result IS the source; nothing leaves the device.
		return { text: source.sourceText, provider: "none" };
	}

	const provider = getActiveProvider(plugin);
	const content = source.aiText || (source.contentType === "photo" ? "Analyze this image" : "");
	if (!content.trim()) throw new ActionRunError("interactive.run.emptySource");

	const output =
		source.contentType === "photo"
			? // processWithVision falls back to a text-only request when the image cannot be
				// fetched, so no capability pre-check here — a describable caption beats an error.
				await provider.processWithVision(plugin, content, prompt, msg)
			: await provider.process(plugin, content, prompt, msg);

	if (!output?.trim()) throw new ActionRunError("interactive.run.failed");
	return { text: output.trim(), provider: `${provider.id}/${provider.getModel(plugin)}` };
}
