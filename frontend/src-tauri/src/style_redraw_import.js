(() => {
  const pending = globalThis.__llmchatWorkflowImport;
  delete globalThis.__llmchatWorkflowImport;
  if (window.top !== window || location.origin !== "http://127.0.0.1:8188" || !pending) return;

  const { id, name, path, graph } = pending;
  const handledKey = "llmchat-editor-import:" + id;
  if (sessionStorage.getItem(handledKey)) return;
  sessionStorage.setItem(handledKey, "1");

  const showError = error => {
    const notice = document.createElement("div");
    notice.setAttribute("role", "alert");
    notice.textContent = "无法同步去码工作流：" + (error?.message || error);
    Object.assign(notice.style, { position: "fixed", top: "12px", right: "12px", zIndex: "10000",
      maxWidth: "32rem", padding: "10px 15px", background: "#822626", color: "#fff", borderRadius: "6px" });
    document.body.append(notice);
    setTimeout(() => notice.remove(), 10000);
  };
  const graphSignature = async ({ nodes, links, definitions }) => {
    const data = new TextEncoder().encode(JSON.stringify({ nodes, links, definitions }));
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  };
  void (async () => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const app = window.comfyAPI?.app?.app;
      const ready = app && (typeof app.isGraphReady === "boolean"
        ? app.isGraphReady && app.canvasOrUndefined : app.canvas && app.graph);
      if (ready && app.vueAppReady !== false && !app.configuringGraph && typeof app.loadApiJson === "function"
          && typeof app.graphToPrompt === "function") {
        const workflows = app.extensionManager?.workflow;
        // The canvas can exist before ComfyUI finishes opening its startup workflow.
        if (!workflows || !("activeWorkflow" in workflows) || workflows.activeWorkflow) {
          if (await app.loadApiJson(graph, name) === false)
            throw Error("请检查 ComfyUI 节点和模型是否齐全");
          const { workflow, output } = await app.graphToPrompt();
          if (!Array.isArray(workflow?.nodes) || !Object.entries(graph).every(([key, node]) =>
            output?.[key]?.class_type === node.class_type))
            throw Error("工作流未完整载入，请检查缺失的 ComfyUI 节点");
          const route = "/userdata/" + encodeURIComponent("workflows/" + path);
          const existing = await fetch(route, { cache: "no-store" });
          if (existing.ok) {
            const stored = await existing.json();
            if (stored.extra?.llmchatMosaicPath !== path)
              throw Error("同名文件已存在，请先将它重命名");
            if (stored.extra.llmchatMosaicSignature !== await graphSignature(stored))
              throw Error("此工作流已在 ComfyUI 中编辑，请将它重命名后再同步");
          } else if (existing.status !== 404) throw Error("无法检查共享工作流文件");
          workflow.extra = { ...workflow.extra, llmchatMosaicPath: path, llmchatMosaicSignature: await graphSignature(workflow) };
          const response = await fetch(route + (existing.status === 404 ? "?overwrite=false" : ""), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workflow),
          });
          if (!response.ok) throw Error("ComfyUI 保存失败（" + response.status + "）");
          app.extensionManager?.toast?.add({ severity: "success", summary: "已同步到 ComfyUI", detail: path, life: 5000 });
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error("ComfyUI 节点编辑器尚未加载");
  })().catch(showError);
})();
