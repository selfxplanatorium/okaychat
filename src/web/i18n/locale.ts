/** The active BCP 47 tag, shared by `t()` and the formatters. Set only by `applyLocale`. */
let active = "en";

export const currentLocale = () => active;
export const setActiveLocale = (tag: string) => {
  active = tag;
};
