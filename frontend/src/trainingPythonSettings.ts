import { useEffect, useState } from "react";

const key = "llmchat-training-python";
const directoryKey = "llmchat-training-environment-directory";
const eventName = "llmchat-training-python-change";
export const readTrainingPython = () => localStorage.getItem(key) ?? "";
export const readTrainingEnvironmentDirectory = () => localStorage.getItem(directoryKey) ?? "";
export function saveTrainingPython(path: string, directory?: string) {
  if (directory !== undefined) localStorage.setItem(directoryKey, directory.trim());
  localStorage.setItem(key, path.trim());
  window.dispatchEvent(new Event(eventName));
}
function useTrainingValue(read: () => string) {
  const [path, setPath] = useState(read);
  useEffect(() => {
    const update = () => setPath(read());
    window.addEventListener("storage", update);
    window.addEventListener(eventName, update);
    return () => { window.removeEventListener("storage", update); window.removeEventListener(eventName, update); };
  }, [read]);
  return path;
}

export const useTrainingPython = () => useTrainingValue(readTrainingPython);
export const useTrainingEnvironmentDirectory = () => useTrainingValue(readTrainingEnvironmentDirectory);
