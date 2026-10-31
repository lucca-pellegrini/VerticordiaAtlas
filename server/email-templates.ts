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
	let hostLabel = "atlas.verticordia.com";
	let homeUrl = "https://atlas.verticordia.com:11680";
	if (opts.ctaUrl) {
		try {
			const u = new URL(opts.ctaUrl);
			hostLabel = u.host;
			homeUrl = u.origin;
		} catch {
			/* fallback to default */
		}
	}

	const ctaBlock =
		opts.ctaLabel && opts.ctaUrl
			? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0 24px 0;">
				<tr>
					<td align="center" style="border-radius: 8px; background-color: #d6453b;">
						<!--[if mso]>
						<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(opts.ctaUrl)}" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="18%" fillcolor="#d6453b" stroke="f">
							<w:anchorlock/>
							<center style="color:#ffffff;font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:600;">
								${esc(opts.ctaLabel)}
							</center>
						</v:roundrect>
						<![endif]-->
						<!--[if !mso]><!-- -->
						<a href="${esc(opts.ctaUrl)}" target="_blank" rel="noopener noreferrer" class="email-btn"
							style="display: inline-block; padding: 13px 28px; font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff !important; text-decoration: none; border-radius: 8px; background-color: #d6453b; letter-spacing: 0.01em;">
							${esc(opts.ctaLabel)}
						</a>
						<!--<![endif]-->
					</td>
				</tr>
			</table>
			<p class="email-dim" style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #9aa6ad;">
				If the button above does not work, copy and paste this link into your browser:
			</p>
			<div class="email-code-box" style="padding: 12px 14px; background-color: #181e22; border: 1px solid #252d33; border-radius: 6px; font-family: 'Red Hat Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #f0877d; word-break: break-all;">
				<a href="${esc(opts.ctaUrl)}" class="email-fallback-link" style="color: #f0877d; text-decoration: none; word-break: break-all;">${esc(opts.ctaUrl)}</a>
			</div>`
			: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(opts.heading)}</title>
<style>
	:root {
		color-scheme: light dark;
		supported-color-schemes: light dark;
	}
	@media (prefers-color-scheme: light) {
		body, .email-bg {
			background-color: #f6f4f0 !important;
			color: #14171a !important;
		}
		.email-card {
			background-color: #ffffff !important;
			border-color: #e4dfd7 !important;
			box-shadow: 0 8px 30px rgba(20, 23, 26, 0.06) !important;
		}
		.email-header {
			border-bottom-color: #e4dfd7 !important;
		}
		.email-wordmark {
			color: #14171a !important;
		}
		.email-title {
			color: #14171a !important;
		}
		.email-greeting {
			color: #14171a !important;
		}
		.email-body, .email-body p, .email-body div, .email-body span {
			color: #3b4349 !important;
		}
		.email-strong, strong, b, .email-body strong, .email-subtext strong {
			color: #14171a !important;
		}
		.email-subtext, .email-subtext p, .email-subtext span {
			color: #5a636a !important;
		}
		.email-dim {
			color: #6d7880 !important;
		}
		.email-code-box {
			background-color: #fcfbf9 !important;
			border-color: #e4dfd7 !important;
			color: #bf342b !important;
		}
		.email-fallback-link {
			color: #bf342b !important;
		}
		.email-divider {
			border-top-color: #e4dfd7 !important;
		}
		.email-footer-site {
			color: #5a636a !important;
		}
	}
	@media (prefers-color-scheme: dark) {
		body, .email-bg {
			background-color: #0b0e10 !important;
			color: #eef1f3 !important;
		}
		.email-card {
			background-color: #12161a !important;
			border-color: #252d33 !important;
			box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55) !important;
		}
		.email-header {
			border-bottom-color: #252d33 !important;
		}
		.email-wordmark {
			color: #ffffff !important;
		}
		.email-title {
			color: #f6f2ea !important;
		}
		.email-greeting {
			color: #eef1f3 !important;
		}
		.email-body, .email-body p, .email-body div, .email-body span {
			color: #d2d9de !important;
		}
		.email-strong, strong, b, .email-body strong, .email-subtext strong {
			color: #ffffff !important;
		}
		.email-subtext, .email-subtext p, .email-subtext span {
			color: #9aa6ad !important;
		}
		.email-dim {
			color: #839098 !important;
		}
		.email-code-box {
			background-color: #181e22 !important;
			border-color: #252d33 !important;
			color: #f0877d !important;
		}
		.email-fallback-link {
			color: #f0877d !important;
		}
		.email-divider {
			border-top-color: #252d33 !important;
		}
		.email-footer-site {
			color: #9aa6ad !important;
		}
	}
</style>
</head>
<body class="email-bg" style="margin: 0; padding: 0; background-color: #0b0e10; color: #eef1f3; font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-bg" style="background-color: #0b0e10; padding: 36px 16px;">
	<tr>
		<td align="center">
			<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-card" style="max-width: 540px; background-color: #12161a; border: 1px solid #252d33; border-radius: 14px; overflow: hidden; box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);">
				<!-- Header with brand icon and wordmark -->
				<tr>
					<td class="email-header" style="padding: 24px 32px; border-bottom: 1px solid #252d33;">
						<table role="presentation" cellspacing="0" cellpadding="0" border="0">
							<tr>
								<td style="vertical-align: middle; padding-right: 12px;">
									<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 32px; height: 32px; border-radius: 9px; background-color: #d6453b; text-align: center;">
										<tr>
											<td align="center" valign="middle" style="width: 32px; height: 32px; text-align: center;">
												<!--[if mso]>
												<span style="color: #ffffff; font-size: 16px; font-weight: bold;">&#9679;</span>
												<![endif]-->
												<!--[if !mso]><!-- -->
												<svg width="18" height="18" viewBox="0 0 24 24" style="vertical-align: middle; display: inline-block;" aria-hidden="true">
													<path fill="#ffffff" d="M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0115 0c0 5.6-7.5 12-7.5 12z"/>
													<circle cx="12" cy="10" r="2.8" fill="#d6453b"/>
												</svg>
												<!--<![endif]-->
											</td>
										</tr>
									</table>
								</td>
								<td style="vertical-align: middle;">
									<a href="${esc(homeUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration: none;">
										<span class="email-wordmark" style="font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif; font-size: 23px; font-weight: 400; letter-spacing: 0.01em; color: #ffffff;">
											Verticordia Atlas
										</span>
									</a>
								</td>
							</tr>
						</table>
					</td>
				</tr>
				<!-- Body content -->
				<tr>
					<td style="padding: 30px 32px 34px 32px; font-size: 15px; line-height: 1.65; color: #eef1f3;">
						<h1 class="email-title" style="margin: 0 0 16px 0; font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 400; line-height: 1.3; color: #f6f2ea;">
							${esc(opts.heading)}
						</h1>
						<p class="email-greeting" style="margin: 0 0 16px 0; font-size: 15px; font-weight: 500; color: #eef1f3;">
							${esc(opts.greeting)}
						</p>
						<div class="email-body" style="font-size: 15px; line-height: 1.65; color: #d2d9de;">
							${opts.bodyHtml}
						</div>
						${ctaBlock}
						<hr class="email-divider" style="border: 0; border-top: 1px solid #252d33; margin: 26px 0 18px 0;">
						<p class="email-dim" style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #9aa6ad;">
							${esc(opts.footerNote)}
						</p>
						<p class="email-dim" style="margin: 8px 0 0 0; font-size: 11px; line-height: 1.5; color: #6b7780;">
							Sent by <strong>Verticordia Atlas</strong> · Interactive game maps and completion tracker<br>
							<a href="${esc(homeUrl)}" class="email-footer-site" style="color: #9aa6ad; text-decoration: underline;">${esc(hostLabel)}</a>
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
		bodyHtml: `<p style="margin: 0 0 14px 0;">
			Welcome to <strong>Verticordia Atlas</strong>. Please verify your email address to finish setting up your account and enable cross-device map synchronization.
		</p>
		<p class="email-subtext" style="margin: 0; font-size: 14px; color: #9aa6ad;">
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
		bodyHtml: `<p style="margin: 0 0 14px 0;">
			We received a request to reset the password for your Verticordia Atlas account. Click the button below to choose a new password.
		</p>
		<p class="email-subtext" style="margin: 0; font-size: 14px; color: #9aa6ad;">
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
		bodyHtml: `<p style="margin: 0 0 14px 0;">
			You requested to add and verify <strong>${esc(params.newEmail)}</strong> on your Verticordia Atlas account.
		</p>
		<p class="email-subtext" style="margin: 0; font-size: 14px; color: #9aa6ad;">
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
		bodyHtml: `<p style="margin: 0 0 14px 0;">
			${esc(params.eventDescription)}
		</p>
		<p class="email-subtext" style="margin: 0 0 8px 0; font-size: 13px; color: #9aa6ad; font-family: 'Red Hat Mono', ui-monospace, SFMono-Regular, Menlo, monospace;">
			Time (UTC): <strong>${esc(when)}</strong>
		</p>`,
		ctaLabel: params.accountUrl ? "Manage account security" : undefined,
		ctaUrl: params.accountUrl,
		footerNote:
			"If you made this change, no further action is needed. If you do not recognize this activity, please reset your password immediately.",
	});

	return { subject, html, text };
}