import { initializeAppClose } from "./appClose";
import { installControlLabelBehavior } from "./controlLabels";
import { installRuntimeLogging, logRuntimeError } from "./runtimeLog";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppTooltip } from "./components/AppTooltip";
import "./styles.css";
import "./components/AppTooltip.css";
import "katex/dist/katex.min.css";

// 桌面端禁用 WebView 自带右键菜单（返回/刷新/另存为等）。
// 注意：这里只阻止浏览器默认菜单，不会取消其它监听器；
// 应用内自定义右键（PDF / 图片识别 / 会话列表等）需自行弹出菜单。
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

installRuntimeLogging();
void initializeAppClose().catch(error=>logRuntimeError("app-close-init-error",error));
installControlLabelBehavior();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <AppTooltip />
  </StrictMode>,
);
