// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";

import { type KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
	calculateWaveColor,
	computeDimensions,
	createQuitConfirmOverlay,
	hslToRgbInts,
	isConfirmKey,
	layoutOverlayRows,
} from "../scripts/tui/quit-confirm.js";

describe("QuitConfirm pure math & helpers", () => {
	test("hslToRgbInts converts hues and bounds RGB to [0, 255]", () => {
		// Pure primary colors
		expect(hslToRgbInts(0, 1, 0.5)).toEqual([255, 0, 0]);
		expect(hslToRgbInts(120, 1, 0.5)).toEqual([0, 255, 0]);
		expect(hslToRgbInts(240, 1, 0.5)).toEqual([0, 0, 255]);

		// Extremes: black and white
		expect(hslToRgbInts(0, 0, 0)).toEqual([0, 0, 0]);
		expect(hslToRgbInts(0, 0, 1)).toEqual([255, 255, 255]);

		// Hue wrapping (modulo 360)
		expect(hslToRgbInts(360, 1, 0.5)).toEqual([255, 0, 0]);
		expect(hslToRgbInts(-360, 1, 0.5)).toEqual([255, 0, 0]);
		expect(hslToRgbInts(720, 1, 0.5)).toEqual([255, 0, 0]);

		// Mid-range values produce valid integer triples in [0, 255]
		const [r, g, b] = hslToRgbInts(350, 0.35, 0.15);
		expect(r).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(255);
		expect(g).toBeGreaterThanOrEqual(0);
		expect(g).toBeLessThanOrEqual(255);
		expect(b).toBeGreaterThanOrEqual(0);
		expect(b).toBeLessThanOrEqual(255);
		expect(Number.isInteger(r)).toBe(true);
		expect(Number.isInteger(g)).toBe(true);
		expect(Number.isInteger(b)).toBe(true);
	});

	test("calculateWaveColor computes circular wave with outward phase progression", () => {
		// Circular symmetry: points at same distance from center have identical color
		const colorRight = calculateWaveColor(6, 0, 1000);
		const colorLeft = calculateWaveColor(-6, 0, 1000);
		expect(colorRight.toInts()).toEqual(colorLeft.toInts());

		// Scaling: terminal cell aspect ratio scaling (dy scaled by 2)
		// dx = 6, dy = 0 has distance 6. dx = 0, dy = 6 has distance 6.
		const colorY = calculateWaveColor(0, 6, 1000);
		expect(colorRight.toInts()).toEqual(colorY.toInts());

		// Alpha is solid 255
		const [, , , a] = colorRight.toInts();
		expect(a).toBe(255);

		// Wave outward propagation:
		// Phase = distance * freq - timeMs * speed.
		// For a given phase value, distance increases as time increases.
		const freq = 0.38;
		const speed = 0.003;
		const t0 = 0;
		const t1 = 2000;
		// At t0, phase at d=0 is 0.
		// At t1, the same phase (0) occurs at distance = t1 * speed / freq.
		const expectedDistAtT1 = (t1 * speed) / freq;
		const cCenterT0 = calculateWaveColor(0, 0, t0);
		const cWaveFrontT1 = calculateWaveColor(expectedDistAtT1, 0, t1);
		expect(cCenterT0.toInts()).toEqual(cWaveFrontT1.toInts());
	});

	test("isConfirmKey correctly recognizes Enter and Ctrl+C combinations", () => {
		// Enter variations
		expect(isConfirmKey({ name: "return" } as KeyEvent)).toBe(true);
		expect(isConfirmKey({ name: "enter" } as KeyEvent)).toBe(true);
		expect(isConfirmKey({ raw: "\r" } as KeyEvent)).toBe(true);
		expect(isConfirmKey({ raw: "\n" } as KeyEvent)).toBe(true);

		// Ctrl+C variations (without Shift)
		expect(isConfirmKey({ ctrl: true, shift: false, name: "c" } as KeyEvent)).toBe(true);
		expect(isConfirmKey({ ctrl: true, shift: false, name: "C" } as KeyEvent)).toBe(true);
		expect(isConfirmKey({ raw: "\x03", shift: false } as KeyEvent)).toBe(true);

		// Ctrl+Shift+C is copy shortcut, should NOT confirm shutdown
		expect(isConfirmKey({ ctrl: true, shift: true, name: "c" } as KeyEvent)).toBe(false);
		expect(isConfirmKey({ raw: "\x03", shift: true } as KeyEvent)).toBe(false);

		// Any other key cancels
		expect(isConfirmKey({ name: "escape" } as KeyEvent)).toBe(false);
		expect(isConfirmKey({ name: "space" } as KeyEvent)).toBe(false);
		expect(isConfirmKey({ name: "y" } as KeyEvent)).toBe(false);
		expect(isConfirmKey({ name: "n" } as KeyEvent)).toBe(false);
		expect(isConfirmKey({ name: "q" } as KeyEvent)).toBe(false);
		expect(isConfirmKey(null as any)).toBe(false);
		expect(isConfirmKey(undefined as any)).toBe(false);
	});

	test("computeDimensions produces responsive, bounded sizes", () => {
		// Standard 80x24 terminal
		const d80 = computeDimensions(80, 24);
		expect(d80.modalW).toBe(56);
		expect(d80.modalH).toBe(11);
		expect(d80.fbW).toBe(54);
		expect(d80.fbH).toBe(9);

		// Wide 120x35 terminal
		const d120 = computeDimensions(120, 35);
		expect(d120.modalW).toBe(56);
		expect(d120.modalH).toBe(11);
		expect(d120.fbW).toBe(54);
		expect(d120.fbH).toBe(9);

		// Compact 50x14 terminal
		const d50 = computeDimensions(50, 14);
		expect(d50.modalW).toBe(46);
		expect(d50.modalH).toBe(12);
		expect(d50.fbW).toBe(44);
		expect(d50.fbH).toBe(10);

		// Tiny 30x10 terminal stays safely bounded
		const d30 = computeDimensions(30, 10);
		expect(d30.modalW).toBeGreaterThanOrEqual(20);
		expect(d30.modalH).toBeGreaterThanOrEqual(8);
		expect(d30.fbW).toBe(d30.modalW - 2);
		expect(d30.fbH).toBe(d30.modalH - 2);
	});

	test("layoutOverlayRows scales rows gracefully based on framebuffer height", () => {
		const r9 = layoutOverlayRows(9);
		expect(r9.yBadge).toBe(1);
		expect(r9.yQuestion).toBe(3);
		expect(r9.yCountdown).toBe(5);
		expect(r9.yConfirm).toBe(7);
		expect(r9.yCancel).toBe(8);

		const r7 = layoutOverlayRows(7);
		expect(r7.yBadge).toBe(0);
		expect(r7.yQuestion).toBe(2);
		expect(r7.yCountdown).toBe(3);
		expect(r7.yConfirm).toBe(5);
		expect(r7.yCancel).toBe(6);

		const r6 = layoutOverlayRows(6);
		expect(r6.yBadge).toBe(0);
		expect(r6.yQuestion).toBe(1);
		expect(r6.yCountdown).toBe(2);
		expect(r6.yConfirm).toBe(4);
		expect(r6.yCancel).toBe(5);
	});
});

describe("QuitConfirmOverlay component", () => {
	test("initial state is inactive and hidden", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		let confirmed = false;
		let cancelled = false;

		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {
				confirmed = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		expect(overlay.isActive()).toBe(false);
		expect(overlay.overlayBox.visible).toBe(false);
		expect(confirmed).toBe(false);
		expect(cancelled).toBe(false);

		// Keys sent when inactive should return false and not invoke callbacks
		const handled = overlay.handleKey({ name: "return" } as KeyEvent);
		expect(handled).toBe(false);
		expect(confirmed).toBe(false);
		expect(cancelled).toBe(false);

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("show() activates overlay and renders warning modal onto framebuffer", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {},
			onCancel: () => {},
		});

		overlay.show();
		expect(overlay.isActive()).toBe(true);
		expect(overlay.overlayBox.visible).toBe(true);

		await testEnv.renderOnce();
		const frame = testEnv.captureCharFrame();

		// Check critical user-facing strings in the captured frame
		expect(frame).toContain("QUIT SERVER DASHBOARD");
		expect(frame).toContain("Are you sure you want to stop the server?");
		expect(frame).toContain("Auto-cancel in");
		expect(frame).toContain("[Enter]");
		expect(frame).toContain("[^C]");
		expect(frame).toContain("Confirm Shutdown");
		expect(frame).toContain("[Any other key] Cancel");

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("confirming with Enter calls onConfirm and hides overlay", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		let confirmed = false;
		let cancelled = false;

		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {
				confirmed = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		overlay.show();
		expect(overlay.isActive()).toBe(true);

		let prevented = false;
		let stopped = false;
		const handled = overlay.handleKey({
			name: "return",
			preventDefault: () => {
				prevented = true;
			},
			stopPropagation: () => {
				stopped = true;
			},
		} as any);

		expect(handled).toBe(true);
		expect(prevented).toBe(true);
		expect(stopped).toBe(true);
		expect(confirmed).toBe(true);
		expect(cancelled).toBe(false);
		expect(overlay.isActive()).toBe(false);
		expect(overlay.overlayBox.visible).toBe(false);

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("confirming with Ctrl+C calls onConfirm and hides overlay", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		let confirmed = false;
		let cancelled = false;

		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {
				confirmed = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		overlay.show();
		expect(overlay.isActive()).toBe(true);

		const handled = overlay.handleKey({
			ctrl: true,
			shift: false,
			name: "c",
		} as any);

		expect(handled).toBe(true);
		expect(confirmed).toBe(true);
		expect(cancelled).toBe(false);
		expect(overlay.isActive()).toBe(false);

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("pressing any other key (e.g. Escape or letter) cancels and hides overlay", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		let confirmed = false;
		let cancelled = false;

		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {
				confirmed = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		overlay.show();
		expect(overlay.isActive()).toBe(true);

		const handled = overlay.handleKey({
			name: "escape",
		} as any);

		expect(handled).toBe(true);
		expect(confirmed).toBe(false);
		expect(cancelled).toBe(true);
		expect(overlay.isActive()).toBe(false);

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("timeout automatically cancels if no key is pressed", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		let confirmed = false;
		let cancelled = false;

		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			timeoutMs: 40,
			animationFps: 30,
			onConfirm: () => {
				confirmed = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		overlay.show();
		expect(overlay.isActive()).toBe(true);

		// Wait for timeout to expire
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(cancelled).toBe(true);
		expect(confirmed).toBe(false);
		expect(overlay.isActive()).toBe(false);
		expect(overlay.overlayBox.visible).toBe(false);

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("handleResize resizes modal without throwing", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {},
			onCancel: () => {},
		});

		overlay.show();
		overlay.handleResize(120, 35);
		await testEnv.renderOnce();
		const frame = testEnv.captureCharFrame();
		expect(frame).toContain("QUIT SERVER DASHBOARD");

		overlay.handleResize(50, 14);
		await testEnv.renderOnce();

		overlay.destroy();
		testEnv.renderer.destroy();
	});

	test("destroy() is idempotent and cleans up cleanly", async () => {
		const testEnv = await createTestRenderer({ width: 80, height: 24 });
		const overlay = createQuitConfirmOverlay(testEnv.renderer, {
			onConfirm: () => {},
			onCancel: () => {},
		});

		overlay.show();
		expect(overlay.isActive()).toBe(true);

		overlay.destroy();
		expect(overlay.isActive()).toBe(false);
		expect(overlay.overlayBox.visible).toBe(false);

		// Second call should be safe
		expect(() => overlay.destroy()).not.toThrow();

		testEnv.renderer.destroy();
	});
});