import { pathToFileURL } from 'node:url';

/** Fixed model-to-column inventory; callers cannot supply SQL identifiers. */
export const catalog = Object.freeze(
  [
    ['phase1', 'D2cFile', 'd2c_file', 'content', 'content', 'text'],
    ['phase1', 'D2cVersionFile', 'd2c_version_file', 'content', 'content', 'text'],
    ['phase1', 'D2cSavedWorkFile', 'd2c_saved_work_file', 'content', 'content', 'text'],
    ['phase1', 'D2cPreview', 'd2c_preview', 'buildManifest', 'buildManifest', 'serializedJSON'],
    ['execution', 'D2cTimeline', 'd2c_timeline', 'sdkItem', 'sdkItem', 'serializedJSON'],
    [
      'execution',
      'D2cTimeline',
      'd2c_timeline',
      'displayPayload',
      'displayPayload',
      'serializedJSON',
    ],
    [
      'execution',
      'D2cAgentCheckpoint',
      'd2c_agent_checkpoint',
      'checkpoint',
      'checkpointPayload',
      'blob',
    ],
    [
      'execution',
      'D2cAgentCheckpoint',
      'd2c_agent_checkpoint',
      'metadata',
      'metadataPayload',
      'blob',
    ],
    ['execution', 'D2cAgentWrite', 'd2c_agent_write', 'value', 'writePayload', 'blob'],
  ].map(([phase, model, table, attribute, column, measurement]) =>
    Object.freeze({
      phase,
      model,
      table,
      attribute,
      column,
      measurement,
      note:
        measurement === 'serializedJSON'
          ? 'serializedJSON approximation: includes metadata; not physical JSON storage bytes.'
          : 'Logical value bytes; not physical table, index or allocated disk usage.',
    }),
  ),
);

/** Validate the only supported switch, preventing arbitrary tables, columns or filters. */
function selected(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'includeExecution') ||
    (options.includeExecution !== undefined && typeof options.includeExecution !== 'boolean')
  ) {
    throw new TypeError('Only the boolean includeExecution option is supported.');
  }
  return catalog.filter((entry) => options.includeExecution || entry.phase === 'phase1');
}

/** Generate aggregate-only MySQL SELECT statements without I/O or database dependencies. */
export function generateAuditSql(options = {}) {
  return selected(options)
    .map((entry) => {
      const column = `\`${entry.column}\``;
      const value =
        entry.measurement === 'serializedJSON'
          ? `CAST(${column} AS CHAR CHARACTER SET utf8mb4)`
          : column;
      const length = `OCTET_LENGTH(${value})`;
      return [
        `-- ${entry.table}.${entry.column}: ${entry.note}`,
        'SELECT',
        '  COUNT(*) AS row_count,',
        `  COUNT(${column}) AS non_null_count,`,
        `  SUM(${length}) AS total_bytes,`,
        `  MAX(${length}) AS max_bytes,`,
        `  AVG(${length}) AS avg_bytes`,
        `FROM \`${entry.table}\`;`,
      ].join('\n');
    })
    .join('\n\n');
}

const help = `Usage: node scripts/content-storage-audit.mjs [--sql | --catalog] [--include-execution]
       node scripts/content-storage-audit.mjs --help

Default: print a JSON audit plan for phase1 (four content-bearing columns).
--sql                Print aggregate-only MySQL SELECT statements; never execute them.
--catalog            Print the selected fixed field catalog as JSON.
--include-execution  Also include timeline, checkpoint and pending-write payloads.
--help               Print this help.

No database connection, network request, shell execution or file mutation is performed.
Only COUNT(*), COUNT(column), SUM/MAX/AVG(OCTET_LENGTH(value)) are selected.
COUNT(column) counts SQL non-NULL values, including empty strings and JSON null literals.
SUM/MAX/AVG ignore SQL NULL; all-NULL or empty inputs yield NULL for these aggregates.
serializedJSON is an approximation including metadata, not physical JSON storage bytes.
Each SELECT scans one whitelisted column without sorting, grouping or returning raw values.
`;

/** Parse strict flags and print a plan/catalog/SQL; imported modules remain silent. */
function main(args) {
  const allowed = new Set(['--sql', '--catalog', '--include-execution', '--help']);
  for (const arg of args) {
    if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  if (new Set(args).size !== args.length) throw new Error('Duplicate arguments are not supported.');
  if (args.includes('--help')) {
    process.stdout.write(help);
    return;
  }
  if (args.includes('--sql') && args.includes('--catalog')) {
    throw new Error('Choose only one output mode: --sql or --catalog.');
  }
  const options = { includeExecution: args.includes('--include-execution') };
  const entries = selected(options);
  if (args.includes('--sql')) {
    process.stdout.write(`${generateAuditSql(options)}\n`);
    return;
  }
  const result = args.includes('--catalog')
    ? entries
    : {
        mode: 'plan',
        execution: 'none; SQL generation only, no database/network/shell/file writes',
        scope: options.includeExecution ? 'phase1 + execution' : 'phase1',
        catalog: entries,
        metrics: ['row_count', 'non_null_count', 'total_bytes', 'max_bytes', 'avg_bytes'],
        notes: [
          'Use --sql to print SELECT statements for separate review; this CLI never runs SQL.',
          'No body, object locator, path, credential or row identifier is returned.',
          'COUNT(column) includes empty values and JSON null literals but excludes SQL NULL.',
          'SUM/MAX/AVG exclude SQL NULL and remain NULL for all-NULL or empty inputs.',
          'serializedJSON approximates serialized UTF-8 bytes including metadata, not disk usage.',
          'Each statement scans a fixed column; no large JSON sorting or grouping is used.',
        ],
      };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nUse --help for usage.\n`);
    process.exitCode = 1;
  }
}
