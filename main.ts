// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import { spawn } from "child_process";
import {
	type App,
	Modal,
	Plugin,
	MarkdownView,
	FuzzySuggestModal,
	type TFile,
} from "obsidian";

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

interface NeovimIncludeConfig {
	update: boolean;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

const REFRESHED_TIMES: Map<string, number> = new Map();
const FILE_START_FLAG = "%% START CODE:";
const FILE_END_FLAG = "%% END CODE %%";

const NEOVIM_START_FLAG = "%% INCLUDE NEOVIM:";

function extensionToFiletype(extension: string) {
	if (extension === "ml") {
		return "ocaml";
	}

	return extension;
}

function captureStderr(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args);

		let stderr = "";

		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code !== 0) {
				reject(`Command failed with exit code ${code}: ${stderr}`);
			} else {
				resolve(stderr);
			}
		});

		child.on("error", (err) => {
			reject(`Failed to start command: ${err.message}`);
		});
	});
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// TODO: Would be good to double check all the times on startup, but who cares LUL
		this.registerMarkdownCodeBlockProcessor(
			"neovim",
			async (content, el, _ctx) => {
				el.innerHTML = content;
			},
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				const text = await this.app.vault.read(file);
				const lines: string[] = text.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.includes(FILE_START_FLAG)) {
						const offset = lines.slice(i).indexOf(FILE_END_FLAG)!;

						let name = line
							.substring(FILE_START_FLAG.length, line.length - 3)
							.trim();
						name = name.substring(2, name.length - 2);

						const resolved = this.app.metadataCache.getFirstLinkpathDest(
							name,
							"",
						);
						const last_refreshed = REFRESHED_TIMES.get(name) || 0;
						if (resolved && last_refreshed < resolved.stat.mtime) {
							// Update the refreshed times
							REFRESHED_TIMES.set(name, resolved.stat.mtime);

							const contents = await this.app.vault.read(resolved);
							const new_lines = [
								"```" + extensionToFiletype(resolved.extension),
								contents.trim(),
								"```",
								FILE_END_FLAG,
							];
							lines.splice(i + 1, offset, ...new_lines);
							this.app.vault.modify(file, lines.join("\n"));
						}
					}
				}
			}),
		);

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "add-code-include",
			name: "Add a CODE INCLUDE block",
			callback: () => {
				//@ts-ignore
				new CodeIncluderModal(this.app).open();
			},
		});

		this.addCommand({
			id: "update-include-neovim-blocks",
			name: "Update INCLUDE NEOVIM blocks",
			callback: () => {
				this.updateNeovimHighlightBlocksCommand();
			},
		});

		this.addCommand({
			id: "create-include-neovim-block",
			name: "Create INCLUDE NEOVIM block",
			callback: () => {
				createNeovimHighlightBlock(this);
			},
		});

		this.addCommand({
			id: "generate-include-neovim-block",
			name: "Generate a new INCLUDE NEOVIM block with new file",
			callback: () => {
				this.generateNewNeovimHighlightBlock({ update: true });
			},
		});

		this.addCommand({
			id: "generate-include-neovim-block-no-update",
			name: "Generate a new, no-update INCLUDE NEOVIM block with new file.",
			callback: () => {
				this.generateNewNeovimHighlightBlock({ update: false });
			},
		});

		this.addCommand({
			id: "edit-neovim-block",
			name: "Edit a NEOVIM block",
			callback: () => {
				this.editNeovimHighlightBlockInNeovim();
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		// this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	async generateNewNeovimHighlightBlock(config: NeovimIncludeConfig) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const position = view?.editor.getCursor();

		console.log("generate start:", view, position);
		if (!view || !position) {
			return;
		}

		const input = new TextModal(this.app, async (extension: string) => {
			if (!position || extension === "") {
				return;
			}

			const now = Date.now();
			const newFileName = `${now}.${extension}`;
			await this.app.vault.create(`_/code/${newFileName}`, "");

			const newLines = [
				`${NEOVIM_START_FLAG} ${newFileName} ${JSON.stringify(config)} %%`,
				"```neovim",
				"```",
				`^${now}`,
			];

			view.editor!.setLine(position.line, newLines.join("\n"));
			view.editor!.setCursor(position);

			await this.editNeovimHighlightBlockInNeovim();
		});

		input.open();
	}

	getNeovimFile(line: string): TFile | null {
		const remaining = line
			.substring(NEOVIM_START_FLAG.length, line.length)
			.trim();

		const name = remaining.split(/\s+/)[0].trim();
		return this.app.metadataCache.getFirstLinkpathDest(name, "");
	}

	getNeovimConfig(line: string): NeovimIncludeConfig {
		const remaining = line
			.substring(NEOVIM_START_FLAG.length, line.length)
			.trim();

		try {
			return JSON.parse(remaining.split(/\s+/).slice(1, -1).join(" "));
		} catch {
			return { update: true };
		}
	}

	fileToPath(file: TFile): string {
		//@ts-ignore
		const basePath = this.app.vault.adapter.basePath;
		return `${basePath}/${file.path}`;
	}

	async updateNeovimHighlightBlocksCommand() {
		// get current file:
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			return;
		}

		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			await this.updateNeovimHighlightBlock(file, i, lines);
		}
	}

	async updateNeovimHighlightBlock(
		file: TFile,
		i: number,
		lines: string[],
	): Promise<number> {
		const line = lines[i];
		if (!line.includes(NEOVIM_START_FLAG)) {
			return i;
		}
		console.log("Starting neovim highlight");

		let offset = 0;
		if (lines[i + 1] !== "```neovim") {
			offset = 0;
		} else {
			offset = lines.slice(i - 1).indexOf("```")!;
		}

		const resolved = this.getNeovimFile(line);
		if (!resolved) {
			console.log("Could not find file", line);
			return i;
		}

		const config = this.getNeovimConfig(line);
		if (!config.update) {
			console.log("Not updating due to config:", line);
			return i;
		}

		const absolutePath = this.fileToPath(resolved);
		const output = await captureStderr("nvim", [
			"--headless",
			"-c",
			`RunObsidian ${absolutePath}`,
			"-c",
			"q",
		]);

		let outputLines = output.split("\n");
		console.log("output", outputLines);

		let outputNeovim = "";

		let recording = false;
		for (const line of outputLines) {
			if (line === "```neovim") {
				recording = true;
			} else if (line.startsWith("```")) {
				outputNeovim += "```\n";
				break;
			}

			if (recording) {
				outputNeovim += line + "\n";
			}
		}

		console.log("neovim", outputNeovim);

		const new_lines = [outputNeovim.trim()];
		lines.splice(i + 1, offset - 1, ...new_lines);
		this.app.vault.modify(file, lines.join("\n"));

		console.log("Finished neovim highlight", i);
		return i + new_lines.length;
	}

	async editNeovimHighlightBlockInNeovim() {
		// throw new Error('Method not implemented.');
		console.log("edit neovim");

		let editor = this.app.workspace.activeEditor?.editor!;
		let cursor = editor.getCursor();
		let line = editor.getLine(cursor.line);

		const file = this.getNeovimFile(line);
		if (!file) {
			console.log("Could not find file:", line);
			return;
		}

		let absolutePath = this.fileToPath(file);

		// TODO: Later it would be cool to add an option to our INCLUDE expression to mention
		// that we generated highlights from interactive Neovim (so that we don't override them
		// later when we do the INCLUDE plugin normally).
		console.log("opening neovim", absolutePath);
		await captureStderr("ghostty", [
			"-e",
			"nvim",
			"-c",
			`"EditObsidian ${absolutePath}"`,
		]);

		let activeFile = this.app.workspace.getActiveFile()!;
		let activeFileContents = await this.app.vault.read(activeFile);
		this.updateNeovimHighlightBlock(
			activeFile,
			cursor.line,
			activeFileContents.split("\n"),
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CodeIncluderModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles();
	}
	/**
	 * @public
	 */
	getItemText(item: TFile): string {
		return item.name;
	}
	/**
	 * @public
	 */
	onChooseItem(item: TFile, _evt: MouseEvent | KeyboardEvent): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		view?.editor.replaceSelection(
			[FILE_START_FLAG + " [[" + item.path + "]] %%", FILE_END_FLAG].join("\n"),
		);
	}
}

async function createNeovimHighlightBlock(plugin: MyPlugin) {
	new NeovimIncludeModal(plugin.app).open();
}

class TextModal extends Modal {
	inputValue: string;
	customSubmit: (value: string) => Promise<void>;

	constructor(app: App, submit: (value: string) => Promise<void>) {
		super(app);
		this.customSubmit = submit;
		this.inputValue = "";
	}

	onOpen(): void {
		let { contentEl } = this;
		contentEl.createEl("h2", { text: "Enter file extension" });

		let input = contentEl.createEl("input", { type: "text" });
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();

				this.inputValue = input.value;
				this.close();
			}
		});
	}

	onClose(): void {
		this.customSubmit(this.inputValue);
	}
}

class NeovimIncludeModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((file) => file.extension !== "md");
	}

	/**
	 * @public
	 */
	getItemText(item: TFile): string {
		return item.name;
	}

	/**
	 * @public
	 */
	onChooseItem(item: TFile, _evt: MouseEvent | KeyboardEvent): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		view?.editor.replaceSelection(
			[FILE_START_FLAG + " [[" + item.path + "]] %%", FILE_END_FLAG].join("\n"),
		);
	}
}
