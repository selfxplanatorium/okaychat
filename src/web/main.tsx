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


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
