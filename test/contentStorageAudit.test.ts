import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('../scripts/content-storage-audit.mjs', import.meta.url);
const script = fileURLToPath(scriptUrl);
const expected = [
  ['D2cFile', 'd2c_file', 'content', 'content'],
  ['D2cVersionFile', 'd2c_version_file', 'content', 'content'],
  ['D2cSavedWorkFile', 'd2c_saved_work_file', 'content', 'content'],
  ['D2cPreview', 'd2c_preview', 'buildManifest', 'buildManifest'],
  ['D2cTimeline', 'd2c_timeline', 'sdkItem', 'sdkItem'],
  ['D2cTimeline', 'd2c_timeline', 'displayPayload', 'displayPayload'],
  ['D2cAgentCheckpoint', 'd2c_agent_checkpoint', 'checkpoint', 'checkpointPayload'],
  ['D2cAgentCheckpoint', 'd2c_agent_checkpoint', 'metadata', 'metadataPayload'],
  ['D2cAgentWrite', 'd2c_agent_write', 'value', 'writePayload'],
];

/** Trap external effects in the actual CLI child, including named builtin imports. */
const guard = `
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('Audit CLI attempted an external effect'); };
for (const key of ['writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir',
  'rename', 'copyFile', 'link', 'symlink', 'chmod', 'chown', 'utimes', 'write']) {
  if (typeof fs[key] === 'function') fs[key] = deny;
  if (typeof fs[key + 'Sync'] === 'function') fs[key + 'Sync'] = deny;
  if (typeof fs.promises[key] === 'function') fs.promises[key] = deny;
}
for (const [api, key] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
  const original = api[key];
  api[key] = function(path, flags, ...rest) {
    if (flags !== 'r' && flags !== 0) deny();
    return original.call(this, path, flags, ...rest);
  };
}
fs.createWriteStream = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
for (const api of [http, https]) { api.request = deny; api.get = deny; }
for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'])
  child[key] = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
`;
const guardUrl = `data:text/javascript,${encodeURIComponent(guard)}`;

/** Run Node directly with no shell and no inherited loader or application setup. */
function cli(args: string[] = [], code?: string) {
  const result = spawnSync(
    process.execPath,
    ['--import', guardUrl, ...(code ? ['--input-type=module', '--eval', code] : [script, ...args])],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  assert.ifError(result.error);
  return result;
}

/** Successful output is consumed exactly as a human invoking the CLI receives it. */
function output(args: string[] = []) {
  const result = cli(args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('default plan selects only phase1 and explains JSON estimates without producing SQL', () => {
  const plan = JSON.parse(output());
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.scope, 'phase1');
  assert.equal(plan.catalog.length, 4);
  assert.ok(plan.catalog.every((entry: { phase: string }) => entry.phase === 'phase1'));
  assert.equal(plan.catalog[3].measurement, 'serializedJSON');
  assert.match(plan.catalog[3].note, /approximation.*metadata/);
  assert.match(plan.execution, /none/);
});

test('fixed catalog matches every model table and exact database field mapping offline', () => {
  const entries = JSON.parse(output(['--catalog', '--include-execution']));
  assert.deepEqual(
    entries.map((entry: Record<string, string>) => [
      entry.model,
      entry.table,
      entry.attribute,
      entry.column,
    ]),
    expected,
  );
  for (const [model, table, attribute, column] of expected) {
    const source = readFileSync(new URL(`../src/models/${model}.ts`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`tableName:\\s*'${table}'`));
    const declaration = source.match(new RegExp(`\\b${attribute}:\\s*\\{([^}]+)\\}`));
    assert.ok(declaration, `${model}.${attribute} declaration missing`);
    const mapped = declaration[1].match(/\bfield:\s*'([^']+)'/);
    assert.equal(mapped?.[1] ?? attribute, column);
  }
  assert.equal(JSON.parse(output(['--catalog'])).length, 4);
});

test('SQL projects only exact whitelist aggregates, never bodies, locators, paths or mutations', () => {
  for (const includeExecution of [false, true]) {
    const sql = output(['--sql', ...(includeExecution ? ['--include-execution'] : [])]);
    const statements = sql
      .replace(/^--.*$/gm, '')
      .trim()
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    const fields = expected.slice(0, includeExecution ? 9 : 4);
    assert.equal(statements.length, fields.length);
    for (let index = 0; index < fields.length; index++) {
      const [, , , column] = fields[index];
      const table = fields[index][1];
      const json = ['buildManifest', 'sdkItem', 'displayPayload'].includes(column);
      const quoted = `\`${column}\``;
      const value = json ? `CAST(${quoted} AS CHAR CHARACTER SET utf8mb4)` : quoted;
      assert.equal(
        statements[index],
        [
          'SELECT',
          '  COUNT(*) AS row_count,',
          `  COUNT(${quoted}) AS non_null_count,`,
          `  SUM(OCTET_LENGTH(${value})) AS total_bytes,`,
          `  MAX(OCTET_LENGTH(${value})) AS max_bytes,`,
          `  AVG(OCTET_LENGTH(${value})) AS avg_bytes`,
          `FROM \`${table}\``,
        ].join('\n'),
      );
    }
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|INTO|CALL)\b/i);
    assert.doesNotMatch(sql, /\b(ORDER\s+BY|GROUP\s+BY|WHERE|objectLocator|path|url)\b/i);
  }
});

test('help explains non-NULL, empty inputs, read-only behavior and execution opt-in', () => {
  const help = output(['--help']);
  assert.match(help, /--include-execution/);
  assert.match(help, /--catalog/);
  assert.match(help, /SQL non-NULL/);
  assert.match(help, /empty strings and JSON null/);
  assert.match(help, /all-NULL or empty inputs yield NULL/);
  assert.match(help, /never execute/);
});

test('unknown flags, identifiers, positional arguments and conflicting modes fail with empty stdout', () => {
  for (const args of [
    ['--execute'],
    ['--table', 'd2c_file'],
    ['--column=content'],
    ['d2c_file'],
    ['--help', '--bogus'],
    ['--sql', '--catalog'],
    ['--sql', '--sql'],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unknown argument|Duplicate arguments|Choose only one/);
  }
});

test('import is silent and pure generator rejects arbitrary identifier options', () => {
  const result = cli(
    [],
    `
      import assert from 'node:assert/strict';
      const { catalog, generateAuditSql } = await import(${JSON.stringify(scriptUrl.href)});
      assert.equal(catalog.length, 9);
      assert.ok(Object.isFrozen(catalog) && catalog.every(Object.isFrozen));
      const sql = generateAuditSql();
      assert.equal(sql, generateAuditSql());
      assert.equal((sql.match(/^SELECT$/gm) || []).length, 4);
      assert.equal((generateAuditSql({ includeExecution: true }).match(/^SELECT$/gm) || []).length, 9);
      for (const option of [{ table: 'injected' }, { column: 'content' },
        { includeExecution: 'yes' }, null, []]) {
        assert.throws(() => generateAuditSql(option), TypeError);
      }
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
});
