// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";

export class BridgeResponse extends PassThrough {
	statusCode = 200;
	headersSent = false;
	resHeaders = new Headers();
	private _headEmitted = false;

	ensureHead() {
		if (!this._headEmitted) {
			this._headEmitted = true;
			this.emit("head");
		}
	}

	writeHead(code: number, headers?: any) {
		this.statusCode = code;
		if (headers) {
			for (const [k, v] of Object.entries(headers)) {
				if (Array.isArray(v)) for (const it of v) this.resHeaders.append(k, it);
				else this.resHeaders.set(k, String(v));
			}
		}
		this.headersSent = true;
		this.ensureHead();
		return this;
	}

	setHeader(name: string, value: any) {
		if (Array.isArray(value)) {
			this.resHeaders.delete(name);
			for (const it of value) this.resHeaders.append(name, it);
		} else {
			this.resHeaders.set(name, String(value));
		}
		return this;
	}

	appendHeader(name: string, value: any) {
		this.resHeaders.append(name, String(value));
		return this;
	}

	getHeader(name: string) {
		return this.resHeaders.get(name);
	}

	override write(chunk: any, ...args: any[]): boolean {
		this.headersSent = true;
		this.ensureHead();
		return super.write(chunk, ...args);
	}

	override end(chunk?: any, ...args: any[]): this {
		this.headersSent = true;
		this.ensureHead();
		return super.end(chunk, ...args);
	}
}

export function nodeBridge(
	listener: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: Request) => Promise<Response> {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const reqStream = new Readable({ read() {} });
		const inReq = Object.assign(reqStream, {
			url: url.pathname + url.search,
			method: req.method,
			headers: Object.fromEntries(req.headers.entries()),
			socket: {
				encrypted: url.protocol === "https:",
				remoteAddress: "127.0.0.1",
				destroy() {},
			},
		}) as unknown as IncomingMessage;

		const outRes = new BridgeResponse() as unknown as ServerResponse & BridgeResponse;

		const responsePromise = new Promise<Response>((resolve) => {
			outRes.once("head", () => {
				resolve(new Response(outRes as any, { status: outRes.statusCode, headers: outRes.resHeaders }));
			});
		});

		(async () => {
			try {
				if (req.body) {
					const reader = req.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						reqStream.push(value);
					}
				}
				reqStream.push(null);
			} catch (err) {
				reqStream.destroy(err as any);
			}
		})();

		Promise.resolve(listener(inReq, outRes)).catch((err) => {
			console.error("listener error:", err);
			if (!outRes.headersSent) {
				outRes.writeHead(500, { "Content-Type": "text/plain" });
				outRes.end("server error");
			}
		});

		return responsePromise;
	};
}