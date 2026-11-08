// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// Starts the real server on a kernel-assigned port (`--port 0`) and reads that port from its startup line,
// so parallel test runs never collide. Its output is swallowed unless DEBUG is set.
export async function spawnServer(): Promise<{ base: string; port: number; proc: ReturnType<typeof Bun.spawn> }> {
	const proc = Bun.spawn(["bun", "server/server.ts", "--no-tui", "--port", "0"], {
		stdout: "pipe",
		stderr: process.env.DEBUG ? "inherit" : "ignore",
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value);
		if (process.env.DEBUG) process.stdout.write(chunk);
		text += chunk;
		const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(text);
		if (!m) continue;
		// keep the pipe drained so the server never blocks writing to it
		void (async () => {
			for (;;) {
				if ((await reader.read()).done) break;
			}
		})();
		const port = Number(m[1]);
		return { base: `http://127.0.0.1:${port}`, port, proc };
	}
	proc.kill(9);
	throw new Error("server did not report its port");
}