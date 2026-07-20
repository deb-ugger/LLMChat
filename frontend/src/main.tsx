// 必须在任何 pdf_viewer 导入之前：官方 viewer 依赖 globalThis.pdfjsLib
import "./pdfjsBootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "katex/dist/katex.min.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
