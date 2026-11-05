import fs from "node:fs";
import path from "node:path";

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

import type { EmailContent } from "./email-templates.ts";

export interface EmailMessage extends EmailContent {
	to: string;
}

export interface EmailSender {
	send(msg: EmailMessage): Promise<{ messageId?: string }>;
}

export interface SesConfig {
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	fromEmail?: string;
	fromName?: string;
	configurationSet?: string;
	endpoint?: string;
	devFallback?: boolean;
	devLogFile?: string;
	onDevLog?: (line: string) => void;
}

function parseDotEnvFile(filePath: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		if (!fs.existsSync(filePath)) return out;
		const text = fs.readFileSync(filePath, "utf8");
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq < 1) continue;
			const key = line.slice(0, eq).trim();
			let val = line.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			out[key] = val;
		}
	} catch {
		/* ignore unreadable optional env file */
	}
	return out;
}

export function loadSesConfigFromEnv(rootDir = process.cwd()): SesConfig {
	const dotEnvSes = parseDotEnvFile(path.join(rootDir, ".env.ses"));
	const pick = (key: string): string | undefined => {
		const v = process.env[key] ?? dotEnvSes[key];
		return v && v.trim() ? v.trim() : undefined;
	};
	const devFlag = pick("DEV_EMAIL_LOG");
	const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
	return {
		region: pick("SES_REGION"),
		accessKeyId: pick("SES_ACCESS_KEY_ID"),
		secretAccessKey: pick("SES_SECRET_ACCESS_KEY"),
		fromEmail: pick("SES_FROM_EMAIL"),
		fromName: pick("SES_FROM_NAME") || "Verticordia Atlas",
		configurationSet: pick("SES_CONFIGURATION_SET"),
		endpoint: pick("SES_ENDPOINT"),
		devFallback: devFlag ? devFlag !== "0" && devFlag.toLowerCase() !== "false" : !isProd,
		devLogFile: pick("DEV_EMAIL_LOG_FILE"),
	};
}

export function createDevEmailSender(opts: { log?: (line: string) => void; logFile?: string } = {}): EmailSender {
	const log = opts.log ?? ((line: string) => console.info(line));
	return {
		async send(msg: EmailMessage): Promise<{ messageId?: string }> {
			const messageId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const urls = msg.text.match(/https?:\/\/[^\s<>")]+/g) || [];
			const summary = [
				`[dev-email] To: ${msg.to} | Subject: ${msg.subject} | id: ${messageId}`,
				...urls.map((u) => `[dev-email] Action URL: ${u}`),
			].join("\n");
			log(summary);
			if (opts.logFile) {
				try {
					fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
					fs.appendFileSync(
						opts.logFile,
						`${new Date().toISOString()}\n${summary}\n\n${msg.text}\n${"-".repeat(60)}\n`,
						"utf8",
					);
				} catch {
					/* ignore optional dev log file write failures */
				}
			}
			return { messageId };
		},
	};
}

export function createSesEmailSender(cfg: SesConfig = loadSesConfigFromEnv()): EmailSender {
	let client: SESv2Client | null = null;
	const hasSesCredentials = Boolean(cfg.region && cfg.accessKeyId && cfg.secretAccessKey && cfg.fromEmail);
	const fallbackSender =
		!hasSesCredentials && cfg.devFallback
			? createDevEmailSender({ log: cfg.onDevLog, logFile: cfg.devLogFile })
			: null;

	function getClient(): SESv2Client {
		if (client) return client;
		if (!cfg.region || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.fromEmail) {
			throw new Error(
				"Amazon SES is not configured (missing SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, or SES_FROM_EMAIL).",
			);
		}
		client = new SESv2Client({
			region: cfg.region,
			...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
			credentials: {
				accessKeyId: cfg.accessKeyId,
				secretAccessKey: cfg.secretAccessKey,
			},
		});
		return client;
	}

	return {
		async send(msg: EmailMessage): Promise<{ messageId?: string }> {
			if (fallbackSender) {
				return fallbackSender.send(msg);
			}
			const ses = getClient();
			const fromAddress = cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail!;
			const cmd = new SendEmailCommand({
				FromEmailAddress: fromAddress,
				Destination: {
					ToAddresses: [msg.to],
				},
				Content: {
					Simple: {
						Subject: {
							Data: msg.subject,
							Charset: "UTF-8",
						},
						Body: {
							Text: {
								Data: msg.text,
								Charset: "UTF-8",
							},
							Html: {
								Data: msg.html,
								Charset: "UTF-8",
							},
						},
					},
				},
				...(cfg.configurationSet ? { ConfigurationSetName: cfg.configurationSet } : {}),
			});
			const res = await ses.send(cmd);
			return { messageId: res.MessageId };
		},
	};
}