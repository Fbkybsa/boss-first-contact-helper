"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mount, KEY } = require("../extension/floating_panel.js");

function fixture(options = {}) {
  const callbacks = new Map();
  const writes = [];
  const classes = new Set();
  function node() {
    return { hidden: false, attrs: {}, handlers: {}, setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn, capture = false) { (this.handlers[type] ||= []).push({ fn, capture }); },
      emit(type, values = {}) {
        const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10,
          detail: 1, target: this, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...values };
        for (const h of [...(this.handlers[type] || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
          h.fn(event); if (event.stopped) break;
        }
        return event;
      }, closest() { return null; }, setPointerCapture() {}, releasePointerCapture() {} };
  }
  const header = node(), body = node(), minimize = node(), mini = node();
  const env = { innerWidth: 1000, innerHeight: 800,
    addEventListener(type, callback) { callbacks.set(type, callback); },
    chrome: { storage: { local: {
      get: () => options.get ? options.get() : Promise.resolve(options.saved ? { [KEY]: options.saved } : {}),
      set: (value) => { writes.push(value[KEY]); return options.failSave ? Promise.reject(Error("unavailable")) : Promise.resolve(); },
    } } },
  };
  const panel = { style: {}, classList: { toggle(k, value) { if (value) classes.add(k); else classes.delete(k); } },
    querySelector(s) { return ({ ".bt-panel-header": header, "#bt-panel-body": body, "#bt-minimize": minimize, "#bt-mini": mini })[s]; },
    getBoundingClientRect() { return { left: 682, top: 88,
      width: classes.has("bt-collapsed") ? 100 : Math.min(300, env.innerWidth - 24),
      height: classes.has("bt-collapsed") ? 42 : 260 }; } };
  const controller = mount(panel, env);
  function fire(type, values = {}) { callbacks.get(type)?.({ pointerId: 1, clientX: 10, clientY: 10, preventDefault() {}, ...values }); }
  function drag(handle, dx, dy) { handle.emit("pointerdown"); fire("pointermove", { clientX: 10 + dx, clientY: 10 + dy }); fire("pointerup"); }
  return { controller, env, panel, header, body, minimize, mini, fire, drag, writes };
}

test("收起只隐藏展示，点击小按钮恢复并保存状态", () => {
  const f = fixture();
  f.minimize.emit("click");
  assert.equal(f.body.hidden, true);
  assert.equal(f.mini.hidden, false);
  assert.equal(f.controller.getState().collapsed, true);
  f.mini.emit("click");
  assert.equal(f.body.hidden, false);
  assert.equal(f.mini.attrs["aria-expanded"], "true");
  assert.equal(f.writes.at(-1).collapsed, false);
});
test("大小形态都可拖动，小按钮拖动结束不误展开", () => {
  const f = fixture();
  f.drag(f.header, -200, 100);
  assert.deepEqual(f.controller.getState(), { x: 482, y: 188, collapsed: false });
  f.minimize.emit("click"); f.drag(f.mini, -100, 50);
  assert.equal(f.mini.emit("click").stopped, true);
  assert.deepEqual(f.controller.getState(), { x: 382, y: 238, collapsed: true });
  f.mini.emit("pointerdown"); f.fire("pointerup"); f.mini.emit("click");
  assert.equal(f.controller.getState().collapsed, false);
});
test("小幅移动仍视为点击；键盘展开不被上次拖动抑制", () => {
  const f = fixture(); f.minimize.emit("click"); f.drag(f.mini, 2, 2); f.mini.emit("click");
  assert.equal(f.controller.getState().collapsed, false);
  f.minimize.emit("click"); f.drag(f.mini, 20, 20); f.mini.emit("click", { detail: 0 });
  assert.equal(f.controller.getState().collapsed, false);
});
test("按钮交互、右键及非主指针不启动拖动", () => {
  const f = fixture(); const before = f.controller.getState();
  for (const values of [{ button: 2 }, { isPrimary: false }, { target: { closest: () => ({}) } }]) {
    f.header.emit("pointerdown", values); f.fire("pointermove", { clientX: 400 }); f.fire("pointerup");
    assert.deepEqual(f.controller.getState(), before);
  }
});
test("拖动与展开限制在视口，窗口缩小后自动回到可见区", () => {
  const f = fixture(); f.drag(f.header, -5000, -5000);
  assert.equal(f.controller.getState().x, 8); assert.equal(f.controller.getState().y, 8);
  f.minimize.emit("click"); f.drag(f.mini, 5000, 5000);
  assert.equal(f.controller.getState().x, 892);
  f.mini.emit("click", { detail: 0 });
  assert.equal(f.controller.getState().x, 692); assert.equal(f.controller.getState().y, 532);
  f.env.innerWidth = 400; f.env.innerHeight = 400; f.fire("resize");
  assert.equal(f.controller.getState().x, 92); assert.equal(f.controller.getState().y, 132);
});
test("刷新恢复大小形态和位置，旧屏幕坐标会重新限位", async () => {
  const f = fixture({ saved: { x: 9000, y: -20, collapsed: true } }); await Promise.resolve();
  assert.deepEqual(f.controller.getState(), { x: 892, y: 8, collapsed: true });
});
test("延迟读取设置不会覆盖用户刚刚完成的操作", async () => {
  let resolve; const f = fixture({ get: () => new Promise(r => { resolve = r; }) });
  f.minimize.emit("click"); resolve({ [KEY]: { x: 20, y: 30, collapsed: false } }); await Promise.resolve();
  assert.equal(f.controller.getState().collapsed, true); assert.equal(f.controller.getState().x, 682);
});
test("取消拖动或窗口失焦后停止跟随，其他指针不会改变位置", () => {
  const f = fixture(); f.header.emit("pointerdown"); f.fire("pointermove", { pointerId: 2, clientX: 500 });
  assert.equal(f.controller.getState().x, 682);
  f.fire("pointercancel"); f.fire("pointermove", { clientX: 500 }); assert.equal(f.controller.getState().x, 682);
  f.header.emit("pointerdown"); f.fire("blur"); f.fire("pointermove", { clientX: 500 });
  assert.equal(f.controller.getState().x, 682);
});
test("存储失败或损坏不影响收起和拖动", async () => {
  const f = fixture({ saved: { x: "invalid", y: 2 }, failSave: true }); await Promise.resolve();
  f.minimize.emit("click"); f.drag(f.mini, -100, 0); await Promise.resolve();
  assert.equal(f.controller.getState().collapsed, true); assert.equal(f.controller.getState().x, 582);
});
