// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { type FSWatcher, watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BoxRenderable, InputRenderable, InputRenderableEvents, type KeyEvent, TextRenderable } from "@opentui/core";

import { fmt } from "../../src/shared/escape.js";
import { RGBA_THEME, THEME } from "./theme.js";

export interface CatalogGame {
	id?: string;
	slug: string;
	title: string;
	description: string;
	poster?: string;
	posterAlt?: string;
	theme?: {
		accent?: string;
		"accent-soft"?: string;
		night?: string;
		panel?: string;
		"panel-2"?: string;
		line?: string;
	};
	stats?: { value: number; label: string }[];
	tagLabel?: string;
	defaultTag?: string | null;
}

export interface GamesCatalogOptions {
	renderer: any;
	width: number;
	height: number;
	indexPath?: string;
	mapsDir?: string;
	onPrune?: (game: CatalogGame) => void;
	onCards?: (game: CatalogGame) => void;
	onNewScrape?: () => void;
	onStatusChange?: (msg: string) => void;
}

export interface GamesCatalogView {
	root: BoxRenderable;
	reload(): Promise<void>;
	handleKey(key: KeyEvent): boolean;
	resize(width: number, height: number): void;
	focus(): void;
	blur(): void;
	isModalOpen(): boolean;
	destroy(): void;
}

export async function createGamesCatalogView(opts: GamesCatalogOptions): Promise<GamesCatalogView> {
	const renderer = opts.renderer;
	const indexPath = opts.indexPath || "./public/maps/index.json";
	const mapsDir = opts.mapsDir || "./public/maps";

	let boxW = opts.width;
	let boxH = opts.height;

	let allGames: CatalogGame[] = [];
	let displayedGames: CatalogGame[] = [];
	let selectedIdx = 0;
	let scrollRow = 0;
	let toastMessage = "";
	let toastTimer: any = null;

	// Modal states: null | "edit" | "delete" | "search"
	let modalState: "edit" | "delete" | "search" | null = null;
	let searchQuery = "";

	const rootBox = new BoxRenderable(renderer, {
		width: boxW,
		height: boxH,
		flexDirection: "column",
		paddingX: 1,
		paddingY: 0,
		backgroundColor: THEME.bgDark,
	});

	// Top Sub-Header: Search query / Filter status / Toast
	const topBar = new BoxRenderable(renderer, {
		flexDirection: "row",
		justifyContent: "space-between",
		width: boxW - 2,
		marginVertical: 0,
	});
	const catalogStatsText = new TextRenderable(renderer, {
		content: "Games: loading...",
		fg: THEME.textDim,
	});
	const toastText = new TextRenderable(renderer, {
		content: "",
		fg: THEME.green,
	});
	topBar.add(catalogStatsText);
	topBar.add(toastText);
	rootBox.add(topBar);

	// Grid container
	const gridBox = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
		gap: 0,
		marginVertical: 0,
	});
	rootBox.add(gridBox);

	// Modal Overlay Box (used for Edit, Delete Confirm, Search)
	const modalOverlay = new BoxRenderable(renderer, {
		width: Math.min(boxW - 4, 80),
		border: true,
		borderColor: RGBA_THEME.borderFocus,
		backgroundColor: THEME.surface,
		flexDirection: "column",
		paddingX: 2,
		paddingY: 1,
		position: "absolute",
		top: 3,
		left: Math.max(1, Math.floor((boxW - Math.min(boxW - 4, 80)) / 2)),
	});
	const modalTitle = new TextRenderable(renderer, {
		content: "",
		fg: THEME.peach,
	});
	modalOverlay.add(modalTitle);

	// Edit Inputs
	const editBox = new BoxRenderable(renderer, {
		flexDirection: "column",
		gap: 0,
		marginVertical: 1,
	});
	const titleLabel = new TextRenderable(renderer, { content: "Title:", fg: THEME.peach });
	const titleInput = new InputRenderable(renderer, {
		width: 70,
		backgroundColor: THEME.bgDark,
		focusedBackgroundColor: THEME.surfaceLight,
		textColor: THEME.textBright,
	});
	const descLabel = new TextRenderable(renderer, { content: "Description:", fg: THEME.peach });
	const descInput = new InputRenderable(renderer, {
		width: 70,
		backgroundColor: THEME.bgDark,
		focusedBackgroundColor: THEME.surfaceLight,
		textColor: THEME.textBright,
	});
	const accentLabel = new TextRenderable(renderer, { content: "Theme Accent Hex (e.g. #a8332b):", fg: THEME.peach });
	const accentInput = new InputRenderable(renderer, {
		width: 70,
		backgroundColor: THEME.bgDark,
		focusedBackgroundColor: THEME.surfaceLight,
		textColor: THEME.textBright,
	});
	const tagLabel = new TextRenderable(renderer, {
		content: "Tag Label (e.g. Difficulty or Filter):",
		fg: THEME.peach,
	});
	const tagLabelInput = new InputRenderable(renderer, {
		width: 70,
		backgroundColor: THEME.bgDark,
		focusedBackgroundColor: THEME.surfaceLight,
		textColor: THEME.textBright,
	});
	const defaultTagLabel = new TextRenderable(renderer, { content: "Default Tag (e.g. Standard):", fg: THEME.peach });
	const defaultTagInput = new InputRenderable(renderer, {
		width: 70,
		backgroundColor: THEME.bgDark,
		focusedBackgroundColor: THEME.surfaceLight,
		textColor: THEME.textBright,
	});

	editBox.add(titleLabel);
	editBox.add(titleInput);
	editBox.add(descLabel);
	editBox.add(descInput);
	editBox.add(accentLabel);
	editBox.add(accentInput);
	editBox.add(tagLabel);
	editBox.add(tagLabelInput);
	editBox.add(defaultTagLabel);
	editBox.add(defaultTagInput);
	modalOverlay.add(editBox);

	const editInputs = [titleInput, descInput, accentInput, tagLabelInput, defaultTagInput];
	let editFocusIdx = 0;

	// Delete confirm message
	const deleteMsg = new TextRenderable(renderer, {
		content: "Are you sure you want to delete this game? [Y/N]",
		fg: THEME.yellow,
	});
	modalOverlay.add(deleteMsg);

	// Search Input Box
	const searchBox = new BoxRenderable(renderer, {
		flexDirection: "column",
		marginVertical: 1,
	});
	const searchLabel = new TextRenderable(renderer, { content: "Filter games by title or slug:", fg: THEME.teal });
	const searchInput = new InputRenderable(renderer, {
		width: 70,
		backgroundColor: THEME.bgDark,
		focusedBackgroundColor: THEME.surfaceLight,
		textColor: THEME.textBright,
	});
	searchBox.add(searchLabel);
	searchBox.add(searchInput);
	modalOverlay.add(searchBox);

	// Modal footer hint
	const modalHint = new TextRenderable(renderer, {
		content: "[Enter] Confirm   [Esc] Cancel",
		fg: THEME.teal,
	});
	modalOverlay.add(modalHint);

	function showToast(msg: string) {
		toastMessage = msg;
		toastText.content = msg;
		opts.onStatusChange?.(msg);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toastMessage = "";
			toastText.content = "";
			renderer.requestRender();
		}, 4000);
		renderer.requestRender();
	}

	async function loadIndexData() {
		try {
			const raw = await readFile(indexPath, "utf8");
			const parsed = JSON.parse(raw);
			allGames = Array.isArray(parsed.games) ? parsed.games : [];
			applySearchFilter();
		} catch (e: any) {
			catalogStatsText.content = `Error reading index.json: ${e.message}`;
		}
	}

	let isSelfWriting = false;

	function applySearchFilter() {
		const currentSelectedSlug = displayedGames[selectedIdx]?.slug;
		if (!searchQuery.trim()) {
			displayedGames = [...allGames];
		} else {
			const q = searchQuery.trim().toLowerCase();
			displayedGames = allGames.filter(
				(g) => g.title.toLowerCase().includes(q) || g.slug.toLowerCase().includes(q),
			);
		}
		if (currentSelectedSlug) {
			const foundIdx = displayedGames.findIndex((g) => g.slug === currentSelectedSlug);
			if (foundIdx >= 0) {
				selectedIdx = foundIdx;
			}
		}
		if (selectedIdx >= displayedGames.length) {
			selectedIdx = Math.max(0, displayedGames.length - 1);
		}
		renderGrid();
	}

	async function saveIndexData() {
		try {
			isSelfWriting = true;
			const data = { games: allGames };
			await writeFile(indexPath, JSON.stringify(data, null, "\t") + "\n", "utf8");
		} catch (e: any) {
			showToast(`Error saving index.json: ${e.message}`);
		} finally {
			setTimeout(() => {
				isSelfWriting = false;
			}, 300);
		}
	}

	// Dynamic pool of cards
	interface CardElement {
		box: BoxRenderable;
		titleText: TextRenderable;
		slugText: TextRenderable;
		statsText: TextRenderable;
		descText: TextRenderable;
		tagText: TextRenderable;
	}

	let cardPool: CardElement[] = [];
	let rowPool: BoxRenderable[] = [];

	function renderGrid() {
		const total = displayedGames.length;
		const totalAll = allGames.length;
		const filterNotice = searchQuery ? ` (Filtered: "${searchQuery}")` : "";
		catalogStatsText.content = `Catalog: ${fmt(totalAll)} games${filterNotice} • Selected: #${selectedIdx + 1} (${displayedGames[selectedIdx]?.title || "none"})`;

		// 4 cards per row
		const cols = 4;
		const cardW = Math.max(16, Math.floor((boxW - 6) / cols));
		const cardH = 7;
		const availH = Math.max(cardH, boxH - 5);
		const visibleRows = Math.max(1, Math.floor(availH / cardH));
		const totalRows = Math.ceil(total / cols);

		// Clamp scrolling
		const selRow = Math.floor(selectedIdx / cols);
		if (selRow < scrollRow) scrollRow = selRow;
		if (selRow >= scrollRow + visibleRows) scrollRow = selRow - visibleRows + 1;
		scrollRow = Math.max(0, Math.min(Math.max(0, totalRows - visibleRows), scrollRow));

		// Rebuild rows in gridBox
		while (rowPool.length < visibleRows) {
			const rowBox = new BoxRenderable(renderer, {
				flexDirection: "row",
				gap: 1,
				width: boxW - 2,
				height: cardH,
			});
			rowPool.push(rowBox);
			gridBox.add(rowBox);
		}
		while (rowPool.length > visibleRows) {
			const r = rowPool.pop()!;
			gridBox.remove(r);
		}

		let cardIdx = 0;
		for (let r = 0; r < visibleRows; r++) {
			const currentRow = rowPool[r];
			currentRow.width = boxW - 2;
			const rowGameStart = (scrollRow + r) * cols;

			for (let c = 0; c < cols; c++) {
				const gameIndex = rowGameStart + c;
				const game = displayedGames[gameIndex];

				let cardElem = cardPool[cardIdx];
				if (!cardElem) {
					const box = new BoxRenderable(renderer, {
						width: cardW,
						height: cardH,
						border: true,
						borderColor: RGBA_THEME.borderDim,
						flexDirection: "column",
						paddingX: 1,
						paddingY: 0,
					});
					const titleText = new TextRenderable(renderer, { content: "", fg: THEME.textBright });
					const slugText = new TextRenderable(renderer, { content: "", fg: THEME.textDim });
					const statsText = new TextRenderable(renderer, { content: "", fg: THEME.peach });
					const descText = new TextRenderable(renderer, { content: "", fg: THEME.textDim });
					const tagText = new TextRenderable(renderer, { content: "", fg: THEME.teal });

					box.add(titleText);
					box.add(slugText);
					box.add(statsText);
					box.add(descText);
					box.add(tagText);

					cardElem = { box, titleText, slugText, statsText, descText, tagText };
					cardPool.push(cardElem);
				}

				if (cardElem.box.parent !== currentRow) {
					if (cardElem.box.parent) cardElem.box.parent.remove(cardElem.box);
					currentRow.add(cardElem.box);
				}

				cardElem.box.width = cardW;
				cardElem.box.height = cardH;

				if (game) {
					const isSelected = gameIndex === selectedIdx;
					cardElem.box.borderColor = isSelected ? RGBA_THEME.borderFocus : RGBA_THEME.borderDim;
					cardElem.box.backgroundColor = isSelected ? THEME.surface : THEME.bgDark;

					const prefix = isSelected ? "▶ " : "  ";
					const maxTitleLen = Math.max(10, cardW - 5);
					const rawTitle = game.title || game.slug;
					const titleDisp =
						rawTitle.length > maxTitleLen ? rawTitle.slice(0, maxTitleLen - 1) + "…" : rawTitle;

					cardElem.titleText.content = `${prefix}${titleDisp}`;
					cardElem.titleText.fg = isSelected ? THEME.peach : THEME.textBright;

					const maxSlugLen = Math.max(10, cardW - 4);
					const rawSlug = `slug: ${game.slug}`;
					cardElem.slugText.content =
						rawSlug.length > maxSlugLen ? rawSlug.slice(0, maxSlugLen - 1) + "…" : rawSlug;

					let mCount = 0;
					let cCount = 0;
					if (Array.isArray(game.stats)) {
						for (const st of game.stats) {
							if (st.label?.includes("marker")) mCount = st.value;
							else if (st.label?.includes("categor")) cCount = st.value;
						}
					}
					cardElem.statsText.content = `${fmt(mCount)} markers · ${fmt(cCount)} cats`;

					const maxDescLen = Math.max(10, cardW - 4);
					const desc = (game.description || "").trim();
					cardElem.descText.content = desc.length > maxDescLen ? desc.slice(0, maxDescLen - 1) + "…" : desc;

					const tag = game.tagLabel ? `${game.tagLabel}: ${game.defaultTag || "All"}` : "";
					cardElem.tagText.content = tag.length > maxDescLen ? tag.slice(0, maxDescLen - 1) + "…" : tag;
				} else {
					cardElem.box.borderColor = RGBA_THEME.borderDim;
					cardElem.box.backgroundColor = THEME.bgDark;
					cardElem.titleText.content = "";
					cardElem.slugText.content = "";
					cardElem.statsText.content = "";
					cardElem.descText.content = "";
					cardElem.tagText.content = "";
				}

				cardIdx++;
			}
		}

		renderer.requestRender();
	}

	function openEditModal() {
		const game = displayedGames[selectedIdx];
		if (!game) return;
		modalState = "edit";
		editBox.visible = true;
		deleteMsg.visible = false;
		searchBox.visible = false;
		modalTitle.content = `EDIT GAME: ${game.title} (${game.slug})`;
		modalHint.content = "[Tab/Shift+Tab] Move   [Enter] Save Changes   [Esc] Cancel";

		titleInput.value = game.title || "";
		descInput.value = game.description || "";
		accentInput.value = game.theme?.accent || "#a8332b";
		tagLabelInput.value = game.tagLabel || "";
		defaultTagInput.value = game.defaultTag || "";

		editFocusIdx = 0;
		updateEditFocus();
		if (!modalOverlay.parent) rootBox.add(modalOverlay);
		renderer.requestRender();
	}

	function updateEditFocus() {
		for (let i = 0; i < editInputs.length; i++) {
			if (i === editFocusIdx) editInputs[i].focus();
			else editInputs[i].blur();
		}
		renderer.requestRender();
	}

	async function saveEditModal() {
		const game = displayedGames[selectedIdx];
		if (!game) return;

		game.title = titleInput.value.trim() || game.title;
		game.description = descInput.value.trim();
		const accent = accentInput.value.trim();
		if (accent.startsWith("#")) {
			if (!game.theme) game.theme = { accent };
			else game.theme.accent = accent;
		}
		const tLabel = tagLabelInput.value.trim();
		if (tLabel) game.tagLabel = tLabel;
		else delete game.tagLabel;

		const dTag = defaultTagInput.value.trim();
		if (dTag) game.defaultTag = dTag;
		else delete game.defaultTag;

		// Also update meta.json if it exists on disk
		try {
			const metaPath = path.join(mapsDir, game.slug, "meta.json");
			const raw = await readFile(metaPath, "utf8");
			const meta = JSON.parse(raw);
			meta.title = game.title;
			meta.description = game.description;
			if (game.theme?.accent) {
				if (!meta.theme) meta.theme = {};
				meta.theme.accent = game.theme.accent;
			}
			if (game.tagLabel) meta.tagLabel = game.tagLabel;
			if (game.defaultTag) meta.defaultTag = game.defaultTag;
			await writeFile(metaPath, JSON.stringify(meta, null, "\t") + "\n", "utf8");
		} catch {}

		await saveIndexData();
		closeModal();
		applySearchFilter();
		showToast(`✓ Saved changes to "${game.title}"`);
	}

	function openDeleteModal() {
		const game = displayedGames[selectedIdx];
		if (!game) return;
		modalState = "delete";
		editBox.visible = false;
		deleteMsg.visible = true;
		searchBox.visible = false;
		modalTitle.content = `DELETE GAME FROM CATALOG`;
		deleteMsg.content = `Are you sure you want to remove "${game.title}" (${game.slug}) from index.json?\n(Files on disk will be preserved)`;
		modalHint.content = " [Y] Yes, Delete   [N / Esc] Cancel";

		if (!modalOverlay.parent) rootBox.add(modalOverlay);
		renderer.requestRender();
	}

	async function confirmDelete() {
		const game = displayedGames[selectedIdx];
		if (!game) return;

		const realIdx = allGames.findIndex((g) => g.slug === game.slug);
		if (realIdx >= 0) {
			allGames.splice(realIdx, 1);
			await saveIndexData();
			showToast(`✓ Deleted "${game.title}" from catalog`);
		}
		closeModal();
		applySearchFilter();
	}

	function openSearchModal() {
		modalState = "search";
		editBox.visible = false;
		deleteMsg.visible = false;
		searchBox.visible = true;
		modalTitle.content = "SEARCH / FILTER CATALOG";
		searchInput.value = searchQuery;
		searchInput.focus();
		modalHint.content = "[Type to filter]   [Enter] Done   [Esc] Clear & Exit";

		if (!modalOverlay.parent) rootBox.add(modalOverlay);
		renderer.requestRender();
	}

	searchInput.on(InputRenderableEvents.INPUT, (val) => {
		searchQuery = val;
		applySearchFilter();
	});

	function closeModal() {
		modalState = null;
		for (const input of editInputs) input.blur();
		searchInput.blur();
		if (modalOverlay.parent) rootBox.remove(modalOverlay);
		renderer.requestRender();
	}

	async function moveGame(dir: -1 | 1) {
		const game = displayedGames[selectedIdx];
		if (!game) return;

		const realIdx = allGames.findIndex((g) => g.slug === game.slug);
		if (realIdx < 0) return;

		const targetIdx = realIdx + dir;
		if (targetIdx < 0 || targetIdx >= allGames.length) return;

		// Swap in allGames
		const temp = allGames[realIdx];
		allGames[realIdx] = allGames[targetIdx];
		allGames[targetIdx] = temp;

		await saveIndexData();

		// Update selection to follow game
		applySearchFilter();
		selectedIdx = displayedGames.findIndex((g) => g.slug === game.slug);
		renderGrid();
		showToast(`✓ Reordered: "${game.title}" moved to #${selectedIdx + 1}`);
	}

	let fsWatcher: FSWatcher | null = null;
	let reloadDebounce: any = null;
	let isDestroyed = false;

	function triggerAutoReload() {
		if (isSelfWriting || isDestroyed || modalState !== null) return;
		clearTimeout(reloadDebounce);
		reloadDebounce = setTimeout(async () => {
			if (isSelfWriting || isDestroyed || modalState !== null) return;
			await loadIndexData();
			renderer.requestRender();
		}, 150);
	}

	try {
		const dir = path.dirname(path.resolve(indexPath));
		const base = path.basename(indexPath);
		fsWatcher = watch(dir, (event, filename) => {
			if (!filename || filename === base) {
				triggerAutoReload();
			}
		});
	} catch {
		try {
			fsWatcher = watch(indexPath, () => {
				triggerAutoReload();
			});
		} catch {}
	}

	await loadIndexData();

	return {
		root: rootBox,
		async reload() {
			await loadIndexData();
		},
		isModalOpen() {
			return modalState !== null;
		},
		focus() {
			loadIndexData().catch(() => {});
		},
		blur() {
			if (modalState) closeModal();
		},
		handleKey(key: KeyEvent): boolean {
			// Handle modal keys if modal is open
			if (modalState === "edit") {
				if (key.name === "escape") {
					closeModal();
					return true;
				}
				if (key.name === "tab") {
					if (key.shift) {
						editFocusIdx = (editFocusIdx - 1 + editInputs.length) % editInputs.length;
					} else {
						editFocusIdx = (editFocusIdx + 1) % editInputs.length;
					}
					updateEditFocus();
					key.preventDefault();
					return true;
				}
				if (key.name === "return") {
					saveEditModal();
					return true;
				}
				return false;
			}

			if (modalState === "delete") {
				if (key.name === "y" || key.name === "Y") {
					confirmDelete();
					return true;
				}
				if (key.name === "n" || key.name === "N" || key.name === "escape") {
					closeModal();
					return true;
				}
				return true;
			}

			if (modalState === "search") {
				if (key.name === "escape") {
					searchQuery = "";
					applySearchFilter();
					closeModal();
					return true;
				}
				if (key.name === "return") {
					closeModal();
					return true;
				}
				return false;
			}

			// Catalog Grid Navigation
			if (key.name === "left" || key.name === "h") {
				if (selectedIdx > 0) {
					selectedIdx--;
					renderGrid();
				}
				return true;
			}
			if (key.name === "right" || key.name === "l") {
				if (selectedIdx < displayedGames.length - 1) {
					selectedIdx++;
					renderGrid();
				}
				return true;
			}
			if (key.name === "up" || key.name === "k") {
				if (selectedIdx >= 4) {
					selectedIdx -= 4;
					renderGrid();
				}
				return true;
			}
			if (key.name === "down" || key.name === "j") {
				if (selectedIdx + 4 < displayedGames.length) {
					selectedIdx += 4;
					renderGrid();
				} else if (selectedIdx < displayedGames.length - 1) {
					selectedIdx = displayedGames.length - 1;
					renderGrid();
				}
				return true;
			}
			if (key.name === "home") {
				selectedIdx = 0;
				renderGrid();
				return true;
			}
			if (key.name === "end") {
				selectedIdx = Math.max(0, displayedGames.length - 1);
				renderGrid();
				return true;
			}
			if (key.name === "pageup") {
				selectedIdx = Math.max(0, selectedIdx - 16);
				renderGrid();
				return true;
			}
			if (key.name === "pagedown") {
				selectedIdx = Math.min(Math.max(0, displayedGames.length - 1), selectedIdx + 16);
				renderGrid();
				return true;
			}

			// CRUD Operations
			if (key.name === "e" || key.name === "return") {
				openEditModal();
				return true;
			}
			if (key.name === "d" || key.name === "delete") {
				openDeleteModal();
				return true;
			}
			if (key.name === "[") {
				moveGame(-1);
				return true;
			}
			if (key.name === "]") {
				moveGame(1);
				return true;
			}
			if (key.name === "/") {
				openSearchModal();
				return true;
			}

			// Actions
			if (key.name === "p" || key.name === "P") {
				const g = displayedGames[selectedIdx];
				if (g && opts.onPrune) opts.onPrune(g);
				return true;
			}
			if (key.name === "c" || key.name === "C") {
				const g = displayedGames[selectedIdx];
				if (g && opts.onCards) opts.onCards(g);
				return true;
			}
			if (key.name === "n" || key.name === "N") {
				if (opts.onNewScrape) opts.onNewScrape();
				return true;
			}

			return false;
		},
		resize(w: number, h: number) {
			boxW = w;
			boxH = h;
			rootBox.width = boxW;
			rootBox.height = boxH;
			topBar.width = boxW - 2;
			modalOverlay.width = Math.min(boxW - 4, 80);
			modalOverlay.left = Math.max(1, Math.floor((boxW - Math.min(boxW - 4, 80)) / 2));
			renderGrid();
		},
		destroy() {
			isDestroyed = true;
			clearTimeout(toastTimer);
			clearTimeout(reloadDebounce);
			if (fsWatcher) {
				try {
					fsWatcher.close();
				} catch {}
				fsWatcher = null;
			}
			try {
				for (const input of editInputs) input.removeAllListeners();
				searchInput.removeAllListeners();
			} catch {}
		},
	};
}