/* Presentation only: never reads conversations or sends messages. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BTFloatingPanel = api;
})(globalThis, function () {
  "use strict";
  const KEY = "bt-first-contact-panel-layout-v1";

  function clamp(x, y, width, height, viewportWidth, viewportHeight) {
    const margin = 8;
    return {
      x: Math.max(0, Math.min(Math.max(margin, x), Math.max(0, viewportWidth - width - margin))),
      y: Math.max(0, Math.min(Math.max(margin, y), Math.max(0, viewportHeight - height - margin))),
    };
  }

  function mount(panel, env = globalThis) {
    const header = panel.querySelector(".bt-panel-header");
    const body = panel.querySelector("#bt-panel-body");
    const minimize = panel.querySelector("#bt-minimize");
    const mini = panel.querySelector("#bt-mini");
    const storage = env.chrome?.storage?.local;
    let collapsed = false;
    let interacted = false;
    let drag = null;
    const initial = panel.getBoundingClientRect();
    let x = initial.left;
    let y = initial.top;

    function apply() {
      panel.classList.toggle("bt-collapsed", collapsed);
      header.hidden = collapsed;
      body.hidden = collapsed;
      mini.hidden = !collapsed;
      mini.setAttribute("aria-expanded", String(!collapsed));
      const rect = panel.getBoundingClientRect();
      ({ x, y } = clamp(x, y, rect.width, rect.height, env.innerWidth, env.innerHeight));
      panel.style.right = "auto";
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    }

    function save() {
      try {
        Promise.resolve(storage?.set({ [KEY]: { x, y, collapsed } })).catch(() => {});
      } catch (_) { /* Layout persistence must never interfere with sending. */ }
    }

    function toggle(value) {
      interacted = true;
      collapsed = value;
      apply();
      save();
    }
    minimize.addEventListener("click", () => toggle(true));
    mini.addEventListener("click", () => toggle(false));

    for (const handle of [header, mini]) {
      let suppressClick = false;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.isPrimary === false || drag) return;
        if (handle === header && event.target.closest?.("button, a, input, textarea, select")) return;
        interacted = true;
        suppressClick = false;
        drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
          x, y, moved: false, handle, suppress: () => { suppressClick = true; } };
        try { handle.setPointerCapture?.(event.pointerId); } catch (_) { /* Window listeners remain active. */ }
      });
      handle.addEventListener("click", (event) => {
        if (!suppressClick || event.detail === 0) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }

    env.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      event.preventDefault();
      x = drag.x + dx;
      y = drag.y + dy;
      apply();
    });
    function finish(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const ended = drag;
      drag = null;
      try { ended.handle.releasePointerCapture?.(ended.id); } catch (_) { /* Capture may already be lost. */ }
      if (ended.moved) { ended.suppress(); save(); }
    }
    env.addEventListener("pointerup", finish);
    env.addEventListener("pointercancel", finish);
    env.addEventListener("blur", () => { if (drag) finish({ pointerId: drag.id }); });
    env.addEventListener("resize", () => { apply(); save(); });
    apply();
    try {
      Promise.resolve(storage?.get(KEY)).then((data) => {
        if (interacted) return;
        const saved = data?.[KEY];
        if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
        x = saved.x; y = saved.y; collapsed = saved.collapsed === true;
        apply();
      }).catch(() => {});
    } catch (_) { /* Missing/expired extension storage only loses layout preferences. */ }
    return { getState: () => ({ x, y, collapsed }) };
  }
  return { mount, clamp, KEY };
});
