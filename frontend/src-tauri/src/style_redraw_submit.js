(() => {
  if (location.origin !== "http://127.0.0.1:8188" || location.pathname !== "/") return;
  const { workflow, path } = globalThis.__llmchatSavedRun;
  delete globalThis.__llmchatSavedRun;
  const send = data => location.replace("/__llmchat_workflow_result?" +
    new URLSearchParams({ data: JSON.stringify(data) }));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  void (async () => {
    try {
      const deadline = Date.now() + 40000;
      let app;
      while (Date.now() < deadline) {
        app = window.comfyAPI?.app?.app;
        if (app?.canvas && app.graph && typeof app.graphToPrompt === "function") break;
        await pause(200);
      }
      if (!app?.canvas || !app.graph) throw Error("ComfyUI 节点编辑器尚未加载");
      const loaded = await app.loadGraphData(workflow, true, false);
      if (loaded === false) throw Error("ComfyUI 无法加载此工作流，请检查模型和节点");
      const { workflow: visual, output } = await app.graphToPrompt();
      const loadedTypes = new Map((visual?.nodes || []).map(node => [String(node.id), node.type]));
      if (!output || !Object.keys(output).length ||
        !workflow.nodes.every(node => loadedTypes.get(String(node.id)) === node.type)) {
        throw Error("工作流未完整加载，未提交任务");
      }
      const response = await fetch("/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: output, extra_data: { extra_pnginfo: { workflow: visual }, llmchat_workflow: path } }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.prompt_id !== "string") {
        const reason = [result.error?.message || result.error, result.error?.details].filter(value => typeof value === "string").join("：");
        const node = Object.values(result.node_errors || {})[0]?.errors?.[0];
        throw Error([reason, node?.details].filter(Boolean).join("；") || "ComfyUI 拒绝了工作流");
      }
      send({ prompt_id: result.prompt_id, number: result.number });
    } catch (error) {
      send({ error: String(error?.message || error).slice(0, 900) });
    }
  })();
})();
