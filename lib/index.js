/**
 * dsh-chatgpt2api-image — host half.
 *
 * A DeepSeek Harness plugin that exposes one model tool, `generate_image`,
 * backed by a self-hosted chatgpt2api service (OpenAI-compatible image API).
 *
 * Structure follows dsh-agnes-multimodal (MIT, original author 啾灵jiuling):
 *   - one state file in $DSH_HOME, one fenced config API, one tool
 *   - generated PNGs ride to the UI as durable `image` blocks with
 *     `offloaded: true`, so the model context stays text-only while the
 *     conversation UI still renders the picture
 *   - the client half (lib/client.js) provides the settings page and the
 *     image card; the host half below provides the config API and the tool
 *
 * Differences from the Agnes plugin (deliberate, v1 scope):
 *   - NO video tool: chatgpt2api has no video endpoint
 *   - NO built-in/demo key: an unconfigured plugin refuses to run and tells
 *     the user to fill in their own endpoint + key on the settings page
 *   - Text-to-image goes to POST /v1/images/generations (verified against
 *     a self-hosted chatgpt2api 1.9.5-fixed service)
 *   - Image editing goes to POST /v1/images/edits (standard OpenAI
 *     multipart shape). This path has NOT yet been verified against a
 *     self-hosted chatgpt2api service — if the server rejects it, the tool
 *     surfaces the server error instead of silently ignoring the image.
 *   - `upstream_verification_required` (chatgpt2api's fail-closed
 *     verification error) is never retried: retrying cannot pass it.
 *
 * State file: $DSH_HOME/chatgpt2api-image.json
 *   { "accounts": [{ "endpoint": ".../v1", "key": "...", "model": "gpt-image-2" }] }
 *
 * Host API (POST JSON to /chatgpt2api/api, loopback/trusted-origin only):
 *   { "method": "get" }                                   → { ok:true, value:{...} }
 *   { "method": "set", "patch": { "accounts": [...] } }    → { ok:true }
 *   { "method": "test", "payload": { "endpoint", "key" } } → { ok:true|false, reason }
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-chatgpt2api-image";

/** Services required before mounting: tool registry, web routes, trust fence host list. */
export const inject = ["tools", "webServer", "webRuntime"];

const STATE_FILENAME = "chatgpt2api-image.json";
const LOG_FILENAME = "chatgpt2api-image.log";
const API_PREFIX = "/chatgpt2api/api";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** No default endpoint is shipped: the user must fill in their own
 * chatgpt2api service address on the settings page. Empty here means
 * "no preset" — legacy/single-account shapes without an endpoint are
 * treated as unconfigured rather than falling back to someone's server. */
const DEFAULT_ENDPOINT = "";
const DEFAULT_MODEL = "gpt-image-2";
const MODELS = ["gpt-image-2", "gpt-image-2.5"];

/** Sizes the chatgpt2api image API accepts for gpt-image-2/2.5 (plus "auto"). */
const SIZES = ["auto", "1024x1024", "1024x1536", "1536x1024", "1536x864", "864x1536"];
const QUALITIES = ["auto", "low", "medium", "high"];

// ── paths / state ────────────────────────────────────────────────────────────

function dshHome() {
	return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");
}

function statePath() {
	return join(dshHome(), STATE_FILENAME);
}

function readState() {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeState(state) {
	const file = statePath();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	const body = JSON.stringify(state);
	writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(tmp, file);
	} catch {
		writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
	}
}

/** Diagnostics only. Keys are never written to the log. */
function appendLog(record) {
	try {
		appendFileSync(join(dshHome(), LOG_FILENAME), JSON.stringify(record) + "\n", "utf8");
	} catch {
		// diagnostics must never break generation
	}
}

function normalizeAccount(a) {
	if (a === null || typeof a !== "object") return null;
	if (typeof a.endpoint !== "string" || typeof a.key !== "string") return null;
	const endpoint = a.endpoint.trim().replace(/\/+$/, "");
	const key = a.key.trim();
	if (endpoint.length === 0 || key.length === 0) return null;
	const model = typeof a.model === "string" && MODELS.includes(a.model) ? a.model : DEFAULT_MODEL;
	return { endpoint, key, model };
}

/**
 * Configured accounts, or [] when nothing is configured. Unlike the Agnes
 * plugin there is intentionally no shared demo key to fall back to: a
 * stranger's key would bill someone else's ChatGPT account.
 */
function readAccounts() {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
		if (parsed !== null && typeof parsed === "object") {
			if (Array.isArray(parsed.accounts)) {
				const accounts = parsed.accounts.map(normalizeAccount).filter(Boolean);
				if (accounts.length > 0) return accounts;
			}
			// Legacy single-account shape.
			if (typeof parsed.key === "string" && parsed.key.trim().length > 0) {
				const one = normalizeAccount({
					endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : DEFAULT_ENDPOINT,
					key: parsed.key,
					model: parsed.model,
				});
				if (one) return [one];
			}
		}
	} catch {
		// file absent or corrupt — no accounts
	}
	return [];
}

function endpointRoot(endpoint) {
	return endpoint.replace(/\/v1\/?$/, "");
}

// ── trust fence (loopback / configured authority + same-origin markers) ─────

function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
	return (trustedHosts || []).some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// ── JSON body / response helpers ─────────────────────────────────────────────

const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
				resolve(PAYLOAD_TOO_LARGE);
				return;
			}
			if (!aborted) chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

function writeJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

// ── shared HTTP + media helpers ──────────────────────────────────────────────

async function fetchJson(url, options, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const text = await response.text();
		let body;
		try { body = JSON.parse(text); } catch { body = undefined; }
		return { response, body, text };
	} finally {
		clearTimeout(timer);
	}
}

function mimeFor(file) {
	const ext = extname(file).toLowerCase();
	return ({
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".png": "image/png",
		".webp": "image/webp",
		".gif": "image/gif",
	})[ext] || "image/png";
}

/**
 * Resolve one media entry to a data URI the API accepts.
 * URL / data URI pass through; a 64-hex sha256 resolves against the durable
 * attachment store; anything else is tried as a local path. Unresolved values
 * are returned unchanged so the API can report the real error.
 */
function resolveMediaToDataUri(value, cwd) {
	if (typeof value !== "string" || value.length === 0) return value;
	if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:")) return value;
	const candidates = [];
	const match = value.match(/([0-9a-fA-F]{64})/);
	if (match !== null) {
		candidates.push(join(dshHome(), "attachments", "v1", "objects", match[1].slice(0, 2), match[1]));
	}
	candidates.push(resolve(cwd, value));
	for (const file of candidates) {
		try {
			const bytes = readFileSync(file);
			return `data:${mimeFor(file)};base64,${bytes.toString("base64")}`;
		} catch {
			// try the next candidate
		}
	}
	return value;
}

/** Resolve one media entry to bytes, for the multipart edits endpoint. Returns null when unresolvable. */
async function resolveMediaToBuffer(value, cwd) {
	if (typeof value !== "string" || value.length === 0) return null;
	if (value.startsWith("data:")) {
		const comma = value.indexOf(",");
		if (comma < 0) return null;
		const mime = value.slice(5, comma).split(";")[0] || "image/png";
		return { buffer: Buffer.from(value.slice(comma + 1), "base64"), mime, filename: "reference.png" };
	}
	if (value.startsWith("http://") || value.startsWith("https://")) {
		try {
			const res = await fetch(value);
			if (!res.ok) return null;
			const mime = (res.headers.get("content-type") || "image/png").split(";")[0];
			return { buffer: Buffer.from(await res.arrayBuffer()), mime, filename: "reference.png" };
		} catch {
			return null;
		}
	}
	const candidates = [];
	const match = value.match(/([0-9a-fA-F]{64})/);
	if (match !== null) {
		candidates.push(join(dshHome(), "attachments", "v1", "objects", match[1].slice(0, 2), match[1]));
	}
	candidates.push(resolve(cwd, value));
	for (const file of candidates) {
		try {
			return { buffer: readFileSync(file), mime: mimeFor(file), filename: file.split(/[\\/]/).pop() || "reference.png" };
		} catch {
			// try the next candidate
		}
	}
	return null;
}

/** chatgpt2api returns image URLs as server-relative paths (e.g. /images/2026/...png). Resolve them against the endpoint root. */
function resolveDownloadUrl(itemUrl, endpoint) {
	if (itemUrl.startsWith("http://") || itemUrl.startsWith("https://")) return itemUrl;
	const root = endpointRoot(endpoint);
	return itemUrl.startsWith("/") ? root + itemUrl : root + "/" + itemUrl;
}

function roundRobin(pool) {
	let i = 0;
	return () => {
		const account = pool[i % pool.length];
		i += 1;
		return account;
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── config API ───────────────────────────────────────────────────────────────

async function probeAccount(endpoint, key) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20000);
	try {
		const response = await fetch(endpoint.replace(/\/+$/, "") + "/models", {
			headers: { Authorization: `Bearer ${key}` },
			signal: controller.signal,
		});
		if (response.status === 200) return { ok: true, httpStatus: 200, reason: "ok" };
		if (response.status === 401 || response.status === 403) return { ok: false, httpStatus: response.status, reason: "invalid" };
		return { ok: false, httpStatus: response.status, reason: "other" };
	} catch {
		return { ok: false, httpStatus: -1, reason: "network" };
	} finally {
		clearTimeout(timer);
	}
}

async function handleApi(req, res) {
	if (req.method !== "POST") {
		writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
		return;
	}
	const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].toLowerCase() : "";
	if (!contentType.startsWith("application/json")) {
		writeJson(res, 415, { ok: false, error: { code: "unsupported-media-type", message: "content-type must be application/json" } });
		return;
	}
	const payload = await readJsonBody(req);
	if (payload === PAYLOAD_TOO_LARGE) {
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "request body too large" } });
		return;
	}
	if (payload === null || typeof payload !== "object" || typeof payload.method !== "string") {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "bad request" } });
		return;
	}
	if (payload.method === "get") {
		writeJson(res, 200, { ok: true, value: readState() });
		return;
	}
	if (payload.method === "set") {
		const patch = payload.patch;
		if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "patch must be a plain object" } });
			return;
		}
		const next = readState();
		if (Array.isArray(patch.accounts)) {
			next.accounts = patch.accounts.map(normalizeAccount).filter(Boolean);
		} else if (typeof patch.key === "string") {
			// Single-account convenience shape from the settings page.
			const one = normalizeAccount({
				endpoint: typeof patch.endpoint === "string" ? patch.endpoint : DEFAULT_ENDPOINT,
				key: patch.key,
				model: patch.model,
			});
			next.accounts = one ? [one] : [];
		}
		writeState(next);
		writeJson(res, 200, { ok: true });
		return;
	}
	if (payload.method === "test") {
		const target = payload.payload;
		if (target === null || typeof target !== "object" || typeof target.endpoint !== "string" || typeof target.key !== "string") {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "payload must be { endpoint, key }" } });
			return;
		}
		writeJson(res, 200, await probeAccount(target.endpoint, target.key));
		return;
	}
	writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown method "${payload.method}"` } });
}

// ── image tool ───────────────────────────────────────────────────────────────

function registerImageTool(ctx) {
	/** One generation/edit attempt against one account. Returns a result record, never throws for HTTP errors. */
	const attempt = async (prompt, idx, account, args, cwd, images) => {
		const model = (typeof args.model === "string" && MODELS.includes(args.model)) ? args.model : account.model;
		const size = (typeof args.size === "string" && SIZES.includes(args.size)) ? args.size : "auto";
		const quality = (typeof args.quality === "string" && QUALITIES.includes(args.quality)) ? args.quality : undefined;
		const base = account.endpoint.replace(/\/+$/, "");
		const headers = { Authorization: `Bearer ${account.key}` };

		let url;
		let options;
		if (images.length > 0) {
			// Standard OpenAI multipart edits shape.
			const buffers = [];
			for (const value of images) {
				const resolved = await resolveMediaToBuffer(value, cwd);
				if (resolved === null) return { ok: false, status: 0, message: `无法读取参考图: ${String(value).slice(0, 80)}` };
				buffers.push(resolved);
			}
			const form = new FormData();
			for (const b of buffers) form.append("image", new Blob([b.buffer], { type: b.mime }), b.filename);
			form.append("prompt", prompt);
			form.append("model", model);
			if (size !== "auto") form.append("size", size);
			if (quality !== undefined) form.append("quality", quality);
			url = base + "/images/edits";
			options = { method: "POST", headers, body: form };
		} else {
			const bodyObj = { model, prompt, n: 1 };
			if (size !== "auto") bodyObj.size = size;
			if (quality !== undefined) bodyObj.quality = quality;
			url = base + "/images/generations";
			options = {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(bodyObj),
			};
		}

		const { response, body, text } = await fetchJson(url, options, 360000);
		if (!response.ok) {
			const code = body?.error?.code;
			return {
				ok: false,
				status: response.status,
				code: typeof code === "string" ? code : undefined,
				message: body?.error?.message || text.slice(0, 500),
			};
		}
		const item = Array.isArray(body?.data) ? body.data[0] : undefined;
		if (item === undefined) return { ok: false, status: 0, message: "Unexpected API response" };
		const task = body.task_id || body.created || `image-${Date.now()}-${idx}`;
		const file = join(cwd, `${task}.png`);
		if (item.url) {
			const downloadUrl = resolveDownloadUrl(item.url, account.endpoint);
			const download = await fetch(downloadUrl, { headers });
			if (!download.ok) return { ok: false, status: download.status, message: "download failed" };
			writeFileSync(file, Buffer.from(await download.arrayBuffer()));
		} else if (item.b64_json) {
			writeFileSync(file, Buffer.from(item.b64_json, "base64"));
		} else {
			return { ok: false, status: 0, message: "no url or b64 in response" };
		}
		return { ok: true, status: 0, url: item.url || "", task_id: String(task), file };
	};

	ctx.tools.register({
		name: "generate_image",
		description:
			"Generate or edit images with a self-hosted chatgpt2api service (gpt-image-2 / gpt-image-2.5). "
			+ "prompt is an array of instructions — each generates one image. "
			+ "WHEN THE USER ATTACHES/SENDS AN IMAGE AND ASKS TO MODIFY, TRANSFORM, STYLE-TRANSFER, OR COMBINE IT: "
			+ "this tool DOES support image editing — pass the user's image in the image parameter. "
			+ "The user's attached image appears in your context as 'Image sha256:<64-hex>'; "
			+ "put that 64-character hex value into the image parameter (the plugin resolves it automatically). "
			+ "You may also pass a local file path, a public HTTPS URL, or a data-URI base64 as an image entry. "
			+ "Images are displayed in the conversation UI by default (cached locally); pass show=false only for very large batches to skip display. "
			+ "The generated images are shown to the USER in the UI, never to you: "
			+ "the tool result returns only plain text — a success note plus each requested prompt. "
			+ "Do not echo image URLs, base64, or binary data into the conversation; "
			+ "when you summarize the result, describe the images according to the requested prompts.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				prompt: {
					type: "array",
					items: { type: "string" },
					description: "Array of image description prompts. Each prompt generates one image. English recommended for best results. For img2img or multi-image composition, describe the desired transformation or combination.",
				},
				model: {
					type: "string",
					enum: MODELS,
					description: "Image model. Default: the model saved on the settings page (gpt-image-2 unless changed).",
				},
				size: {
					type: "string",
					enum: SIZES,
					description: "Output size: auto (default), or an exact WxH size such as 1024x1024, 1024x1536, 1536x1024.",
				},
				quality: {
					type: "string",
					enum: QUALITIES,
					description: "Rendering effort: auto (default), low, medium, high. Higher costs more upstream tokens.",
				},
				image: {
					type: "array",
					items: { type: "string" },
					description: "Reference images for image editing (1 image: transform/style-transfer) or multi-image composition (2+ images: combine). Each entry: the 64-char sha256 hex of a user-attached image (from 'Image sha256:...' in the user message), a local file path, a public HTTPS URL, or a data-URI base64. Optional.",
				},
				show: {
					type: "boolean",
					description: "When false, skip caching/displaying the images (default: true — images are shown in the conversation UI).",
				},
			},
			required: ["prompt"],
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					results: {
						type: "array",
						description: "Array of generated image results.",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								url: { type: "string", description: "Remote URL of the generated image." },
								task_id: { type: "string", description: "chatgpt2api task id." },
								localPath: { type: "string", description: "Workspace path of the downloaded PNG (only when show=true)." },
								attachmentRef: { type: "object", description: "Attachment ref for conversation display (only when show=true)." },
							},
						},
					},
				},
			},
			// The generated PNG rides along as a real `image` content block, which
			// is the only thing the Web Client renders. `offloaded: true` keeps the
			// model context text-only: the request projection replaces the block
			// with placeholder text, while the Web Client ignores the flag and
			// still displays the image. No hand-written PNG route is needed.
			render: (args, value) => {
				const prompts = Array.isArray(args.prompt) ? args.prompt : [args.prompt];
				const results = Array.isArray(value.results) ? value.results : [value];
				const blocks = [];
				results.forEach((r, i) => {
					const line = "[chatgpt2api-image] Image " + (i + 1) + "/" + results.length + " generated successfully.\nRequested prompt: " + prompts[i];
					blocks.push({ type: "text", text: r && r.localPath ? line + "\nlocalPath: " + r.localPath : line });
					if (r && r.attachmentRef) blocks.push({ type: "image", attachment: r.attachmentRef, offloaded: true });
				});
				return blocks;
			},
		},

		async execute(args, exec) {
			const prompts = (Array.isArray(args.prompt) ? args.prompt : [args.prompt])
				.map((p) => (p === null || p === undefined ? "" : String(p)))
				.filter((p) => p.trim().length > 0);
			if (prompts.length === 0) throw new Error("prompt required");
			const show = args.show !== false;
			const images = Array.isArray(args.image)
				? args.image.filter((x) => typeof x === "string" && x.length > 0)
				: [];
			const accounts = readAccounts();
			if (accounts.length === 0) {
				throw new Error("尚未配置 chatgpt2api 账号：请先到 设置 → ChatGPT 生图 填写端点与密钥，再新开一个对话重试。");
			}
			const policy = ctx.get("sandboxPolicy");
			const cwd = policy !== undefined && policy.workspaceRoot ? policy.workspaceRoot : process.cwd();
			const fs = ctx.get("fs");
			const attachments = ctx.get("attachments");
			const aborted = () => exec.signal !== undefined && exec.signal.aborted;
			const nextAcc = roundRobin(accounts);

			const results = [];
			for (let idx = 0; idx < prompts.length; idx++) {
				if (aborted()) throw new Error("Image generation cancelled");
				const prompt = prompts[idx];
				let lastError = null;
				let done = null;
				// Sequential on purpose: one ChatGPT Plus account, one quota pool.
				// 429s get a short backoff; 401 and upstream_verification_required
				// fail fast — retrying cannot fix either.
				for (let a = 1; a <= 3; a++) {
					const acc = nextAcc();
					let result;
					try {
						result = await attempt(prompt, idx, acc, args, cwd, images);
					} catch (error) {
						result = { ok: false, status: -1, message: "throw: " + (error && error.message ? error.message : String(error)) };
					}
					appendLog({ t: new Date().toISOString(), phase: "image", idx, endpoint: acc.endpoint, status: result.status, ok: result.ok === true, msg: result.message || "", attempt: a });
					if (result.ok === true) {
						const response = { task_id: result.task_id };
						if (result.url) response.url = result.url;
						if (show && result.file) {
							if (fs === undefined || attachments === undefined) throw new Error("fs/attachments service not available");
							const target = await fs.resolve(result.file);
							const bytes = await fs.readBytes(target, exec.signal, 20971520);
							const ref = await attachments.saveImage({ data: bytes, mediaType: "image/png", name: "generated_image_" + idx + ".png" });
							response.attachmentRef = ref;
							response.localPath = result.file;
						}
						done = response;
						break;
					}
					lastError = result;
					if (result.status === 401) {
						throw new Error("chatgpt2api 密钥无效 (401)：请到 设置 → ChatGPT 生图 检查密钥是否填对。");
					}
					if (result.code === "upstream_verification_required" || (typeof result.message === "string" && result.message.includes("upstream_verification_required"))) {
						throw new Error("服务端要求交互验证 (upstream_verification_required)：chatgpt2api 的网页通道需要人工完成一次验证后才能继续生图，重试不会通过。请先在 chatgpt2api 面板里确认账号状态，或稍后再试。");
					}
					if (a < 3) await sleep(2000 * a);
				}
				if (done === null) {
					throw new Error(`第 ${idx + 1} 张图生成失败: ${lastError ? lastError.message : "unknown error"}`);
				}
				results.push(done);
			}
			return { results };
		},
	});
}

// ── entry ────────────────────────────────────────────────────────────────────

export function apply(ctx) {
	// Config API: account read/write + key probe.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			try {
				await handleApi(req, res);
			} catch (error) {
				console.error("[dsh-chatgpt2api-image] config API error:", error);
				writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
			}
		},
	}), "dsh-chatgpt2api-image: config API routes");

	registerImageTool(ctx);
}
