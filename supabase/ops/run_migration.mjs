// 用 pg 直接对 Supabase 连接串执行全量迁移。
// 关键点：按顶层分号切分语句，且正确识别 $-引号（函数体）、单引号、双引号，
// 避免把函数体内的分号误判为语句边界。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, 'full_schema_0001_0016.sql');
const CONN = process.env.PG_URI;
if (!CONN) {
  console.error('缺少环境变量 PG_URI（Supabase 连接串）');
  process.exit(2);
}

function splitStatements(sql) {
  const stmts = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "'") {
      // 单引号字符串，支持 '' 转义
      buf += c; i++;
      while (i < n) {
        buf += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { buf += sql[i + 1]; i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      buf += c; i++;
      while (i < n) {
        buf += sql[i];
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '$' && (c2 === '$' || /[A-Za-z_]/.test(c2 || ''))) {
      // dollar-quoted 段：$$...$$ 或 $tag$...$tag$
      let tag = '$';
      i++;
      while (i < n && sql[i] !== '$') { tag += sql[i]; i++; }
      tag += '$'; // 含首尾 $
      buf += tag;
      if (i >= n) break;
      i++; // 跳过长 tag 的结尾 $
      // 找结束 tag
      while (i < n) {
        if (sql[i] === '$') {
          let end = '$';
          let j = i + 1;
          while (j < n && /[A-Za-z0-9_]/.test(sql[j])) { end += sql[j]; j++; }
          if (sql[j] === '$') {
            const closeTag = end + '$';
            if (closeTag === tag) {
              buf += closeTag;
              i = j + 1;
              break;
            }
          }
          buf += sql[i]; i++;
        } else {
          buf += sql[i]; i++;
        }
      }
      continue;
    }
    if (c === ';') {
      if (buf.trim().length) stmts.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += c; i++;
  }
  if (buf.trim().length) stmts.push(buf.trim());
  return stmts;
}

const statements = splitStatements(readFileSync(SQL_PATH, 'utf8'));
console.log(`切分出 ${statements.length} 条语句`);

const client = new pg.Client({ connectionString: CONN });
await client.connect();
let ok = 0, fail = 0;
for (let idx = 0; idx < statements.length; idx++) {
  const s = statements[idx];
  // 跳过纯注释 / 空
  if (!s || s.startsWith('--')) continue;
  try {
    await client.query(s);
    ok++;
  } catch (e) {
    fail++;
    console.error(`\n[FAIL #${idx + 1}] ${s.slice(0, 120).replace(/\n/g, ' ')}...`);
    console.error(`   → ${e.message}`);
  }
}
await client.end();
console.log(`\n完成：成功 ${ok} 条，失败 ${fail} 条`);
process.exit(fail ? 1 : 0);
