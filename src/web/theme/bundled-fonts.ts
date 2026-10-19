// Fonts shipped with the app, so every device gets the same choices. Golos Text is the default, not listed here.
// Liberation is a metric match for Arial, Times New Roman, and Courier New. The rest are common Linux faces.
// Sources: src/web/fonts/bundled.css (Liberation) and the @fontsource packages imported in main.tsx.
export interface BundledFont {
  readonly family: string;
  readonly monospace: boolean;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: "Liberation Sans", monospace: false },
  { family: "Liberation Serif", monospace: false },
  { family: "Liberation Mono", monospace: true },
  { family: "DejaVu Sans", monospace: false },
  { family: "DejaVu Serif", monospace: false },
  { family: "Ubuntu", monospace: false },
  { family: "Ubuntu Mono", monospace: true },
];
