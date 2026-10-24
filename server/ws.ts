// ws.ts: the little of WebSocket (RFC 6455) this site needs, without a dependency. The server only ever sends short
// text messages ("something changed, come and get it"); what clients send is read for pings and closes and then dropped.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 64 * 1024; // clients have nothing big to say: more than this closes the connection
const PING_EVERY = 25_000; // under the 60 s idle timeout reverse proxies usually have

export interface WebSocketConn {
	send(text: string): void;
	close(code?: number, reason?: string): void;
	onClose(fn: () => void): void;
	onHeartbeat(fn: () => boolean): void;
}

function frame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
	const n = payload.length;
	const head =
		n < 126
			? Buffer.from([0x80 | opcode, n])
			: n < 65536
				? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
				: (() => {
						const b = Buffer.alloc(10);
						b[0] = 0x80 | opcode;
						b[1] = 127;
						b.writeBigUInt64BE(BigInt(n), 2);
						return b;
					})();
	return Buffer.concat([head, payload]);
}

/* Completes the handshake on an upgraded socket and returns a connection, or null when the request is not a valid
   WebSocket handshake (nothing has been written then). */
export function acceptWebSocket(
	req: IncomingMessage,
	socket: Duplex & { setNoDelay?: (noDelay?: boolean) => void; setTimeout?: (msecs: number) => void },
	head?: Buffer,
): WebSocketConn | null {
	const key = req.headers["sec-websocket-key"];
	if (!key || req.headers["sec-websocket-version"] !== "13") return null;
	const accept = crypto
		.createHash("sha1")
		.update(key + GUID)
		.digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	socket.setNoDelay?.(true);
	socket.setTimeout?.(0);

	let buf: Buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
	let alive = true,
		closed = false,
		closeHandler = () => {},
		heartbeat = () => true;

	const conn: WebSocketConn = {
		send(text: string) {
			if (!closed && socket.writable) socket.write(frame(0x1, Buffer.from(String(text))));
		},
		close(code = 1000, reason = "") {
			if (closed) return;
			closed = true;
			const r = Buffer.from(String(reason).slice(0, 100));
			const p = Buffer.alloc(2 + r.length);
			p.writeUInt16BE(code, 0);
			r.copy(p, 2);
			try {
				socket.end(frame(0x8, p));
			} catch {
				/* already gone */
			}
			setTimeout(() => socket.destroy(), 2000).unref(); // the client has two seconds to answer the close
		},
		onClose(fn: () => void) {
			closeHandler = fn;
		},
		onHeartbeat(fn: () => boolean) {
			heartbeat = fn;
		}, // called with each ping round; false closes the connection
	};

	function read() {
		while (buf.length >= 2) {
			const op = buf[0] & 0x0f,
				masked = (buf[1] & 0x80) !== 0;
			let len = buf[1] & 0x7f,
				off = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				const big = buf.readBigUInt64BE(2);
				if (big > BigInt(MAX_FRAME)) return conn.close(1009, "too big");
				len = Number(big);
				off = 10;
			}
			if (!masked) return conn.close(1002, "client frames must be masked");
			if (len > MAX_FRAME) return conn.close(1009, "too big");
			if (buf.length < off + 4 + len) return; // the rest has not arrived yet
			const mask = buf.subarray(off, off + 4);
			const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
			for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
			buf = buf.subarray(off + 4 + len);
			alive = true;
			if (op === 0x8) {
				// close: answer in kind
				if (!closed) {
					closed = true;
					try {
						socket.end(frame(0x8, data.subarray(0, 2)));
					} catch {
						/* gone */
					}
				}
				return;
			}
			if (op === 0x9) {
				if (!closed) socket.write(frame(0xa, data.subarray(0, 125)));
				continue;
			} // ping: pong
			// pongs, text and binary: nothing to do beyond having proved the client is there
		}
	}

	socket.on("data", (chunk: Buffer) => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
		read();
	});
	const timer = setInterval(() => {
		if (closed) return;
		if (!alive) return socket.destroy(); // no answer to the last ping: the connection is dead
		if (heartbeat() === false) return conn.close(4401, "signed out");
		alive = false;
		socket.write(frame(0x9));
	}, PING_EVERY);
	timer.unref();
	let gone = false;
	const done = () => {
		clearInterval(timer);
		if (gone) return;
		gone = true;
		closed = true;
		closeHandler();
	};
	socket.on("close", done);
	socket.on("error", () => socket.destroy());
	if (buf.length) read();
	return conn;
}