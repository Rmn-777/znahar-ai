import { Modal, Setting } from "obsidian";
import TelegramSyncPlugin from "src/main";
import { t } from "src/locale/i18n";
import { allActions, type CatalogAction } from "src/interactive/catalog";

/**
 * Per-action settings of the interactive flow: for every catalog action an
 * «включено» toggle, a «в быстром наборе» toggle and a prompt editor whose empty
 * text falls back to the builtin prompt. Overrides live in
 * settings.interactiveActionOverrides[id] — absent keys mean defaults, so the
 * modal writes only what the user actually changed.
 */
export class InteractiveActionsModal extends Modal {
	private plugin: TelegramSyncPlugin;
	private onUpdate: () => void;
	/** Which action's prompt editor is expanded, if any. */
	private expandedPrompt: string | null = null;

	constructor(plugin: TelegramSyncPlugin, onUpdate?: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onUpdate = onUpdate || (() => {});
	}

	onOpen() {
		this.modalEl.addClass("tgai-modal");
		this.titleEl.setText(t("settings.interactive.actions.title"));
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: t("settings.interactive.actions.intro"), cls: "setting-item-description" });

		for (const action of allActions()) {
			contentEl.appendChild(this.actionBlock(action));
		}
	}

	private actionBlock(action: CatalogAction): HTMLElement {
		const override = this.plugin.settings.interactiveActionOverrides[action.id] ?? {};
		const container = createDiv();

		new Setting(container)
			.setName(`${action.icon} ${t(`interactive.actions.${action.id}`)}`)
			.addToggle((toggle) =>
				toggle
					.setTooltip(t("settings.interactive.actions.enabled"))
					.setValue(override.enabled ?? action.defaultEnabled)
					.onChange((value) => {
						this.writeOverride(action.id, { enabled: value });
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip(t("settings.interactive.actions.quick"))
					.setValue(override.quick ?? action.defaultQuick)
					.onChange((value) => {
						this.writeOverride(action.id, { quick: value });
					}),
			)
			.addButton((button) =>
				button
					.setIcon("file-pen")
					.setTooltip(t("settings.interactive.actions.prompt"))
					.onClick(() => {
						this.expandedPrompt = this.expandedPrompt === action.id ? null : action.id;
						this.render();
					}),
			);

		if (this.expandedPrompt === action.id) {
			const custom = (override.prompt ?? "").trim();
			const editor = new Setting(container)
				.setName(t("settings.interactive.actions.promptEditor"))
				.setClass("tgai-prompt-editor");
			editor.addTextArea((area) => {
				area.setValue(custom || action.prompt).onChange((value) => {
					// Empty means "use the builtin": overrides store only real edits.
					this.writeOverride(action.id, { prompt: value.trim() === action.prompt ? "" : value });
				});
				area.inputEl.rows = 6;
			});
			const note = container.createDiv({ cls: "setting-item-description" });
			note.setText(
				custom
					? t("settings.interactive.actions.promptCustom")
					: t("settings.interactive.actions.promptBuiltin"),
			);
		}

		return container;
	}

	private writeOverride(id: string, patch: { enabled?: boolean; quick?: boolean; prompt?: string }): void {
		const overrides = this.plugin.settings.interactiveActionOverrides;
		const current = overrides[id] ?? {};
		overrides[id] = { ...current, ...patch };
		void this.plugin.saveSettings();
		this.onUpdate();
	}
}
