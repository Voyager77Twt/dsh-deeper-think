// 浏览器半侧：小闪电开关（conversation.input.right 座位）+ 设置里的「更深思考」卡片。
// 座位说明：composer 的模型选择器是 conversation.input.model（single，归 ui-model-selection 独占），
// 无法从外部注入；排列上 conversation.input.right 紧挨在模型选择器之前，因此闪电落在这里 = 位于模型名左侧。
window.__ModuleLoader__.load({
	id: "dsh-deeper-think",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		const NS = "dsh-deeper-think";
		const CSS = `
.dsh-deeper-think-seat{position:relative;display:inline-flex;align-items:center;gap:0;height:28px;padding:0 0 0 4px;margin-right:-4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;user-select:none;-webkit-user-select:none;border-radius:var(--dsw-radius-sm,6px);font-size:13px;font-weight:400;line-height:20px}
.dsh-deeper-think-seat:hover:not([data-on="true"]){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-deeper-think-label{font-family:inherit;color:var(--dsw-alias-label-primary,inherit);font-weight:500;display:none;position:absolute;right:100%;top:50%;transform:translateY(-50%);margin-right:4px;pointer-events:none;font-size:13px;line-height:20px;white-space:nowrap}
.dsh-deeper-think-seat[aria-pressed="true"] .dsh-deeper-think-label{display:block;font-weight:600;opacity:1}
.dsh-deeper-think-seat[data-on="true"]{color:var(--dsw-alias-label-primary,inherit);font-weight:500}
.dsh-deeper-think-seat[data-on="true"] .dsh-deeper-think-bolt{color:inherit}
.dsh-deeper-think-seat[data-on="true"] .dsh-deeper-think-label{display:block;color:inherit;font-weight:500;opacity:1}
.dsh-deeper-think-bolt{display:block;flex:none}
.dsh-deeper-think-seat[data-on="false"] .dsh-deeper-think-bolt{fill:none;stroke:currentColor;stroke-width:1.05}
.dsh-deeper-think-seat[data-on="true"] .dsh-deeper-think-bolt{fill:currentColor;stroke:none}
.dsh-deeper-think-bolt[data-on="false"]{fill:none;stroke:currentColor;stroke-width:1.05}
.dsh-deeper-think-seat[aria-pressed="true"] .dsh-deeper-think-bolt{color:var(--dsw-alias-label-primary,inherit)}
.dsh-deeper-think-bolt[data-on="true"]{fill:currentColor;stroke:none}
.dsh-deeper-think-card{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.6}
.dsh-deeper-think-card-head{display:flex;align-items:center;gap:6px}
.dsh-deeper-think-brain{display:block;flex:none;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-deeper-think-card h4{margin:0;font-size:13px;font-weight:600}
.dsh-deeper-think-card p{margin:0;color:var(--dsw-alias-text-secondary,inherit)}
`;
		const tagId = "dsh-deeper-think/style.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-deeper-think";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 按会话存；没有 sessionId 时退化到全局键。只存内存，重启即关。 */
		const seats = new Map();
		const keyOf = (sid) => (sid ? String(sid) : "__global__");
		const isOn = (sid) => seats.get(keyOf(sid)) === true;
		let rpc = null;
		const notifyHost = (sid, on) => {
			const body = { sessionId: keyOf(sid), on: on === true };
			try { rpc && rpc.call && rpc.call("/dsh-deeper-think", "set", body, undefined); } catch (e) {}
			try {
				// 备用通道：同一 HTTP 路由；同源 fetch 会带登录 cookie
				if (typeof fetch === "function") {
					fetch("/dsh-deeper-think/set", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}).catch(() => {});
				}
			} catch (e) {}
		};
		const setSeat = (sid, on) => {
			seats.set(keyOf(sid), on === true);
			notifyHost(sid, on === true);
			return on === true;
		};
		const toggle = (sid) => setSeat(sid, !isOn(sid));

		/** 直接改 DOM，不触发 React 重渲染（治"变灰后卡顿/需要等"）。 */
		function applyDom(el, on) {
			if (!el) return;
			el.setAttribute("data-on", on ? "true" : "false");
			el.setAttribute("aria-pressed", on ? "true" : "false");
			el.setAttribute("aria-label", on ? "更深的思考：已开启（将大幅增加消耗与等待时间）" : "更深的思考：已关闭");
			el.title = on
				? "更深的思考（点击关闭）\n这将大幅增加消耗与等待时间"
				: "更深的思考（点击开启）\n这将大幅增加消耗与等待时间";
			try {
				const svg = el.querySelector && el.querySelector("svg");
				if (svg) svg.setAttribute("data-on", on ? "true" : "false");
			} catch (e) {}
		}

		/** 把模型选择键的颜色/字体复制过来，避免继承到 dimmed 灰。 */
		function inheritLook(el) {
			try {
				const box = el && el.parentElement;
				const ref = box && box.querySelector('[class*="_trigger"]');
				const cs = ref && window.getComputedStyle(ref);
				if (cs) {
					el.style.fontFamily = cs.fontFamily;   // 只对齐字体；颜色用 primary（深色）
				}
			} catch (e) {}
		}

		function Bolt(props) {
			return react.createElement(
				"svg",
				{
					className: "dsh-deeper-think-bolt",
					"data-on": props.on ? "true" : "false",
					width: 16,
					height: 16,
					viewBox: "0 0 16 16",
					"aria-hidden": "true",
				},
				react.createElement("path", {
					d: "M9.2 1.5 3.8 9h3.1l-.9 5.5L12.4 7H9.1l.1-5.5Z",
					strokeLinejoin: "round",
				}),
			);
		}

		/** composer 座位：闪电；开启后文字从左侧出现（消耗更多token）。 */
		function LightningSeat(props) {
			const sessionId = props && props.sessionId;
			const on = isOn(sessionId);
			const ref = react.useRef ? react.useRef(null) : { current: null };
			const mount = () => {
				applyDom(ref.current, isOn(sessionId));
				inheritLook(ref.current);
			};
			if (react.useEffect) react.useEffect(mount, []);
			const click = () => {
				const next = toggle(sessionId);
				applyDom(ref.current, next);
				if (props && typeof props.onChange === "function") props.onChange(next);
			};
			return react.createElement(
				"button",
				{
					ref,
					type: "button",
					className: "dsh-deeper-think-seat",
					"aria-pressed": on ? "true" : "false",
					"data-on": on ? "true" : "false",
					"aria-label": on ? "更深的思考：已开启（将大幅增加消耗与等待时间）" : "更深的思考：已关闭",
					title: on
						? "更深的思考（点击关闭）\n这将大幅增加消耗与等待时间"
						: "更深的思考（点击开启）\n这将大幅增加消耗与等待时间",
					"data-session": sessionId || "",
					onClick: click,
				},
				react.createElement("span", { className: "dsh-deeper-think-label" }, "消耗更多token"),
				react.createElement(Bolt, { on }),
			);
		}

		/** 大脑图标（自绘，16×16 线性，风格对齐 primitives：1.05 描边、currentColor）。 */
		function BrainIcon() {
			return react.createElement(
				"svg",
				{
					className: "dsh-deeper-think-brain",
					width: 18,
					height: 18,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
				},
				react.createElement("path", {
					d: "M8 3.1c-1.8 0-3.2 1.1-3.4 2.6-1.2.3-1.9 1.3-1.8 2.4-.3 1.1.4 2.1 1.5 2.4.2 1.1 1.2 1.9 2.4 1.9.4.4 1 .4 1.3 0 1.2 0 2.2-.8 2.4-1.9 1.1-.3 1.8-1.3 1.5-2.4.1-1.1-.6-2.1-1.8-2.4C11.2 4.2 9.8 3.1 8 3.1Z",
					stroke: "currentColor",
					strokeWidth: 1.05,
					strokeLinejoin: "round",
				}),
				react.createElement("path", {
					d: "M8 3.2v9.1",
					stroke: "currentColor",
					strokeWidth: 1.05,
				}),
				react.createElement("path", {
					d: "M6.1 5.5c.7.5.7 1.3 0 1.8M9.9 5.7c-.7.5-.7 1.3 0 1.8M5.3 9.1c.7.2 1.2.7 1.4 1.4M10.7 9.1c-.7.2-1.2.7-1.4 1.4",
					stroke: "currentColor",
					strokeWidth: 1.05,
					strokeLinecap: "round",
				}),
			);
		}

		/** 设置页卡片：解释这个开关做什么。 */
		function SettingsCard() {
			return react.createElement(
				"div",
				{ className: "dsh-deeper-think-card" },
				react.createElement(
					"div",
					{ className: "dsh-deeper-think-card-head" },
					react.createElement(BrainIcon, null),
					react.createElement("h4", null, "更深思考"),
				),
				react.createElement(
					"p",
					null,
					"接入后，这一轮会先做三件事：① 扫描边界（八维：范围/量词/例外/优先级/格式/单位/口径/隐含依赖）；" +
						"② 找参照并造判据（每条判据必须能指出具体元素、可被改坏、有来源）；③ 交边界报告与验收包。",
				),
				react.createElement(
					"p",
					null,
					"当前版本：开关与说明已上线；协议钩子（每步提醒 / 写产物前闸门 / 回合末校验）尚未接入宿主，" +
						"因此开启后暂时不改变模型行为。",
				),
				react.createElement(
					"p",
					null,
					"开关按会话保存于内存：刷新或重启 DSH 即关闭；本轮对话结束后不会自动关闭。",
				),
				react.createElement(
					"p",
					null,
					"位置：composer 里模型选择器左侧的小闪电。空心＝关，实心＝开。",
				),
			);
		}

		/** 从会话槽位拿到 sessionId，并把状态映射进组件 props。 */
		function seatInject(sessionId) {
			return { sessionId, on: isOn(sessionId) };
		}

		const disposers = [];

		function apply(ctx) {
			try { const conn = ctx.get && ctx.get("connection"); if (conn && conn.rpc) rpc = conn.rpc; } catch (e) {}
			// 幂等：重复 apply（HMR/重载）时先释放旧注册，避免出现两个按钮
			while (disposers.length) {
				try { disposers.pop()(); } catch (e) {}
			}
			ctx.slots.inject("conversation.input.right", () =>
				disposers.push(ctx.slots.register(
					{
						name: "conversation.input.right",
						id: "dsh-deeper-think",
						order: 90,
						locale: NS,
						inject: seatInject,
					},
					LightningSeat,
				)),
			);
			// 设置里的顶层标签（与"通用/模型/账号/插件市场"并列）
			ctx.slots.inject("settings.section", () =>
				disposers.push(ctx.slots.register(
					{
						name: "settings.section",
						id: "deeper-think",
						order: 60,
						label: () => "更深思考",
						inject: () => ({}),
					},
					SettingsCard,
				)),
			);
		}

		exports.apply = apply;
		exports.inject = ["slots", "connection"];
		exports.applyDom = applyDom;
		exports.isOn = isOn;
		exports.toggle = toggle;
		exports.LightningSeat = LightningSeat;
		exports.SettingsCard = SettingsCard;
		return module.exports;
	},
});
