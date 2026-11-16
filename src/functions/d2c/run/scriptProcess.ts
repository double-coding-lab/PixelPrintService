/** 固定 Figma CLI 主动退出时先排空管道，避免大 JSON 被 process.exit 截断。 */
export const scriptProcessPrelude = `
const exit = process.exit.bind(process);
let exiting = false;
process.exit = (code) => {
  if (exiting) return;
  exiting = true;
  const status = code ?? process.exitCode ?? 0;
  process.stdout.write('', (error) => {
    if (error) return exit(1);
    process.stderr.write('', (error) => exit(error ? 1 : status));
  });
};
`;
