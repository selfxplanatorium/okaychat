import { createWidgetToolkit, useWidgetInstructions } from "generative-frame/assistant-ui";
import { createSpecToolkit } from "generative-frame/spec/assistant-ui";
import { catalog, components } from "./catalog";

/**
 * Generative UI, two renderers the model picks per answer:
 * - `render_spec`: declarative components from our catalog, in the app theme.
 * - `show_widget` / `edit_widget`: HTML or SVG widgets streamed into a sandboxed frame.
 * Tools run in the browser so the model gets a render report (errors, blank output) and can repair.
 */
export const widgets = createWidgetToolkit({
  // A null-origin sandbox instead of Safe Content Frame's hosted origin, so nothing loads from a third-party
  // frame host. Widgets lose persistent storage, which also means `widgetId` must be off.
  widget: { opaqueOrigin: true, maxHeight: 800 },
  widgetId: false,
  spec: createSpecToolkit(catalog, { components }),
});

/** Adds the when-to-use rules to the system prompt (sent as model context `system`). */
export function WidgetInstructions() {
  useWidgetInstructions(widgets.tools);
  return null;
}
