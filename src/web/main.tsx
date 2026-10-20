import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/golos-text";
import "@fontsource/dejavu-sans";
import "@fontsource/dejavu-serif";
import "@fontsource/ubuntu";
import "@fontsource/ubuntu-mono";
import "./fonts/bundled.css";
import "./index.css";
import { installIconMotion } from "./motion/icons";

installIconMotion();

// Production only: a worker in dev would cache Vite's unhashed modules. Browsers
// skip registration on insecure origins (plain-HTTP tailnet URLs), so install needs HTTPS.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
