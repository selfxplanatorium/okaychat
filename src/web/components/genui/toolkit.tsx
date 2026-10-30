import { createWidgetToolkit, useWidgetInstructions } from "generative-frame/assistant-ui";
import { createSpecToolkit } from "generative-frame/spec/assistant-ui";
import { t } from "@/i18n";
import { catalog, components } from "./catalog";

// The frame's CSP blocks most remote images, so models often ship widgets with broken ones. Chrome and
// Firefox paint ::before/::after on an image only when it failed to load, which lets CSS alone swap the
// browser's broken-image box for a quiet placeholder. Loaded images are untouched. The icon is a data URI
// because the CSP allows data: images.
const IMAGE_OFF_ICON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='2' x2='22' y1='2' y2='22'/%3E%3Cpath d='M10.41 10.41a2 2 0 1 1-2.83-2.83'/%3E%3Cline x1='13.5' x2='6' y1='13.5' y2='21'/%3E%3Cline x1='18' x2='21' y1='12' y2='15'/%3E%3Cpath d='M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59'/%3E%3Cpath d='M21 15V5a2 2 0 0 0-2-2H9'/%3E%3C/svg%3E\")";

const brokenImageCss = () => `
img { position: relative; }
img::before {
  content: "";
  position: absolute;
  inset: 0;
  border: 1px solid var(--color-border, rgb(128 128 128 / 0.25));
  border-radius: 8px;
  background: ${IMAGE_OFF_ICON} no-repeat 12px center / 16px, var(--color-surface-muted, rgb(128 128 128 / 0.12));
}
img::after {
  content: attr(alt);
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 0 12px 0 36px;
  overflow: hidden;
  white-space: nowrap;
  font: 13px/1.4 system-ui, sans-serif;
  color: var(--color-text-muted, #888);
}
img:not([alt])::after, img[alt=""]::after { content: "${t("genui.imageUnavailable").replace(/"/g, '\\"')}"; }
`;

// A null-origin sandbox instead of Safe Content Frame's hosted origin, so nothing loads from a third-party
// frame host. Widgets lose persistent storage, which also means `widgetId` must be off.
export const widgetOptions = {
  opaqueOrigin: true,
  maxHeight: 800,
  get css() {
    return brokenImageCss();
  },
};

/**
 * Generative UI, two renderers the model picks per answer:
 * - `render_spec`: declarative components from our catalog, in the app theme.
 * - `show_widget` / `edit_widget`: HTML or SVG widgets streamed into a sandboxed frame.
 * Tools run in the browser so the model gets a render report (errors, blank output) and can repair.
 */
export const widgets = createWidgetToolkit({
  widget: widgetOptions,
  widgetId: false,
  spec: createSpecToolkit(catalog, { components }),
});

/** Adds the when-to-use rules to the system prompt (sent as model context `system`). */
export function WidgetInstructions() {
  useWidgetInstructions(widgets.tools);
  return null;
}
