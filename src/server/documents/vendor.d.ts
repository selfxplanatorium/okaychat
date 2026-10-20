// fast-formula-parser ships without types. Only the parts we call are declared.
declare module "fast-formula-parser" {
  interface CellRef {
    sheet?: string;
    row: number;
    col: number;
  }
  interface RangeRef {
    sheet?: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  interface Config {
    functions?: Record<string, (...args: any[]) => unknown>;
    onCell?: (ref: CellRef) => unknown;
    onRange?: (ref: RangeRef) => unknown[][];
  }
  class FormulaParser {
    constructor(config?: Config);
    parse(formula: string, position: CellRef, allowReturnArray?: boolean): unknown;
    static FormulaHelpers: {
      flattenParams(params: unknown[], type: number | null, allowUnion: boolean, hook: (item: unknown) => void, defVal?: unknown): void;
      accept(param: unknown, type?: number | null, defValue?: unknown, flat?: boolean, isArray?: boolean): any;
    };
    static Types: Record<string, number>;
    static FormulaError: { VALUE: unknown; NA: unknown; DIV0: unknown; REF: unknown };
  }
  export = FormulaParser;
}

declare module "fast-formula-parser/formulas/helpers.js" {
  export const Criteria: { parse(criteria: unknown): { op: string; value: any; match?: boolean } };
}

declare module "fast-formula-parser/formulas/operators.js" {
  export const Infix: { compareOp(a: unknown, op: string, b: unknown, aIsArray: boolean, bIsArray: boolean): boolean };
}

declare module "fast-formula-parser/ssf/ssf.js" {
  const SSF: { format(fmt: string, value: unknown): string; is_date(fmt: string): boolean };
  export default SSF;
}
