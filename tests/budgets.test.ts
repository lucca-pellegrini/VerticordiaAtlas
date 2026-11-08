// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { describe, expect, test } from "bun:test";

import { type Budget, evaluate } from "../scripts/check-budgets.ts";

const b: Budget = { id: "x", file: "public/x.js", metric: "gzip", measured: 100, hard: 110 };

describe("check-budgets evaluate", () => {
	test("pass at or below hard budget, with roadmap target note", () => {
		expect(evaluate(b, 110).status).toBe("pass");
		expect(evaluate({ ...b, target: 90 }, 100).message).toContain("Roadmap target 90 B not yet met");
	});
	test("fail over hard budget with raise instructions", () => {
		const r = evaluate(b, 111);
		expect(r.status).toBe("fail");
		expect(r.message).toContain("over hard budget 110 B");
		expect(r.message).toContain("scripts/budgets.json");
	});
	test("soft budget only warns", () => {
		const r = evaluate({ id: "d", file: "d.json", metric: "raw", measured: 100, soft: 120 }, 130);
		expect(r.status).toBe("warn");
		expect(r.message).toContain("scraper update");
	});
	test("missing file: fail unless optional", () => {
		expect(evaluate(b, null).status).toBe("fail");
		expect(evaluate({ ...b, optional: true }, null).status).toBe("skip");
	});
});