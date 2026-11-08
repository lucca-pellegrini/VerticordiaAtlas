import { expect, test } from "bun:test";

import { parsePerfFlag, perf, perfAsync, perfRows, setPerfEnabled } from "../src/client/perf.ts";

test("parsePerfFlag: query beats storage, default off", () => {
	expect(parsePerfFlag("", null)).toBe(false);
	expect(parsePerfFlag("?perf=1", null)).toBe(true);
	expect(parsePerfFlag("", "1")).toBe(true);
	expect(parsePerfFlag("?perf=0", "1")).toBe(false);
	expect(parsePerfFlag("?perf=yes", null)).toBe(false);
}, 30_000);

test("disabled wrappers call through, keep results and errors, record nothing", async () => {
	setPerfEnabled(false);
	const obj = {};
	expect(perf("a", () => obj)).toBe(obj);
	const p = Promise.resolve(7);
	expect(perfAsync("b", () => p)).toBe(p);
	expect(() =>
		perf("c", () => {
			throw new Error("x");
		}),
	).toThrow("x");
	await expect(perfAsync("d", () => Promise.reject(new Error("y")))).rejects.toThrow("y");
	expect(perfRows().size).toBe(0);
}, 30_000);

test("enabled wrappers record, still return and throw the same", async () => {
	setPerfEnabled(true);
	const log = console.debug;
	console.debug = () => {};
	try {
		expect(perf("a", () => 1)).toBe(1);
		expect(await perfAsync("b", async () => 2)).toBe(2);
		expect(() =>
			perf("a", () => {
				throw new Error("x");
			}),
		).toThrow("x");
		expect(perfRows().get("a")?.count).toBe(2);
		expect(perfRows().get("b")?.count).toBe(1);
	} finally {
		console.debug = log;
		setPerfEnabled(false);
	}
}, 30_000);