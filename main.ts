import { App, Editor, FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { resolve } from 'path';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

const REFRESHED_TIMES: Map<string, number> = new Map();
const FILE_START_FLAG = "%% START CODE:";
const FILE_END_FLAG = "%% END CODE %%";

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// TODO: Would be good to double check all the times on startup, but who cares LUL

		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				const text = await this.app.vault.cachedRead(file);
				const lines: string[] = text.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.includes(FILE_START_FLAG)) {
						const offset = lines.slice(i).indexOf(FILE_END_FLAG)!;

						let name = line.substring(FILE_START_FLAG.length, line.length - 3).trim();
						name = name.substring(2, name.length - 2);

						const resolved = this.app.metadataCache.getFirstLinkpathDest(name, '');
						const last_refreshed = REFRESHED_TIMES.get(name) || 0;
						if (resolved && last_refreshed < resolved.stat.mtime) {
							// Update the refreshed times
							REFRESHED_TIMES.set(name, resolved.stat.mtime);

							let contents = await this.app.vault.cachedRead(resolved);
							const new_lines = [
								"```" + resolved.extension,
								contents.trim(),
								"```",
								FILE_END_FLAG
							];
							lines.splice(i + 1, offset, ...new_lines);
							this.app.vault.modify(file, lines.join("\n"));
						}
					}
				}
			})
		);

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'add-code-include',
			name: 'Add a CODE INCLUDE block',
			callback: () => {
				new CodeIncluderModal(this.app).open();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		// this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() { }

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CodeIncluderModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles()
	}
	/**
	 * @public
	 */
	getItemText(item: TFile): string { return item.name }
	/**
	 * @public
	 */
	onChooseItem(item: TFile, _evt: MouseEvent | KeyboardEvent): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		view?.editor.replaceSelection([FILE_START_FLAG + " [[" + item.path + "]] %%", FILE_END_FLAG].join("\n"));
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
