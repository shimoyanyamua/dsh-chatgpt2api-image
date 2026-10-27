// dsh-chatgpt2api-image — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-chatgpt2api-image/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table. The `id` below MUST equal the
// package name, or the shell reports "loaded without registering".
//
// This bundle carries:
//   1. 设置 → ChatGPT 生图 (settings.section) — endpoint + key + model,
//      persisted through the fenced host API to $DSH_HOME/chatgpt2api-image.json.
//   2. generate_image 卡片 (tool.call.toolview key=generate_image) — renders
//      the durable image blocks from the tool result through the shell's
//      session-authorized `loadImage` prop. Tool views do not manage
//      attachment URLs themselves.
//   3. 折叠区外的图片投递 (conversation.chat.turnTail) — repeats the Turn's
//      generated images below the reply once the process region folds shut.
//
// Media never reaches the model: generated images ride along as `image`
// blocks flagged `offloaded`, which the request projection replaces with
// placeholder text, so the model context stays text-only while the UI
// still renders them.

window.__ModuleLoader__.load({
	id: "dsh-chatgpt2api-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;

		exports.inject = ["slots", "sessions", "uiConversation"];

		exports.apply = function apply(ctx) {
			var API_URL = "/chatgpt2api/api";
			// No preset endpoint: the settings page starts empty and the
			// user fills in their own chatgpt2api service address.
			var DEFAULT_ENDPOINT = "";
			var MODELS = ["gpt-image-2", "gpt-image-2.5"];
			var NAV_LABEL = "ChatGPT 生图";
			var CONVERSATION_NS = "conversation";

			// ── stylesheet ──
			ctx.effect(function() {
				var style = document.createElement("style");
				style.textContent = `
.cg-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 28px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.cg-page-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.cg-page-desc{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.cg-field{display:flex;flex-direction:column;gap:6px}
.cg-label{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.cg-input{padding:8px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace}
.cg-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f46e5)}
.cg-btn{padding:7px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}
.cg-btn:hover:not(:disabled){background:rgba(128,128,128,.12)}
.cg-btn:disabled{opacity:.45;cursor:default}
.cg-btn-primary{border:none;background:var(--dsw-alias-brand-primary,#4f46e5);color:#fff;padding:8px 18px;font-size:13px}
.cg-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4f46e5);opacity:.9}
.cg-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.cg-hint{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.cg-ok{color:var(--dsw-alias-state-success-primary,#2ea043)}
.cg-bad{color:rgba(255,80,80,.9)}
.cg-media{display:flex;flex-direction:column;gap:9px}
.cg-media-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.cg-chip{font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(128,128,128,.14);color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.cg-gallery{display:flex;flex-wrap:wrap;gap:10px;max-width:100%}
.cg-frame{border:.5px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.35));border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));cursor:zoom-in;flex:none;place-items:center;min-width:44px;min-height:44px;padding:0;display:grid;overflow:hidden}
.cg-frame[data-variant=tile]{width:64px;min-width:64px;height:64px;min-height:64px}
.cg-frame[data-variant=single]{max-height:520px;max-width:100%}
.cg-frame[data-variant=single] img{object-fit:contain;width:auto;height:auto;max-width:100%;max-height:520px}
.cg-frame img{object-fit:cover;width:100%;height:100%;display:block}
.cg-loading{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75));font-size:12px;line-height:18px}
.cg-err{font-size:12px;color:rgba(255,80,80,.9)}
.cg-lb{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.82);display:grid;place-items:center;cursor:zoom-out}
.cg-lb-img{max-width:92vw;max-height:92vh;object-fit:contain;display:block;cursor:default}
.cg-tail{display:flex;flex-direction:column;gap:8px;min-width:0;padding:2px 0}
`;
				document.head.appendChild(style);
				return function() { document.head.removeChild(style); };
			});

			// ── helpers ──
			function apiCall(body) {
				return fetch(API_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}).then(function(r) { return r.json(); });
			}

			function textOf(content) {
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					return content.map(function(c) {
						return c && typeof c.text === "string" ? c.text : "";
					}).join("");
				}
				return "";
			}

			function imageRefs(block) {
				if (!block || !Array.isArray(block.content)) return [];
				var out = [];
				for (var i = 0; i < block.content.length; i++) {
					var c = block.content[i];
					if (c && c.type === "image" && c.attachment) out.push(c.attachment);
				}
				return out;
			}

			// ── 1. settings page ──
			function ConfigPanel() {
				var endpointState = React.useState(DEFAULT_ENDPOINT);
				var endpoint = endpointState[0];
				var setEndpoint = endpointState[1];
				var keyState = React.useState("");
				var key = keyState[0];
				var setKey = keyState[1];
				var modelState = React.useState(MODELS[0]);
				var model = modelState[0];
				var setModel = modelState[1];
				var statusState = React.useState("");
				var status = statusState[0];
				var setStatus = statusState[1];
				var busyState = React.useState(false);
				var busy = busyState[0];
				var setBusy = busyState[1];

				React.useEffect(function() {
					apiCall({ method: "get" }).then(function(res) {
						if (res && res.ok && res.value && Array.isArray(res.value.accounts) && res.value.accounts.length > 0) {
							var a = res.value.accounts[0];
							if (a.endpoint) setEndpoint(a.endpoint);
							if (a.key) setKey(a.key);
							if (a.model) setModel(a.model);
						}
					}, function() {});
				}, []);

				function onSave() {
					if (!key.trim()) { setStatus("请先填写密钥。"); return; }
					setBusy(true);
					setStatus("正在保存…");
					apiCall({ method: "set", patch: { accounts: [{ endpoint: endpoint.trim(), key: key.trim(), model: model }] } }).then(function(res) {
						setBusy(false);
						setStatus(res && res.ok ? "已保存。改配置后请新开一个对话再试生图。" : "保存失败，请看服务端日志。");
					}, function() { setBusy(false); setStatus("保存失败：无法连接配置接口。"); });
				}

				function onTest() {
					if (!key.trim()) { setStatus("请先填写密钥。"); return; }
					setBusy(true);
					setStatus("正在测试…（GET /models，零成本）");
					apiCall({ method: "test", payload: { endpoint: endpoint.trim(), key: key.trim() } }).then(function(res) {
						setBusy(false);
						if (res && res.ok) setStatus("测试通过：密钥有效。");
						else if (res && res.reason === "invalid") setStatus("测试失败：密钥无效（401/403），请检查密钥与端点是否匹配。");
						else if (res && res.reason === "network") setStatus("测试失败：连不上端点，请检查端点地址与网络。");
						else setStatus("测试失败：服务端返回 " + (res ? res.httpStatus : "?") + "。");
					}, function() { setBusy(false); setStatus("测试失败：无法连接配置接口。"); });
				}

				return h("div", { className: "cg-root" },
					h("h2", { className: "cg-page-title" }, NAV_LABEL),
					h("p", { className: "cg-page-desc" }, "把你自己的 chatgpt2api 服务接进来。密钥只存在本机 $DSH_HOME/chatgpt2api-image.json（0600 权限），不会发给任何第三方。没有演示密钥：不填就用不了。"),
					h("div", { className: "cg-field" },
						h("span", { className: "cg-label" }, "端点（Base URL，带 /v1）"),
						h("input", { className: "cg-input", value: endpoint, onChange: function(e) { setEndpoint(e.target.value); }, placeholder: "http://你的服务器地址:3000/v1（带 /v1）" })
					),
					h("div", { className: "cg-field" },
						h("span", { className: "cg-label" }, "密钥（chatgpt2api 的 auth-key）"),
						h("input", { className: "cg-input", type: "password", value: key, onChange: function(e) { setKey(e.target.value); }, placeholder: "填 chatgpt2api 配置里的密钥" })
					),
					h("div", { className: "cg-field" },
						h("span", { className: "cg-label" }, "默认模型"),
						h("select", { className: "cg-input", value: model, onChange: function(e) { setModel(e.target.value); } },
							MODELS.map(function(m) { return h("option", { key: m, value: m }, m); })
						)
					),
					h("div", { className: "cg-actions" },
						h("button", { className: "cg-btn cg-btn-primary", disabled: busy, onClick: onSave }, "保存"),
						h("button", { className: "cg-btn", disabled: busy, onClick: onTest }, "测试")
					),
					status ? h("div", { className: "cg-hint" }, status) : null,
					h("p", { className: "cg-hint" }, "注意：不要和 dsh-agnes-multimodal 同时启用，两者都注册了 generate_image，工具名会冲突。")
				);
			}

			// ── 2. image card ──
			function MediaImage(props) {
				var ref = props.image;
				var load = props.load;
				var variant = props.variant;
				var openState = React.useState(false);
				var open = openState[0];
				var setOpen = openState[1];
				var urlState = React.useState(function() {
					return typeof load.peek === "function" ? load.peek(ref) || null : null;
				});
				var url = urlState[0];
				var setUrl = urlState[1];
				var errState = React.useState(false);
				var failed = errState[0];
				var setFailed = errState[1];
				var tryState = React.useState(0);
				var attempt = tryState[0];
				var setAttempt = tryState[1];

				React.useEffect(function() {
					var live = true;
					setFailed(false);
					setUrl(typeof load.peek === "function" ? load.peek(ref) || null : null);
					Promise.resolve(load(ref)).then(function(next) {
						if (live) setUrl(next);
					}, function() {
						if (live) setFailed(true);
					});
					return function() { live = false; };
				}, [ref, load, attempt]);

				if (failed) {
					return h("button", {
						type: "button",
						className: "cg-err",
						title: "图片加载失败，点击重试",
						onClick: function() { setAttempt(function(a) { return a + 1; }); },
					}, "图片加载失败，点击重试");
				}
				var label = ref.name || "生成的图片";
				var frame = h("button", {
					type: "button",
					className: "cg-frame",
					"data-variant": variant,
					title: url === null ? "加载中…" : "点击查看原图",
					onClick: function() { if (url !== null) setOpen(true); },
				}, url === null
					? h("span", { className: "cg-loading" }, "加载中…")
					: h("img", { src: url, alt: label })
				);
				if (!open || url === null) return frame;
				return h(React.Fragment, null,
					frame,
					h("div", { className: "cg-lb", onClick: function() { setOpen(false); } },
						h("img", { className: "cg-lb-img", src: url, alt: label })
					)
				);
			}

			function MediaGallery(props) {
				var images = props.images;
				var load = props.load;
				if (images.length === 0) return null;
				var variant = images.length > 1 ? "tile" : "single";
				return h("div", { className: "cg-gallery" },
					images.map(function(ref, i) {
						return h(MediaImage, { image: ref, load: load, variant: variant, key: (ref.attachmentId || i) + ":" + i });
					})
				);
			}

			function ImageCard(props) {
				// Keyed tool views are dispatched with `phase` plus a stage-specific
				// `block`, and only the `result` stage carries the tool result. The
				// view mounts while the call is still `preparing`, so nothing may be
				// decided from the block at mount time.
				var block = props.phase === "result" ? props.block : null;
				if (props.phase !== "result") {
					return h("span", { className: "cg-loading" }, "正在生成图片…");
				}
				if (block && block.isError) {
					var errText = textOf(block.content).trim();
					return h("span", { className: "cg-err" }, "图片生成失败" + (errText ? "：" + errText.slice(0, 300) : ""));
				}
				var refs = imageRefs(block);
				if (refs.length === 0) {
					return h("span", { className: "cg-hint" }, "本次未生成可预览的图片");
				}
				if (typeof props.loadImage !== "function") {
					return h("span", { className: "cg-hint" }, "图片加载器不可用");
				}
				return h("div", { className: "cg-media" },
					h("div", { className: "cg-media-head" },
						h("span", null, "图片生成"),
						h("span", { className: "cg-chip" }, String(refs.length) + " 张")
					),
					h(MediaGallery, { images: refs, load: props.loadImage })
				);
			}

			// ── 3. turn-tail delivery ──
			function generatedImages(nodes) {
				if (!Array.isArray(nodes)) return [];
				var out = [];
				for (var i = 0; i < nodes.length; i++) {
					var root = nodes[i] ? nodes[i].root : null;
					if (!root || root.kind !== "tool-result" || root.isError) continue;
					if (!root.call || root.call.name !== "generate_image") continue;
					var found = imageRefs(root);
					for (var j = 0; j < found.length; j++) out.push(found[j]);
				}
				return out;
			}

			function GeneratedImageTail(props) {
				var turn = props.turn;
				if (!turn || typeof props.useTurnMedia !== "function") return null;
				var nodes = props.useTurnMedia(String(turn.turn));
				var refs = generatedImages(nodes);
				if (refs.length === 0 || typeof props.loadImage !== "function") return null;
				return h("div", { className: "cg-tail" },
					h(MediaGallery, { images: refs, load: props.loadImage })
				);
			}

			// ── registration ──
			ctx.slots.inject("settings.section", function() {
				return ctx.slots.register({
					name: "settings.section",
					id: "chatgpt2api-image",
					order: 200,
					label: NAV_LABEL,
				}, ConfigPanel);
			});

			// This entry deliberately declares no `children`. `tool.call.images`
			// already has its spec declared by the built-in `read_image` row, and
			// `slots.register` rejects a second declaration of the same child,
			// which would abort this whole client half. The card renders the
			// durable image through the `loadImage` loader the shell hands to
			// every tool view instead.
			ctx.slots.inject("tool.call.toolview", function() {
				return ctx.slots.register({
					name: "tool.call.toolview",
					key: "generate_image",
					locale: CONVERSATION_NS,
				}, ImageCard);
			});

			ctx.slots.inject("conversation.chat.turnTail", function() {
				return ctx.slots.register({
					name: "conversation.chat.turnTail",
					id: "chatgpt2api-image",
					inject: function(sessionId) {
						try {
							var binding = ctx.sessions.binding(sessionId);
							if (binding === void 0) return {};
							var chat = ctx.uiConversation.binding(binding).target("chat");
							return {
								keyedHooks: {
									turnMedia: function(turn) {
										var snapshot = chat.getSnapshot();
										if (snapshot === void 0) return [];
										return snapshot.nodes.turnDataSource(Number(turn), "tool-call");
									},
								},
								loadImage: Object.assign(
									function(attachment) { return ctx.uiConversation.imageUrl(sessionId, attachment); },
									{ peek: function(attachment) { return ctx.uiConversation.peekImageUrl(sessionId, attachment); } }
								),
							};
						} catch (e) {
							return {};
						}
					},
				}, GeneratedImageTail);
			});
		};

		return module.exports;
	},
});
