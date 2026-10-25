// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApi } from "../server/api.ts";
import { nodeBridge } from "../server/bridge.ts";

interface TestWsClient {
	ws: WebSocket;
	messages: any[];
	waitForMessage: (type?: string, timeoutMs?: number) => Promise<any>;
	waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
	close: () => void;
}

function connectWs(
	url: string,
	headers: Record<string, string> = {},
): Promise<TestWsClient> & { client: Partial<TestWsClient> } {
	const ws = new WebSocket(url, { headers } as any);
	const messages: any[] = [];
	let closeEvent: { code: number; reason: string } | null = null;
	const messageWaiters: Array<(msg: any) => void> = [];
	const closeWaiters: Array<(ev: { code: number; reason: string }) => void> = [];

	ws.onmessage = (ev) => {
		try {
			const data = JSON.parse(String(ev.data));
			messages.push(data);
			for (const waiter of [...messageWaiters]) waiter(data);
		} catch {
			/* ignore malformed */
		}
	};

	ws.onclose = (ev) => {
		closeEvent = { code: ev.code, reason: ev.reason };
		for (const waiter of [...closeWaiters]) waiter(closeEvent);
	};

	const client: TestWsClient = {
		ws,
		messages,
		waitForMessage: (type?: string, timeoutMs = 2000) => {
			if (type && messages.some((m) => m.type === type)) {
				return Promise.resolve(messages.find((m) => m.type === type));
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`Timed out waiting for message of type ${type}`)),
					timeoutMs,
				);
				const cb = (msg: any) => {
					if (!type || msg.type === type) {
						clearTimeout(timer);
						const idx = messageWaiters.indexOf(cb);
						if (idx >= 0) messageWaiters.splice(idx, 1);
						resolve(msg);
					}
				};
				messageWaiters.push(cb);
			});
		},
		waitForClose: (timeoutMs = 2000) => {
			if (closeEvent) return Promise.resolve(closeEvent);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), timeoutMs);
				const cb = (ev: { code: number; reason: string }) => {
					clearTimeout(timer);
					const idx = closeWaiters.indexOf(cb);
					if (idx >= 0) closeWaiters.splice(idx, 1);
					resolve(ev);
				};
				closeWaiters.push(cb);
			});
		},
		close: () => {
			try {
				ws.close();
			} catch {
				/* already closed */
			}
		},
	};

	const promise = new Promise<TestWsClient>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("WebSocket handshake timeout")), 2000);
		ws.onopen = () => {
			clearTimeout(timer);
			resolve(client);
		};
		ws.onerror = (err) => {
			clearTimeout(timer);
			reject(err);
		};
	});

	return Object.assign(promise, { client });
}

describe("WebSocket e2e tests (/api/ws)", () => {
	let tmpDir: string;
	let api: ReturnType<typeof createApi>;
	let server: any;
	let baseUrl: string;
	let wsBaseUrl: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "atlas-ws-test-"));
		api = createApi({ root: tmpDir, publicUrl: "http://127.0.0.1" });
		const bridge = nodeBridge(async (req, res) => {
			const url = new URL(req.url || "/", "http://127.0.0.1");
			const handled = await api.handle(req, res, url);
			if (handled === false) {
				res.writeHead(404);
				res.end();
			}
		});
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, s) {
				const url = new URL(req.url);
				if (url.pathname === "/api/ws") {
					const rejected = api.upgrade(req, s);
					if (rejected) return rejected;
					return;
				}
				return bridge(req);
			},
			websocket: api.websocket,
		});
		baseUrl = `http://127.0.0.1:${server.port}`;
		wsBaseUrl = `ws://127.0.0.1:${server.port}`;
	});

	afterEach(async () => {
		server.stop(true);
		api.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function createAccount(): Promise<{ cookie: string; user: any }> {
		const secret = api.newSecret();
		const res = await fetch(`${baseUrl}/api/auth/secret/confirm`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		expect(res.status).toBe(200);
		const setCookie = res.headers.get("set-cookie") || "";
		const cookie = setCookie.split(";")[0];
		const { user } = await res.json();
		return { cookie, user };
	}

	test("rejects handshake when no session cookie is provided", async () => {
		let failed = false;
		try {
			await connectWs(`${wsBaseUrl}/api/ws`);
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});

	test("rejects handshake when session cookie is invalid", async () => {
		let failed = false;
		try {
			await connectWs(`${wsBaseUrl}/api/ws`, { Cookie: "va_session=invalid-token-12345" });
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});

	test("rejects handshake when Origin does not match Host (CSWSH protection)", async () => {
		const { cookie } = await createAccount();
		let failed = false;
		try {
			await connectWs(`${wsBaseUrl}/api/ws`, {
				Cookie: cookie,
				Origin: "http://attacker.example.com",
			});
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});

	test("accepts handshake with matching Host and Origin, and immediately receives hello message", async () => {
		const { cookie } = await createAccount();
		const host = new URL(baseUrl).host;
		const client = await connectWs(`${wsBaseUrl}/api/ws?c=client-1`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});
		const hello = await client.waitForMessage("hello");
		expect(hello).toEqual({ type: "hello" });
		client.close();
	});

	test("accepts handshake when Origin matches X-Forwarded-Host header", async () => {
		const { cookie } = await createAccount();
		const client = await connectWs(`${wsBaseUrl}/api/ws?c=client-fwd`, {
			Cookie: cookie,
			Origin: "https://atlas.mycustomdomain.com",
			"X-Forwarded-Host": "atlas.mycustomdomain.com",
		});
		const hello = await client.waitForMessage("hello");
		expect(hello).toEqual({ type: "hello" });
		client.close();
	});

	test("sync push broadcasts 'changed' to other clients, but suppresses sender", async () => {
		const { cookie } = await createAccount();
		const host = new URL(baseUrl).host;

		const clientA = await connectWs(`${wsBaseUrl}/api/ws?c=device-a`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});
		const clientB = await connectWs(`${wsBaseUrl}/api/ws?c=device-b`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});

		await clientA.waitForMessage("hello");
		await clientB.waitForMessage("hello");

		// device-a pushes a sync item
		const pushRes = await fetch(`${baseUrl}/api/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({
				client: "device-a",
				items: [
					{
						key: "profile:game1:p1",
						value: { name: "Run 1", found: [1], updated: 10, map: "m1", cameras: {} },
						base: 0,
					},
				],
			}),
		});
		expect(pushRes.status).toBe(200);

		// device-b should receive "changed" notification
		const changedMsg = await clientB.waitForMessage("changed");
		expect(changedMsg).toEqual({ type: "changed" });

		// device-a (sender) should NOT have received "changed"
		expect(clientA.messages.filter((m) => m.type === "changed")).toHaveLength(0);

		clientA.close();
		clientB.close();
	});

	test("sync push does not leak notifications across different user accounts", async () => {
		const user1 = await createAccount();
		const user2 = await createAccount();
		const host = new URL(baseUrl).host;

		const ws1 = await connectWs(`${wsBaseUrl}/api/ws?c=user1-client`, {
			Cookie: user1.cookie,
			Origin: `http://${host}`,
		});
		const ws2 = await connectWs(`${wsBaseUrl}/api/ws?c=user2-client`, {
			Cookie: user2.cookie,
			Origin: `http://${host}`,
		});

		await ws1.waitForMessage("hello");
		await ws2.waitForMessage("hello");

		// user1 pushes a change
		await fetch(`${baseUrl}/api/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: user1.cookie },
			body: JSON.stringify({
				client: "user1-other",
				items: [
					{
						key: "profile:game1:p1",
						value: { name: "User1 Run", found: [2], updated: 20, map: "m1", cameras: {} },
						base: 0,
					},
				],
			}),
		});

		await ws1.waitForMessage("changed");
		// Wait briefly to confirm user2 receives nothing
		await new Promise((r) => setTimeout(r, 50));
		expect(ws2.messages.filter((m) => m.type === "changed")).toHaveLength(0);

		ws1.close();
		ws2.close();
	});

	test("evicts oldest connection with code 1008 when MAX_SOCKETS_PER_USER (8) is exceeded", async () => {
		const { cookie } = await createAccount();
		const host = new URL(baseUrl).host;
		const clients: TestWsClient[] = [];

		// Connect 8 sockets
		for (let i = 0; i < 8; i++) {
			const c = await connectWs(`${wsBaseUrl}/api/ws?c=client-${i}`, {
				Cookie: cookie,
				Origin: `http://${host}`,
			});
			await c.waitForMessage("hello");
			clients.push(c);
		}

		// Connect 9th socket: clients[0] (oldest) must be evicted with code 1008
		const c8 = await connectWs(`${wsBaseUrl}/api/ws?c=client-8`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});
		await c8.waitForMessage("hello");
		clients.push(c8);

		const closeEvent = await clients[0].waitForClose();
		expect(closeEvent.code).toBe(1008);
		expect(closeEvent.reason).toBe("too many connections");

		// Sockets 1-8 should remain active
		for (let i = 1; i < clients.length; i++) {
			expect(clients[i].ws.readyState).toBe(WebSocket.OPEN);
			clients[i].close();
		}
	});

	test("POST /api/auth/logout closes sockets belonging to that session with code 4401 ('signed out')", async () => {
		const { cookie } = await createAccount();
		const host = new URL(baseUrl).host;

		const client = await connectWs(`${wsBaseUrl}/api/ws?c=logout-test`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});
		await client.waitForMessage("hello");

		// Logout
		const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(logoutRes.status).toBe(200);

		const closeEvent = await client.waitForClose();
		expect(closeEvent.code).toBe(4401);
		expect(closeEvent.reason).toBe("signed out");
	});

	test("POST /api/auth/logout-all closes all sockets for the user with code 4401", async () => {
		const { cookie } = await createAccount();
		const host = new URL(baseUrl).host;

		const c1 = await connectWs(`${wsBaseUrl}/api/ws?c=c1`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});
		const c2 = await connectWs(`${wsBaseUrl}/api/ws?c=c2`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});

		await c1.waitForMessage("hello");
		await c2.waitForMessage("hello");

		const logoutRes = await fetch(`${baseUrl}/api/auth/logout-all`, {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(logoutRes.status).toBe(200);

		const [ev1, ev2] = await Promise.all([c1.waitForClose(), c2.waitForClose()]);
		expect(ev1.code).toBe(4401);
		expect(ev1.reason).toBe("signed out");
		expect(ev2.code).toBe(4401);
		expect(ev2.reason).toBe("signed out");
	});

	test("POST /api/auth/delete-account closes all sockets with code 4401 ('account deleted')", async () => {
		const { cookie } = await createAccount();
		const host = new URL(baseUrl).host;

		const client = await connectWs(`${wsBaseUrl}/api/ws?c=del-test`, {
			Cookie: cookie,
			Origin: `http://${host}`,
		});
		await client.waitForMessage("hello");

		const delRes = await fetch(`${baseUrl}/api/auth/delete-account`, {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(delRes.status).toBe(200);

		const closeEvent = await client.waitForClose();
		expect(closeEvent.code).toBe(4401);
		expect(closeEvent.reason).toBe("account deleted");
	});
});