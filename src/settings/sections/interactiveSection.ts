import TelegramSyncPlugin from "src/main";
import { Setting } from "obsidian";
import { t } from "src/locale/i18n";
import { InteractiveActionsModal } from "../modals/InteractiveActionsModal";
import { interactiveMenuAvailable } from "src/interactive/flow";
import { writeSecret } from "src/utils/secretStore";

/**
 * Interactive flow settings section UI.
 *
 * The flow works only with a usable AI behind it: without a provider the messages go
 * straight to the inbox (by design), so the section says which of the two states the
 * install is in rather than showing toggles that would do nothing.
 */
export function addInteractiveSettings(containerEl: HTMLElement, plugin: TelegramSyncPlugin, update: () => void): void {
	new Setting(containerEl)
		.setName(t("settings.interactive.enable"))
		.setDesc(t("settings.interactive.enable.desc"))
		.addToggle((toggle) => {
			toggle.setValue(!plugin.settings.interactiveDisabled).onChange((value) => {
				void (async () => {
					plugin.settings.interactiveDisabled = !value;
					await plugin.saveSettings();
					update();
				})();
			});
		});

	if (plugin.settings.interactiveDisabled) return;

	if (!interactiveMenuAvailable(plugin)) {
		new Setting(containerEl)
			.setName(t("settings.interactive.noAI"))
			.setDesc(t("settings.interactive.noAI.desc"))
			.setClass("tgai-api-note");
		return;
	}

	new Setting(containerEl)
		.setName(t("settings.interactive.inboxFolder"))
		.setDesc(t("settings.interactive.inboxFolder.desc"))
		.addText((text) => {
			text.setValue(plugin.settings.interactiveInboxFolder).onChange((value) => {
				void (async () => {
					plugin.settings.interactiveInboxFolder = value;
					await plugin.saveSettings();
				})();
			});
		});

	new Setting(containerEl)
		.setName(t("settings.interactive.attachments"))
		.setDesc(t("settings.interactive.attachments.desc"))
		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.interactiveSaveAttachments).onChange((value) => {
				void (async () => {
					plugin.settings.interactiveSaveAttachments = value;
					await plugin.saveSettings();
				})();
			});
		});

	new Setting(containerEl)
		.setName(t("settings.interactive.actions"))
		.setDesc(t("settings.interactive.actions.desc"))
		.addButton((button) => {
			button
				.setButtonText(t("settings.interactive.actions.configure"))
				.setCta()
				.onClick(() => {
					new InteractiveActionsModal(plugin, update).open();
				});
		});

	new Setting(containerEl)
		.setName(t("settings.max.enable"))
		.setDesc(t("settings.max.enable.desc"))
		.addToggle((toggle) => {
			toggle.setValue(plugin.settings.maxEnabled).onChange((value) => {
				void (async () => {
					plugin.settings.maxEnabled = value;
					await plugin.saveSettings();
					update();
				})();
			});
		});

	new Setting(containerEl)
		.setName(t("settings.max.token"))
		.setDesc(t("settings.max.token.desc"))
		.addText((text) => {
			text.setValue(plugin.settings.maxToken).onChange((value) => {
				void (async () => {
					writeSecret(plugin, "maxToken", value);
					await plugin.saveSettings();
				})();
			});
		});
}
