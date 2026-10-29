// SPDX-License-Identifier: AGPL-3.0-only
// A tiny stand-in for the tagged-template `sql` function: rules match on the query text and return rows.
export type Row = Record<string, any>;
export type Call = { text: string; values: any[] };
type Rule = { re: RegExp; rows: Row[] | ((values: any[], text: string) => Row[]) };

export function fakeSql(rules: Rule[] = []) {
  const calls: Call[] = [];
  const all = [...rules];
  const sql = (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    for (const r of all) {
      if (r.re.test(text)) {
        const rows = typeof r.rows === "function" ? r.rows(values, text) : r.rows;
        return Promise.resolve(rows);
      }
    }
    return Promise.resolve([] as Row[]);
  };
  return { sql: sql as any, calls, on: (re: RegExp, rows: Rule["rows"]) => all.unshift({ re, rows }), find: (re: RegExp) => calls.filter((c) => re.test(c.text)) };
}
