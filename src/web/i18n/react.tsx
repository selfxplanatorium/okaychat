import { Fragment, type ReactNode } from "react";
import { template, type MessageKey, type MessageNodeParams } from "./index";
import { formatNumber } from "./format";

/**
 * `t()` for text with elements inside, such as a link or bold name: `{name}` placeholders take any
 * ReactNode, so translators keep control of word order. Plain-string results should use `t()`.
 *
 *   <Trans k="share.byline" params={{ name: <strong>{user}</strong> }} />
 */
export function Trans<K extends MessageKey>({ k, params }: { k: K; params?: MessageNodeParams<K, ReactNode> }) {
  const values = params as Record<string, ReactNode> | undefined;
  const count = typeof values?.count === "number" ? values.count : undefined;
  const parts = template(k, count).split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part ? <Fragment key={i}>{part}</Fragment> : null;
        const value = values?.[part];
        if (value === undefined) return <Fragment key={i}>{`{${part}}`}</Fragment>;
        return <Fragment key={i}>{typeof value === "number" ? formatNumber(value) : value}</Fragment>;
      })}
    </>
  );
}
