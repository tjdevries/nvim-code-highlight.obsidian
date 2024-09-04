// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import { spawn } from "child_process";
import { type App, Modal, Plugin, MarkdownView, type TFile } from "obsidian";

// biome-ignore lint/suspicious/noEmptyInterface: <explanation>
interface NeovimHighlightSettings {}

interface NeovimFileConfig {
	path: string;
	update: boolean;
	timestamp: number;
}

const DEFAULT_SETTINGS: NeovimHighlightSettings = {};

// TODO: Once we've migrated all my files, can probably delete this section,
// but it's OK to leave for now. The new way is better.
const NEOVIM_START_FLAG = "%% INCLUDE NEOVIM:";

function filetypeToExtension(filetype: string) {
	switch (filetype) {
		case "ocaml":
			return "ml";
		case "html":
			return "html";
		case "css":
			return "css";
		case "javascript":
			return "js";
		case "typescript":
			return "ts";
		case "markdown":
			return "md";
		case "latex":
			return "tex";
	}

	return filetype;
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

export default class NeovimHighlighter extends Plugin {
	settings: NeovimHighlightSettings;

	async onload() {
		await this.loadSettings();

		// All `neovim` code blocks are actually just HTML :omegalul:
		this.registerMarkdownCodeBlockProcessor(
			"neovim",
			async (content, el, _ctx) => {
				el.innerHTML = content;
			},
		);

		this.addCommand({
			id: "update-include-neovim-blocks",
			name: "Update Neovim Code Blocks",
			callback: () => {
				this.updateNeovimHighlights();
			},
		});

		this.addCommand({
			id: "generate-include-neovim-block",
			name: "Generate Neovim Code Block",
			callback: () => {
				this.generateNewNeovimHighlightBlock(true);
			},
		});

		this.addCommand({
			id: "generate-include-neovim-block-no-update",
			name: "Generate Neovim Code Block (no update)",
			callback: () => {
				this.generateNewNeovimHighlightBlock(false);
			},
		});

		this.addCommand({
			id: "edit-neovim-block",
			name: "Edit a Neovim Code block",
			callback: () => {
				this.editNeovimHighlightBlockInNeovim();
			},
		});

		this.addCommand({
			id: "transform-to-neovim-blocks",
			name: "Transform All Code Blocks to Neovim Code Blocks",
			callback: () => {
				this.transformAllCodeBlocksToNeovimBlocks();
			},
		});
	}

	async transformAllCodeBlocksToNeovimBlocks() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			return;
		}

		const contents = await this.app.vault.read(file);
		const lines: string[] = contents.split("\n");

		const activeFile = this.app.workspace.getActiveFile()!;
		const fileCache = this.app.metadataCache.getFileCache(activeFile)!;

		const sections = fileCache.sections!;
		const toTransform = [];
		for (const s of sections) {
			if (s.type === "code") {
				const first_line = lines[s.position.start.line];
				if (first_line.includes("neovim")) {
					continue;
				}

				toTransform.push(s);
			}
		}

		// Go back to front so we can modify lines
		toTransform.reverse();

		let i = 0;
		for (const s of toTransform) {
			const first_line = lines[s.position.start.line];
			const extension = filetypeToExtension(
				first_line.slice(first_line.indexOf("```") + 3).trim(),
			);

			const blockContents = lines
				.slice(s.position.start.line + 1, s.position.end.line)
				.join("\n");

			const now = `${Date.now()}${i}`;
			const newFileName = `${now}.${extension}`;
			const newFilePath = `_/code/${newFileName}`;
			await this.app.vault.create(newFilePath, blockContents);

			const config: NeovimFileConfig = {
				update: true,
				path: newFilePath,
				timestamp: Date.now(),
			};
			const newLines = this.getNeovimBlockLines(now, config);

			// Replace the lines
			lines.splice(
				s.position.start.line,
				s.position.end.line - s.position.start.line + 1,
				...newLines,
			);

			i += 1;
		}

		this.app.vault.modify(file, lines.join("\n"));
		await this.updateNeovimHighlights();
	}

	async generateNewNeovimHighlightBlock(update: boolean) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const position = view?.editor.getCursor();

		console.log("generate start:", view, position);
		if (!view || !position) {
			return;
		}

		const input = new NewCodeFileModal(this.app, async (extension: string) => {
			if (!position || extension === "") {
				return;
			}

			const now = `${Date.now()}`;
			const newFileName = `${now}.${extension}`;
			const newFilePath = `_/code/${newFileName}`;
			await this.app.vault.create(newFilePath, "");

			const config = { update, path: newFilePath, timestamp: Date.now() };
			const newLines = this.getNeovimBlockLines(now, config);

			view.editor!.setLine(position.line, newLines.join("\n"));
			view.editor!.setCursor(position);

			await this.editNeovimHighlightBlockInNeovim();
		});

		input.open();
	}

	getNeovimBlockLines(id: string, config: NeovimFileConfig): string[] {
		return ["```neovim " + JSON.stringify(config), "```", `^${id}`];
	}

	getNeovimFile(line: string): TFile | null {
		const remaining = line
			.substring(NEOVIM_START_FLAG.length, line.length)
			.trim();

		const name = remaining.split(/\s+/)[0].trim();
		return this.app.metadataCache.getFirstLinkpathDest(name, "");
	}

	getNeovimConfig(line: string): NeovimFileConfig {
		const remaining = line
			.substring(NEOVIM_START_FLAG.length, line.length)
			.trim();

		try {
			return JSON.parse(remaining.split(/\s+/).slice(1, -1).join(" "));
		} catch {
			try {
				const neovimRemaining = line.split("```neovim")[1];
				return JSON.parse(neovimRemaining);
			} catch {
				return { update: true, path: "", timestamp: 0 };
			}
		}
	}

	fileToPath(file: TFile): string {
		//@ts-ignore
		const basePath = this.app.vault.adapter.basePath;
		return `${basePath}/${file.path}`;
	}

	async updateNeovimHighlights(force = false) {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			return;
		}

		const fileCache = this.app.metadataCache.getFileCache(file)!;

		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");

		const sections = fileCache.sections!;
		const toTransform = [];
		for (const s of sections) {
			if (s.type === "code") {
				const first_line = lines[s.position.start.line];
				if (!first_line.includes("neovim")) {
					continue;
				}

				toTransform.push(s);
			}
		}

		// Go back to front so we can modify lines
		toTransform.reverse();

		for (const s of toTransform) {
			const first_line = lines[s.position.start.line];
			const config = this.getNeovimConfig(first_line);

			const possibleStartFlag = s.position.start.line - 1;
			let startOffset = 0;
			if (lines[possibleStartFlag].includes(NEOVIM_START_FLAG)) {
				startOffset += 1;

				if (config.path === "") {
					config.path = this.getNeovimFile(lines[possibleStartFlag])!.path;
				}
			}

			const path = config.path;
			if (!path) {
				console.log("Could not find file", config, first_line, s.position);
				continue;
			}

			if (!config.update) {
				console.log("Not updating due to config:", first_line);
				continue;
			}

			const f = this.app.vault.getAbstractFileByPath(config.path) as TFile;
			if (!force && config.timestamp > f.stat.mtime) {
				console.log("Not updating due to timestamp:", config, f.stat);
				continue;
			}

			// Update the time
			config.timestamp = Date.now();
			console.log("updating:", first_line, config);

			const resolved = this.app.vault.getAbstractFileByPath(path) as TFile;
			const absolutePath = this.fileToPath(resolved);
			const output = await captureStderr("nvim", [
				"--headless",
				"-c",
				`RunObsidian ${absolutePath}`,
				"-c",
				"q",
			]);

			let outputLines = output.split("\n");

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

			// console.log("neovim", outputNeovim);

			const new_lines = outputNeovim.trim().split("\n");
			new_lines[0] += ` ${JSON.stringify(config)}`;
			lines.splice(
				s.position.start.line - startOffset,
				s.position.end.line - s.position.start.line + 1 + startOffset,
				...new_lines,
			);
		}

		this.app.vault.modify(file, lines.join("\n"));
	}

	async editNeovimHighlightBlockInNeovim() {
		console.log("edit neovim");

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			return;
		}

		let editor = this.app.workspace.activeEditor?.editor!;
		let cursor = editor.getCursor();

		const fileCache = this.app.metadataCache.getFileCache(file)!;
		const sections = fileCache.sections!;
		for (const s of sections) {
			if (
				s.position.start.line <= cursor.line &&
				s.position.end.line >= cursor.line
			) {
				const first_line = editor.getLine(s.position.start.line);
				const config = this.getNeovimConfig(first_line);
				console.log("config", config);
				const resolved = this.app.vault.getAbstractFileByPath(
					config.path!,
				) as TFile;

				let absolutePath = this.fileToPath(resolved);

				await captureStderr("ghostty", [
					"-e",
					"nvim",
					"-c",
					`"EditObsidian ${absolutePath}"`,
				]);

				this.updateNeovimHighlights();

				return;
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {}
}

class NewCodeFileModal extends Modal {
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
