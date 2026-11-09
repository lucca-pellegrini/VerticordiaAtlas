// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import {
	BoxRenderable,
	type CliRenderer,
	FrameBufferRenderable,
	type KeyEvent,
	RGBA,
	TextAttributes,
} from "@opentui/core";

import { RGBA_THEME, THEME } from "./theme.js";

export interface QuitConfirmOptions {
	onConfirm: () => void;
	onCancel: () => void;
	timeoutMs?: number; // default 10_000 (10s)
	animationFps?: number; // default 20-30 fps
}

export interface QuitConfirmOverlay {
	show(): void;
	hide(): void;
	isActive(): boolean;
	handleKey(key: KeyEvent): boolean;
	handleResize(width: number, height: number): void;
	destroy(): void;
	readonly overlayBox: BoxRenderable;
}

export interface WaveColorOptions {
	baseHue?: number;
	baseSat?: number;
	satAmp?: number;
	baseLightness?: number;
	lightnessAmp?: number;
	freq?: number;
	speed?: number;
}

export interface OverlayDimensions {
	modalW: number;
	modalH: number;
	fbW: number;
	fbH: number;
}

export interface OverlayRowLayout {
	yBadge: number;
	yQuestion: number;
	yCountdown: number;
	yConfirm: number;
	yCancel: number;
}

/** Convert HSL color to RGB integer triplet [0-255]. */
export function hslToRgbInts(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r1 = 0;
	let g1 = 0;
	let b1 = 0;
	if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
	else if (hp >= 1 && hp < 2) [r1, g1, b1] = [x, c, 0];
	else if (hp >= 2 && hp < 3) [r1, g1, b1] = [0, c, x];
	else if (hp >= 3 && hp < 4) [r1, g1, b1] = [0, x, c];
	else if (hp >= 4 && hp < 5) [r1, g1, b1] = [x, 0, c];
	else if (hp >= 5 && hp < 6) [r1, g1, b1] = [c, 0, x];
	const m = l - c / 2;
	return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/**
 * Calculate the wave background color at cell offset (dx, dy) and timestamp `timeMs`.
 * Terminal character cells have an approximate 1:2 aspect ratio, so `dy` should be pre-scaled by 2.
 */
export function calculateWaveColor(dx: number, dy: number, timeMs: number, options: WaveColorOptions = {}): RGBA {
	const baseHue = options.baseHue ?? 350;
	const baseSat = options.baseSat ?? 0.28;
	const satAmp = options.satAmp ?? 0.16;
	const baseLightness = options.baseLightness ?? 0.13;
	const lightnessAmp = options.lightnessAmp ?? 0.025;
	const freq = options.freq ?? 0.38;
	const speed = options.speed ?? 0.003;

	const distance = Math.hypot(dx, dy);
	const phase = distance * freq - timeMs * speed;
	const saturation = Math.max(0, Math.min(1, baseSat + satAmp * Math.sin(phase)));
	const lightness = Math.max(0, Math.min(1, baseLightness + lightnessAmp * Math.sin(phase)));
	const [r, g, b] = hslToRgbInts(baseHue, saturation, lightness);
	return RGBA.fromInts(r, g, b, 255);
}

/** Check if the key press confirms dashboard shutdown (Enter or Ctrl+C). */
export function isConfirmKey(key: KeyEvent): boolean {
	if (!key) return false;
	if (key.name === "return" || key.name === "enter" || key.raw === "\r" || key.raw === "\n") {
		return true;
	}
	const isCtrlC =
		(!key.shift && key.ctrl && (key.name === "c" || key.name === "C")) || (key.raw === "\x03" && !key.shift);
	return Boolean(isCtrlC);
}

/** Compute responsive modal and framebuffer dimensions for the given terminal size. */
export function computeDimensions(termW: number, termH: number): OverlayDimensions {
	const safeW = Math.max(20, termW);
	const safeH = Math.max(10, termH);
	const modalW = Math.max(40, Math.min(60, safeW >= 64 ? 56 : safeW - 4));
	const modalH = Math.max(9, Math.min(13, safeH >= 16 ? 11 : safeH - 2));
	const fbW = Math.max(10, modalW - 2);
	const fbH = Math.max(6, modalH - 2);
	return { modalW, modalH, fbW, fbH };
}

/** Layout row indices for the modal content based on available framebuffer height. */
export function layoutOverlayRows(fbH: number): OverlayRowLayout {
	if (fbH >= 9) return { yBadge: 1, yQuestion: 3, yCountdown: 5, yConfirm: 7, yCancel: 8 };
	if (fbH === 8) return { yBadge: 0, yQuestion: 2, yCountdown: 4, yConfirm: 6, yCancel: 7 };
	if (fbH === 7) return { yBadge: 0, yQuestion: 2, yCountdown: 3, yConfirm: 5, yCancel: 6 };
	return { yBadge: 0, yQuestion: 1, yCountdown: 2, yConfirm: 4, yCancel: 5 };
}

/**
 * Creates the Quit Confirmation overlay component.
 * Features a dark full-screen backdrop and a centered modal with an animated circular
 * waving background that gently pulses saturation outward from the center.
 */
export function createQuitConfirmOverlay(renderer: CliRenderer, options: QuitConfirmOptions): QuitConfirmOverlay {
	let termW = renderer?.width || 80;
	let termH = renderer?.height || 24;
	let dims = computeDimensions(termW, termH);

	let active = false;
	let startTime = 0;
	let cancelTimer: ReturnType<typeof setTimeout> | null = null;
	let animTimer: ReturnType<typeof setInterval> | null = null;

	const timeoutMs = options.timeoutMs ?? 10_000;
	const fps = Math.max(1, Math.min(60, options.animationFps ?? 25));
	const frameIntervalMs = Math.round(1000 / fps);

	// Full-screen backdrop dims the entire TUI behind the modal
	const overlayBox = new BoxRenderable(renderer, {
		position: "absolute",
		top: 0,
		left: 0,
		width: "100%",
		height: "100%",
		zIndex: 9999,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: RGBA.fromInts(10, 10, 18, 240),
		visible: false,
	});

	// Centered modal box with warning red rounded border
	const modalBox = new BoxRenderable(renderer, {
		border: true,
		borderStyle: "rounded",
		borderColor: THEME.red,
		title: " ⚠ QUIT CONFIRMATION ",
		titleColor: THEME.peach,
		titleAlignment: "center",
		backgroundColor: RGBA_THEME.bgDark,
		alignItems: "center",
		justifyContent: "center",
		width: dims.modalW,
		height: dims.modalH,
	});

	const fb = new FrameBufferRenderable(renderer, {
		width: dims.fbW,
		height: dims.fbH,
	});

	modalBox.add(fb);
	overlayBox.add(modalBox);

	if (renderer?.root && !overlayBox.parent) {
		renderer.root.add(overlayBox);
	}

	function drawFrame(elapsed = 0): void {
		const remainingSec = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
		const cx = Math.floor(dims.fbW / 2);
		const cy = Math.floor(dims.fbH / 2);

		// 1. Draw circular wave background cells
		for (let y = 0; y < dims.fbH; y++) {
			const scaledDy = (y - cy) * 2;
			for (let x = 0; x < dims.fbW; x++) {
				const dx = x - cx;
				const bg = calculateWaveColor(dx, scaledDy, elapsed);
				fb.frameBuffer.setCell(x, y, " ", bg, bg);
			}
		}

		// 2. Row layout
		const rows = layoutOverlayRows(dims.fbH);

		// 3. Warning header badge
		const badge = dims.fbW >= 36 ? "  ⚠  QUIT SERVER DASHBOARD  " : " ⚠ QUIT DASHBOARD ";
		const badgeX = Math.max(0, Math.floor((dims.fbW - badge.length) / 2));
		fb.frameBuffer.drawText(
			badge,
			badgeX,
			rows.yBadge,
			RGBA_THEME.textBright,
			RGBA_THEME.flashRedBg,
			TextAttributes.BOLD,
		);

		// 4. Confirmation question (characters sit directly on the wave cells)
		const question = dims.fbW >= 44 ? "Are you sure you want to stop the server?" : "Stop the server?";
		const questionX = Math.max(0, Math.floor((dims.fbW - question.length) / 2));
		const qScaledDy = (rows.yQuestion - cy) * 2;
		for (let i = 0; i < question.length; i++) {
			const cellX = questionX + i;
			if (cellX >= 0 && cellX < dims.fbW) {
				const cellBg = calculateWaveColor(cellX - cx, qScaledDy, elapsed);
				fb.frameBuffer.setCell(
					cellX,
					rows.yQuestion,
					question[i],
					RGBA_THEME.textBright,
					cellBg,
					TextAttributes.BOLD,
				);
			}
		}

		// 5. Active countdown badge
		const countdown = `[ Auto-cancel in ${remainingSec}s ]`;
		const countdownX = Math.max(0, Math.floor((dims.fbW - countdown.length) / 2));
		const cdScaledDy = (rows.yCountdown - cy) * 2;
		for (let i = 0; i < countdown.length; i++) {
			const cellX = countdownX + i;
			if (cellX >= 0 && cellX < dims.fbW) {
				const cellBg = calculateWaveColor(cellX - cx, cdScaledDy, elapsed);
				fb.frameBuffer.setCell(
					cellX,
					rows.yCountdown,
					countdown[i],
					RGBA_THEME.peach,
					cellBg,
					TextAttributes.BOLD,
				);
			}
		}

		// 6. Key guides / footer
		if (dims.fbW >= 48) {
			const f1 = "[Enter] or [^C] Confirm Shutdown";
			const f1X = Math.max(0, Math.floor((dims.fbW - f1.length) / 2));
			const f1Dy = (rows.yConfirm - cy) * 2;
			const confirmIdx = f1.indexOf("Confirm");
			for (let i = 0; i < f1.length; i++) {
				const cellX = f1X + i;
				if (cellX >= 0 && cellX < dims.fbW) {
					const cellBg = calculateWaveColor(cellX - cx, f1Dy, elapsed);
					const isKey = i < confirmIdx;
					const fg = isKey ? RGBA_THEME.green : RGBA_THEME.text;
					const attrs = isKey ? TextAttributes.BOLD : TextAttributes.NONE;
					fb.frameBuffer.setCell(cellX, rows.yConfirm, f1[i], fg, cellBg, attrs);
				}
			}

			const f2 = "[Any other key] Cancel";
			const f2X = Math.max(0, Math.floor((dims.fbW - f2.length) / 2));
			const f2Dy = (rows.yCancel - cy) * 2;
			const cancelIdx = f2.indexOf("Cancel");
			for (let i = 0; i < f2.length; i++) {
				const cellX = f2X + i;
				if (cellX >= 0 && cellX < dims.fbW) {
					const cellBg = calculateWaveColor(cellX - cx, f2Dy, elapsed);
					const isCancel = i >= cancelIdx;
					const fg = isCancel ? RGBA_THEME.peach : RGBA_THEME.textDim;
					const attrs = isCancel ? TextAttributes.BOLD : TextAttributes.NONE;
					fb.frameBuffer.setCell(cellX, rows.yCancel, f2[i], fg, cellBg, attrs);
				}
			}
		} else {
			const f1 = "[Enter]/[^C] Confirm";
			const f1X = Math.max(0, Math.floor((dims.fbW - f1.length) / 2));
			const f1Dy = (rows.yConfirm - cy) * 2;
			for (let i = 0; i < f1.length; i++) {
				const cellX = f1X + i;
				if (cellX >= 0 && cellX < dims.fbW) {
					const cellBg = calculateWaveColor(cellX - cx, f1Dy, elapsed);
					fb.frameBuffer.setCell(cellX, rows.yConfirm, f1[i], RGBA_THEME.green, cellBg, TextAttributes.BOLD);
				}
			}

			const f2 = "[Any key] Cancel";
			const f2X = Math.max(0, Math.floor((dims.fbW - f2.length) / 2));
			const f2Dy = (rows.yCancel - cy) * 2;
			for (let i = 0; i < f2.length; i++) {
				const cellX = f2X + i;
				if (cellX >= 0 && cellX < dims.fbW) {
					const cellBg = calculateWaveColor(cellX - cx, f2Dy, elapsed);
					fb.frameBuffer.setCell(cellX, rows.yCancel, f2[i], RGBA_THEME.peach, cellBg, TextAttributes.NONE);
				}
			}
		}
	}

	function clearTimers(): void {
		if (cancelTimer !== null) {
			clearTimeout(cancelTimer);
			cancelTimer = null;
		}
		if (animTimer !== null) {
			clearInterval(animTimer);
			animTimer = null;
		}
	}

	function show(): void {
		if (active) return;
		active = true;
		startTime = Date.now();

		if (renderer?.root && !overlayBox.parent) {
			renderer.root.add(overlayBox);
		}
		overlayBox.visible = true;

		drawFrame(0);
		renderer?.requestRender?.();

		clearTimers();

		cancelTimer = setTimeout(() => {
			if (!active) return;
			hide();
			options.onCancel();
		}, timeoutMs);

		animTimer = setInterval(() => {
			if (!active) return;
			const elapsed = Date.now() - startTime;
			if (elapsed >= timeoutMs) {
				hide();
				options.onCancel();
				return;
			}
			drawFrame(elapsed);
			renderer?.requestRender?.();
		}, frameIntervalMs);
	}

	function hide(): void {
		if (!active) return;
		active = false;
		clearTimers();
		overlayBox.visible = false;
		renderer?.requestRender?.();
	}

	function isActive(): boolean {
		return active;
	}

	function handleKey(key: KeyEvent): boolean {
		if (!active) return false;

		key?.preventDefault?.();
		key?.stopPropagation?.();

		if (isConfirmKey(key)) {
			hide();
			options.onConfirm();
		} else {
			hide();
			options.onCancel();
		}
		return true;
	}

	function handleResize(width: number, height: number): void {
		termW = width || renderer?.width || 80;
		termH = height || renderer?.height || 24;
		dims = computeDimensions(termW, termH);

		modalBox.width = dims.modalW;
		modalBox.height = dims.modalH;
		fb.width = dims.fbW;
		fb.height = dims.fbH;
		try {
			fb.frameBuffer.resize(dims.fbW, dims.fbH);
		} catch {}

		if (active) {
			const elapsed = startTime > 0 ? Date.now() - startTime : 0;
			drawFrame(elapsed);
			renderer?.requestRender?.();
		}
	}

	function destroy(): void {
		hide();
		if (overlayBox.parent) {
			overlayBox.parent.remove(overlayBox);
		}
		try {
			overlayBox.destroy?.();
		} catch {}
	}

	// Render initial layout to framebuffer
	drawFrame(0);

	return {
		show,
		hide,
		isActive,
		handleKey,
		handleResize,
		destroy,
		overlayBox,
	};
}