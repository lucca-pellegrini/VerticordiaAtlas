import { esc } from "../src/shared/escape.ts";

export interface EmailContent {
	subject: string;
	html: string;
	text: string;
}

/**
 * Wraps plain-text paragraphs at `maxCols` columns (default 72).
 * Words longer than `maxCols` (such as verification/reset URLs) are placed on their own line unbroken.
 */
export function wrapPlainText72(input: string, maxCols = 72): string {
	const lines = input.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];

	for (const rawLine of lines) {
		const trimmedRight = rawLine.replace(/\s+$/, "");
		if (!trimmedRight) {
			out.push("");
			continue;
		}
		if (trimmedRight.length <= maxCols && !/\s{2,}/.test(trimmedRight)) {
			out.push(trimmedRight);
			continue;
		}
		// Preserve leading indentation (e.g. "  - ")
		const indentMatch = trimmedRight.match(/^(\s*(?:[-*]\s+)?)/);
		const firstIndent = indentMatch ? indentMatch[1] : "";
		const contIndent = " ".repeat(firstIndent.length);
		const words = trimmedRight.slice(firstIndent.length).trim().split(/\s+/);

		let current = firstIndent;
		for (const word of words) {
			if (!word) continue;
			if (current === firstIndent) {
				current += word;
			} else if (current.length + 1 + word.length <= maxCols) {
				current += " " + word;
			} else {
				out.push(current);
				current = contIndent + word;
			}
		}
		if (current.trim().length > 0) {
			out.push(current);
		}
	}
	return out.join("\n");
}

function renderHtmlShell(opts: {
	preheader: string;
	heading: string;
	greeting: string;
	bodyHtml: string;
	ctaLabel?: string;
	ctaUrl?: string;
	footerNote: string;
}): string {
	const ctaBlock =
		opts.ctaLabel && opts.ctaUrl
			? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0 24px 0;">
				<tr>
					<td style="border-radius: 8px; background: #e2a84b;">
						<a href="${esc(opts.ctaUrl)}" target="_blank" rel="noopener noreferrer"
							style="display: inline-block; padding: 13px 26px; font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; color: #14120e; text-decoration: none; border-radius: 8px;">
							${esc(opts.ctaLabel)}
						</a>
					</td>
				</tr>
			</table>
			<p style="margin: 0 0 20px 0; font-size: 12px; line-height: 1.6; color: #8c8478;">
				If the button above does not work, copy and paste this link into your browser:<br>
				<a href="${esc(opts.ctaUrl)}" style="color: #e2a84b; font-family: 'Red Hat Mono', ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; text-decoration: underline;">${esc(opts.ctaUrl)}</a>
			</p>`
			: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(opts.heading)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #12110f; color: #ede8df; font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #12110f; padding: 36px 16px;">
	<tr>
		<td align="center">
			<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 540px; background-color: #1b1916; border: 1px solid #2e2a24; border-radius: 14px; overflow: hidden; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);">
				<tr>
					<td style="padding: 28px 32px 18px 32px; border-bottom: 1px solid #27231e;">
						<div style="font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif; font-size: 22px; letter-spacing: 0.01em; color: #e2a84b;">
							Verticordia Atlas
						</div>
					</td>
				</tr>
				<tr>
					<td style="padding: 28px 32px 32px 32px; font-size: 15px; line-height: 1.65; color: #ede8df;">
						<h1 style="margin: 0 0 16px 0; font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 400; color: #f6f2ea;">
							${esc(opts.heading)}
						</h1>
						<p style="margin: 0 0 16px 0; color: #d8d1c5;">
							${esc(opts.greeting)}
						</p>
						${opts.bodyHtml}
						${ctaBlock}
						<hr style="border: 0; border-top: 1px solid #27231e; margin: 24px 0 16px 0;">
						<p style="margin: 0; font-size: 12px; line-height: 1.6; color: #8c8478;">
							${esc(opts.footerNote)}
						</p>
					</td>
				</tr>
			</table>
		</td>
	</tr>
</table>
</body>
</html>`;
}

export function renderVerifyEmailTemplate(params: {
	displayName: string;
	username?: string | null;
	verifyUrl: string;
	expiresHours?: number;
}): EmailContent {
	const hours = params.expiresHours ?? 6;
	const name = params.displayName || params.username || "Explorer";
	const subject = "Verify your email address — Verticordia Atlas";
	const handleNote = params.username ? ` (@${params.username})` : "";

	const text = wrapPlainText72(
		[
			"Verticordia Atlas",
			"=================",
			"",
			`Hello ${name}${handleNote},`,
			"",
			"Welcome to Verticordia Atlas. Please confirm your email address to activate your account and sign in.",
			"",
			"Open the link below to verify your email address:",
			"",
			params.verifyUrl,
			"",
			`This verification link expires in ${hours} hours and can only be used once.`,
			"",
			"If you did not create an account on Verticordia Atlas, you can safely ignore this message.",
		].join("\n"),
	);

	const html = renderHtmlShell({
		preheader: `Confirm your email address for Verticordia Atlas (valid for ${hours} hours).`,
		heading: "Confirm your email address",
		greeting: `Hello ${name}${handleNote},`,
		bodyHtml: `<p style="margin: 0 0 14px 0; color: #d8d1c5;">
			Welcome to <strong>Verticordia Atlas</strong>. Please verify your email address to finish setting up your account and enable cross-device map synchronization.
		</p>
		<p style="margin: 0; color: #b5ad9f; font-size: 14px;">
			This verification link is valid for <strong>${hours} hours</strong> and can only be used once.
		</p>`,
		ctaLabel: "Verify email address",
		ctaUrl: params.verifyUrl,
		footerNote:
			"If you did not create an account on Verticordia Atlas, no action is needed and you can safely ignore this email.",
	});

	return { subject, html, text };
}

export function renderResetPasswordTemplate(params: {
	displayName: string;
	resetUrl: string;
	expiresMinutes?: number;
}): EmailContent {
	const minutes = params.expiresMinutes ?? 20;
	const name = params.displayName || "Explorer";
	const subject = "Reset your password — Verticordia Atlas";

	const text = wrapPlainText72(
		[
			"Verticordia Atlas",
			"=================",
			"",
			`Hello ${name},`,
			"",
			"We received a request to reset the password for your Verticordia Atlas account.",
			"",
			"Use the link below to choose a new password:",
			"",
			params.resetUrl,
			"",
			`For your security, this password reset link expires in ${minutes} minutes and can only be used once.`,
			"",
			"If you did not request a password reset, you can safely ignore this email. Your current password will remain unchanged.",
		].join("\n"),
	);

	const html = renderHtmlShell({
		preheader: `Reset your Verticordia Atlas password (link expires in ${minutes} minutes).`,
		heading: "Reset your password",
		greeting: `Hello ${name},`,
		bodyHtml: `<p style="margin: 0 0 14px 0; color: #d8d1c5;">
			We received a request to reset the password for your Verticordia Atlas account. Click the button below to choose a new password.
		</p>
		<p style="margin: 0; color: #b5ad9f; font-size: 14px;">
			For your security, this link expires in <strong>${minutes} minutes</strong> and can only be used once.
		</p>`,
		ctaLabel: "Choose a new password",
		ctaUrl: params.resetUrl,
		footerNote:
			"If you did not request a password reset, you can safely ignore this message and your password will remain unchanged.",
	});

	return { subject, html, text };
}

export function renderChangeEmailTemplate(params: {
	displayName: string;
	newEmail: string;
	verifyUrl: string;
	expiresHours?: number;
}): EmailContent {
	const hours = params.expiresHours ?? 6;
	const name = params.displayName || "Explorer";
	const subject = "Confirm your email address — Verticordia Atlas";

	const text = wrapPlainText72(
		[
			"Verticordia Atlas",
			"=================",
			"",
			`Hello ${name},`,
			"",
			`You requested to add or verify the email address ${params.newEmail} on your Verticordia Atlas account.`,
			"",
			"Open the link below to confirm this email address:",
			"",
			params.verifyUrl,
			"",
			`This confirmation link expires in ${hours} hours and can only be used once.`,
			"",
			"If you did not request this change, please ignore this message.",
		].join("\n"),
	);

	const html = renderHtmlShell({
		preheader: `Confirm ${params.newEmail} for your Verticordia Atlas account.`,
		heading: "Confirm your email address",
		greeting: `Hello ${name},`,
		bodyHtml: `<p style="margin: 0 0 14px 0; color: #d8d1c5;">
			You requested to add and verify <strong style="color: #f6f2ea;">${esc(params.newEmail)}</strong> on your Verticordia Atlas account.
		</p>
		<p style="margin: 0; color: #b5ad9f; font-size: 14px;">
			This confirmation link expires in <strong>${hours} hours</strong> and can only be used once.
		</p>`,
		ctaLabel: "Confirm email address",
		ctaUrl: params.verifyUrl,
		footerNote: "If you did not request this change on Verticordia Atlas, you can safely ignore this email.",
	});

	return { subject, html, text };
}

export function renderSecurityNotificationTemplate(params: {
	displayName: string;
	eventTitle: string;
	eventDescription: string;
	accountUrl?: string;
	timestampIso?: string;
}): EmailContent {
	const name = params.displayName || "Explorer";
	const when = params.timestampIso || new Date().toISOString();
	const subject = `Security alert: ${params.eventTitle} — Verticordia Atlas`;

	const textLines = [
		"Verticordia Atlas",
		"=================",
		"",
		`Hello ${name},`,
		"",
		`Security notification: ${params.eventTitle}`,
		"",
		params.eventDescription,
		"",
		`Time (UTC): ${when}`,
	];
	if (params.accountUrl) {
		textLines.push("", "Review your account settings:", "", params.accountUrl);
	}
	textLines.push(
		"",
		"If you made this change, no further action is needed. If you do not recognize this activity, please reset your password immediately.",
	);

	const text = wrapPlainText72(textLines.join("\n"));

	const html = renderHtmlShell({
		preheader: `Security notice for your Verticordia Atlas account: ${params.eventTitle}`,
		heading: params.eventTitle,
		greeting: `Hello ${name},`,
		bodyHtml: `<p style="margin: 0 0 14px 0; color: #d8d1c5;">
			${esc(params.eventDescription)}
		</p>
		<p style="margin: 0 0 8px 0; font-size: 13px; color: #9e9689; font-family: 'Red Hat Mono', ui-monospace, SFMono-Regular, Menlo, monospace;">
			Time (UTC): ${esc(when)}
		</p>`,
		ctaLabel: params.accountUrl ? "Manage account security" : undefined,
		ctaUrl: params.accountUrl,
		footerNote:
			"If you made this change, no further action is needed. If you do not recognize this activity, please reset your password immediately.",
	});

	return { subject, html, text };
}