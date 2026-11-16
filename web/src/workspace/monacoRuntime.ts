/// <reference types="vite/client" />
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';

self.MonacoEnvironment = {
  /** 语言服务全部由当前应用静态资源加载，浏览器不访问外部CDN。 */
  getWorker(_id, label) {
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (label === 'json') return new JsonWorker();
    if (label === 'html') return new HtmlWorker();
    return new EditorWorker();
  },
};

const declarations = import.meta.glob(
  [
    '../../../node_modules/@types/react/*.d.ts',
    '../../../node_modules/csstype/index.d.ts',
    '../../../node_modules/react-native/**/*.d.ts',
    '../../../node_modules/@react-native/virtualized-lists/**/*.d.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const libraries = Object.entries(declarations).map(([filename, content]) => ({
  filePath: `file://${filename.slice(filename.indexOf('/node_modules/'))}`,
  content,
}));
libraries.push(
  {
    filePath: 'file:///node_modules/react-native/index.d.ts',
    content: "export * from './types/index';",
  },
  {
    filePath: 'file:///editor-assets.d.ts',
    content: `declare module '*.css';
    declare module '*.scss' { const styles: Record<string, string>; export default styles; }
    declare module '*.less' { const styles: Record<string, string>; export default styles; }
    declare module '*.png' { const url: string; export default url; }
    declare module '*.jpg' { const url: string; export default url; }
    declare module '*.svg' { const url: string; export default url; }
    declare function require(path: string): number;`,
  },
);

/** 同时装入项目所有源码与真实依赖声明，支持跨文件导入、React JSX与RN组件属性推断。 */
export function configureEditorProject(root: string, hasSrc: boolean) {
  const ts = monaco.typescript;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      allowNonTsExtensions: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      baseUrl: root,
      paths: { '@/*': [hasSrc ? 'src/*' : '*'] },
    });
    defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
    defaults.setExtraLibs(libraries);
    defaults.setEagerModelSync(true);
  }
}
export { monaco };
