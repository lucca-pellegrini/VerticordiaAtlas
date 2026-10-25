// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// secret-key.ts: Crockford Base32 secret keys for anonymous sync accounts.
// Keys consist of a 128-bit random payload (26 data symbols, canonical with lowest 2 bits zero)
// and 4 check symbols (payload mod 1048573, prime just under 2^20) scattered as:
// XXXX-XXXX-CXXX-XXXX-XXXX-CXXX-XXXX-CC (30 characters total across 8 groups).

export const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const B32_MAP: Record<string, number> = Object.fromEntries(Array.from(B32).map((c, i) => [c, i]));

export const SECRET_PAYLOAD_CHARS = 26;
export const SECRET_CHECK_CHARS = 4;
export const SECRET_TOTAL_CHARS = 30;
export const SECRET_CHECKSUM_MODULUS = 1048573n;

// Check character indices in unhyphenated 30-character string
export const CHECK_INDICES = [8, 20, 28, 29] as const;
// Data character indices in unhyphenated 30-character string
export const DATA_INDICES = [
	0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27,
] as const;

// Normalizes human input: uppercase, lookalikes O->0, I/L->1, U->V, and drops other non-alphanumeric noise
export function normalizeSecret(s: unknown): string {
	return String(s || "")
		.toUpperCase()
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1")
		.replace(/U/g, "V")
		.replace(/[^0-9A-Z]/g, "");
}

// Extracts up to 30 normalized characters
export function cleanSecretChars(input: string): string {
	return normalizeSecret(input).slice(0, SECRET_TOTAL_CHARS);
}

// Formats characters into 4-character hyphen-separated groups (final group has up to 2 characters)
export function formatSecretKey(raw: string): string {
	const clean = cleanSecretChars(raw);
	const parts: string[] = [];
	for (let i = 0; i < clean.length; i += 4) {
		parts.push(clean.slice(i, i + 4));
	}
	return parts.join("-");
}

export type SecretValidationResult = { valid: true; normalized: string } | { valid: false; error: string };

// Validates secret key format, canonical encoding, and prime-modulus checksum
export function validateSecretKey(raw: unknown): SecretValidationResult {
	const norm = normalizeSecret(raw);
	if (norm.length !== SECRET_TOTAL_CHARS) {
		return {
			valid: false,
			error: `Key must be ${SECRET_TOTAL_CHARS} characters (${norm.length}/${SECRET_TOTAL_CHARS} entered)`,
		};
	}
	for (let i = 0; i < norm.length; i++) {
		if (!(norm[i] in B32_MAP)) {
			return { valid: false, error: `Invalid character '${norm[i]}' in secret key` };
		}
	}

	const c25 = B32_MAP[norm[DATA_INDICES[25]]];
	if ((c25 & 3) !== 0) {
		return { valid: false, error: "Invalid secret key (non-canonical encoding)" };
	}

	let num = 0n;
	for (let i = 0; i < 25; i++) {
		num = (num << 5n) | BigInt(B32_MAP[norm[DATA_INDICES[i]]]);
	}
	num = (num << 3n) | BigInt(c25 >> 2);

	const expectedRem = Number(num % SECRET_CHECKSUM_MODULUS);
	const actualRem =
		(B32_MAP[norm[8]] << 15) | (B32_MAP[norm[20]] << 10) | (B32_MAP[norm[28]] << 5) | B32_MAP[norm[29]];

	if (actualRem >= 1048573 || actualRem !== expectedRem) {
		return { valid: false, error: "Typo detected in secret key (checksum mismatch)" };
	}

	return { valid: true, normalized: norm };
}

// Encodes a 16-byte buffer into a 30-character unhyphenated secret string with scattered checksum
export function encodeSecret(bytes: Uint8Array): string {
	if (bytes.length !== 16) throw new Error("Secret payload must be 16 bytes");
	let bits = 0,
		value = 0,
		d = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			d += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) d += B32[(value << (5 - bits)) & 31];

	let num = 0n;
	for (const b of bytes) {
		num = (num << 8n) | BigInt(b);
	}
	const rem = Number(num % SECRET_CHECKSUM_MODULUS);
	const c0 = B32[(rem >>> 15) & 31];
	const c1 = B32[(rem >>> 10) & 31];
	const c2 = B32[(rem >>> 5) & 31];
	const c3 = B32[rem & 31];

	const s = new Array<string>(SECRET_TOTAL_CHARS);
	s[8] = c0;
	s[20] = c1;
	s[28] = c2;
	s[29] = c3;
	for (let i = 0; i < 26; i++) {
		s[DATA_INDICES[i]] = d[i];
	}
	return s.join("");
}

// Formats a 30-character secret into 8 hyphenated groups (7 groups of 4 and 1 group of 2)
export function formatSecret(raw30: string): string {
	return raw30.match(/.{1,4}/g)!.join("-");
}