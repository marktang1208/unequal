// Vitest 跑 .js 也行。复刻 M0+M1 收尾的 splitSqlIntoStatements。
// D1 的 exec() 在 Miniflare 3.20250718 拒收多行 SQL。
export function splitSqlIntoStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") i++;
      buf += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      buf += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      buf += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        buf += c;
        if (c === quote) {
          if (sql[i + 1] === quote) { buf += quote; i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      const flat = buf.replace(/\s+/g, " ").trim();
      if (flat) out.push(flat);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.replace(/\s+/g, " ").trim();
  if (tail) out.push(tail);
  return out;
}