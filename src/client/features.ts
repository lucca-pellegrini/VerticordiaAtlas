// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// features.ts: progressive enhancement for the homepage illustrated feature showcase.
// Pauses CSS animations when offscreen or tab is hidden, and supports tap/keyboard card highlight.

export function initFeatures(): void {
	if (typeof document === "undefined") return;

	const section = document.querySelector<HTMLElement>(".features");
	if (!section) return;

	let isIntersecting = false;

	const updatePauseState = () => {
		if (document.hidden || !isIntersecting) {
			section.classList.add("is-paused");
		} else {
			section.classList.remove("is-paused");
		}
	};

	if ("IntersectionObserver" in window) {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					isIntersecting = entry.isIntersecting;
					updatePauseState();
				}
			},
			{ rootMargin: "100px" },
		);
		observer.observe(section);
	} else {
		isIntersecting = true;
		updatePauseState();
	}

	document.addEventListener("visibilitychange", updatePauseState);

	const cards = section.querySelectorAll<HTMLElement>(".feat-card");
	const toggleCard = (card: HTMLElement) => {
		const wasActive = card.classList.contains("is-active");
		for (const c of cards) c.classList.remove("is-active");
		if (!wasActive) card.classList.add("is-active");
	};

	for (const card of cards) {
		card.addEventListener("click", () => toggleCard(card));
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggleCard(card);
			}
		});
	}
}