import { confusablesMap } from "confusables";
import { caseFold } from "unicode-case-folding";

const MIN_USERNAME_LEN = 2;
const MAX_USERNAME_LEN = 20;
const MIN_DISPLAY_NAME_LEN = 1;
const MAX_DISPLAY_NAME_LEN = 40;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_BYTES = 256;

// Forbidden characters in usernames: control, format (zero-width, bidi), surrogates, private-use, symbols, emoji
const FORBIDDEN_USERNAME_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{S}\p{Extended_Pictographic}]/u;
// Allowed pattern: starts with XID_Start, continues with XID_Continue or '.', '_', '-'
const XID_USERNAME_RE = /^\p{XID_Start}[\p{XID_Continue}._-]*$/u;
// Combining mark without a letter/number base (e.g. at start or right after punctuation)
const UNBASED_MARK_RE = /(?:^|[._-])\p{M}/u;
// Trailing or consecutive punctuation separators
const BAD_SEPARATOR_RE = /[._-]{2}|[._-]$/u;

// Forbidden characters in display names: control, format/bidi/zero-width, surrogates, private-use, line/paragraph breaks
const FORBIDDEN_DISPLAY_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const LEADING_MARK_RE = /^\p{M}|(?:\s)\p{M}/u;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;

/**
 * Full Unicode case-folding after NFC normalization.
 */
export function foldUnicode(input: string): string {
	return caseFold(input.normalize("NFC"));
}

/**
 * Computes a UTS #39-style confusable skeleton for a username or identifier:
 * 1. NFC normalize + full Unicode case-fold
 * 2. Map confusable characters via confusablesMap
 * 3. Re-normalize to NFC (in case base + mark became a precomposed Latin accented char) and map again
 * 4. Strip Latin combining diacritical marks (\u0300-\u036f) and fold l/I/1 and 0/o homoglyphs
 * 5. Case-fold the final skeleton string
 */
export function confusableSkeleton(input: string): string {
	const folded = foldUnicode(input);
	let pass1 = "";
	for (const ch of folded) {
		pass1 += confusablesMap.get(ch) ?? ch;
	}
	const nfc2 = pass1.normalize("NFC");
	let pass2 = "";
	for (const ch of nfc2) {
		pass2 += confusablesMap.get(ch) ?? ch;
	}
	const stripped = pass2
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.normalize("NFC");
	return caseFold(stripped).replace(/1/g, "l").replace(/0/g, "o");
}

export type UsernameValidationResult =
	{ valid: true; username: string; folded: string; skeleton: string } | { valid: false; error: string };

export function validateUsername(raw: unknown): UsernameValidationResult {
	if (typeof raw !== "string") {
		return { valid: false, error: "Username is required." };
	}
	const nfc = raw.normalize("NFC");
	if (!nfc) {
		return { valid: false, error: "Username is required." };
	}
	if (/\p{White_Space}/u.test(nfc)) {
		return { valid: false, error: "Username cannot contain spaces or whitespace." };
	}
	const codePoints = [...nfc];
	if (codePoints.length < MIN_USERNAME_LEN || codePoints.length > MAX_USERNAME_LEN) {
		return {
			valid: false,
			error: `Username must be between ${MIN_USERNAME_LEN} and ${MAX_USERNAME_LEN} characters.`,
		};
	}
	if (FORBIDDEN_USERNAME_RE.test(nfc)) {
		return {
			valid: false,
			error: "Username cannot contain emoji, symbols, or invisible formatting characters.",
		};
	}
	if (UNBASED_MARK_RE.test(nfc)) {
		return {
			valid: false,
			error: "Username cannot contain combining marks without a base letter.",
		};
	}
	if (!XID_USERNAME_RE.test(nfc)) {
		return {
			valid: false,
			error: "Username must start with a letter and contain only letters, digits, periods, hyphens, or underscores.",
		};
	}
	if (BAD_SEPARATOR_RE.test(nfc)) {
		return {
			valid: false,
			error: "Username cannot end with or contain consecutive periods, hyphens, or underscores.",
		};
	}
	const folded = foldUnicode(nfc);
	const skeleton = confusableSkeleton(nfc);
	return { valid: true, username: nfc, folded, skeleton };
}

export type DisplayNameValidationResult = { valid: true; displayName: string } | { valid: false; error: string };

export function validateDisplayName(raw: unknown): DisplayNameValidationResult {
	if (typeof raw !== "string") {
		return { valid: false, error: "Display name is required." };
	}
	const nfc = raw
		.normalize("NFC")
		.replace(/\p{White_Space}+/gu, " ")
		.trim();
	if (!nfc) {
		return { valid: false, error: "Display name cannot be empty." };
	}
	const codePoints = [...nfc];
	if (codePoints.length < MIN_DISPLAY_NAME_LEN || codePoints.length > MAX_DISPLAY_NAME_LEN) {
		return {
			valid: false,
			error: `Display name must be between ${MIN_DISPLAY_NAME_LEN} and ${MAX_DISPLAY_NAME_LEN} characters.`,
		};
	}
	if (FORBIDDEN_DISPLAY_RE.test(nfc)) {
		return {
			valid: false,
			error: "Display name cannot contain control or invisible formatting characters.",
		};
	}
	if (LEADING_MARK_RE.test(nfc)) {
		return {
			valid: false,
			error: "Display name cannot contain unattached combining marks.",
		};
	}
	return { valid: true, displayName: nfc };
}

export type EmailValidationResult =
	{ valid: true; email: string; normalized: string } | { valid: false; error: string };

export function validateEmail(raw: unknown): EmailValidationResult {
	if (typeof raw !== "string") {
		return { valid: false, error: "Email address is required." };
	}
	const email = raw.trim().normalize("NFC");
	if (!email || email.length > 254 || /[\p{Cc}\p{Cf}\p{White_Space}]/u.test(email) || !EMAIL_RE.test(email)) {
		return { valid: false, error: "Please enter a valid email address." };
	}
	const atIdx = email.lastIndexOf("@");
	if (atIdx < 1 || atIdx > 64) {
		return { valid: false, error: "Please enter a valid email address." };
	}
	return { valid: true, email, normalized: foldUnicode(email) };
}

export type PasswordValidationResult = { valid: true; password: string } | { valid: false; error: string };

export function validatePassword(raw: unknown): PasswordValidationResult {
	if (typeof raw !== "string") {
		return { valid: false, error: "Password is required." };
	}
	const len = [...raw].length;
	if (len < MIN_PASSWORD_LEN) {
		return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LEN} characters long.` };
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_PASSWORD_BYTES) {
		return { valid: false, error: "Password is too long." };
	}
	return { valid: true, password: raw };
}