import { useEffect, useState } from "react";

const key = "llmchat-training-python";
const eventName = "llmchat-training-python-change";
export const readTrainingPython = () => localStorage.getItem(key) ?? "";
export function saveTrainingPython(path: string) {
  localStorage.setItem(key, path.trim());
  window.dispatchEvent(new Event(eventName));
}
export function useTrainingPython() {
  const [path, setPath] = useState(readTrainingPython);
  useEffect(() => {
    const update = () => setPath(readTrainingPython());
    window.addEventListener("storage", update);
    window.addEventListener(eventName, update);
    return () => { window.removeEventListener("storage", update); window.removeEventListener(eventName, update); };
  }, []);
  return path;
}
