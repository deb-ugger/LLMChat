(() => {
  const pending = globalThis.__llmchatWorkflowImport;
  delete globalThis.__llmchatWorkflowImport;
  if (window.top !== window || location.origin !== "http://127.0.0.1:8188" || !pending) return;

  const { id, name, graph } = pending;
  const handledKey = "llmchat-editor-import:" + id;
  if (sessionStorage.getItem(handledKey)) return;
  sessionStorage.setItem(handledKey, "1");

  const showError = error => {
    const notice = document.createElement("div");
    notice.setAttribute("role", "alert");
    notice.textContent = "无法导入去码工作流：" + (error?.message || error);
    Object.assign(notice.style, { position: "fixed", top: "12px", right: "12px", zIndex: "10000",
      maxWidth: "32rem", padding: "10px 15px", background: "#822626", color: "#fff", borderRadius: "6px" });
    document.body.append(notice);
    setTimeout(() => notice.remove(), 10000);
  };
  void (async () => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const app = window.comfyAPI?.app?.app;
      const ready = app && (typeof app.isGraphReady === "boolean"
        ? app.isGraphReady && app.canvasOrUndefined : app.canvas && app.graph);
      if (ready && app.vueAppReady !== false && !app.configuringGraph && typeof app.loadApiJson === "function") {
        const workflows = app.extensionManager?.workflow;
        // The canvas can exist before ComfyUI finishes opening its startup workflow.
        if (!workflows || !("activeWorkflow" in workflows) || workflows.activeWorkflow) {
          if (await app.loadApiJson(graph, name) === false)
            throw Error("请检查 ComfyUI 节点和模型是否齐全");
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error("ComfyUI 节点编辑器尚未加载");
  })().catch(showError);
})();
