import React, { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { monaco, configureEditorProject } from './monacoRuntime';
import { editableFileLanguage as editorLanguage } from './editableFiles';
import type { EditorReveal } from './globalSearch';

type Source = { path: string; content: string };

/** 一个副本一个虚拟项目；切换文件保留撤销和光标，关闭后释放全部模型及订阅。 */
export default function CodeEditor({
  scope,
  files,
  path,
  readOnly,
  onChange,
  onSave,
  reveal,
}: {
  scope: string;
  files: Source[];
  path: string;
  readOnly: boolean;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
  reveal?: EditorReveal;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const states = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const [problems, setProblems] = useState(0);
  const root = `file:///project/${encodeURIComponent(scope)}/`;

  useEffect(() => {
    configureEditorProject(
      root,
      files.some((file) => file.path.startsWith('src/')),
    );
    const instance = monaco.editor.create(container.current!, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      insertSpaces: true,
      scrollBeyondLastLine: false,
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true },
      wordBasedSuggestions: 'currentDocument',
      formatOnPaste: true,
      bracketPairColorization: { enabled: true },
      padding: { top: 12 },
      theme: 'vs',
    });
    editor.current = instance;
    const change = instance.onDidChangeModelContent(() => {
      const current = instance.getModel();
      const filename = [...models.current].find(([, model]) => model === current)?.[0];
      if (filename && current) callbacks.current.onChange(filename, current.getValue());
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      callbacks.current.onSave(),
    );
    const markers = monaco.editor.onDidChangeMarkers(() => {
      setProblems(
        monaco.editor
          .getModelMarkers({})
          .filter((marker) => marker.resource.toString().startsWith(root)).length,
      );
    });
    return () => {
      change.dispose();
      markers.dispose();
      instance.dispose();
      editor.current = null;
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
      states.current.clear();
    };
  }, [scope]);

  useEffect(() => {
    for (const file of files) {
      let model = models.current.get(file.path);
      if (!model) {
        model = monaco.editor.createModel(
          file.content,
          editorLanguage(file.path),
          monaco.Uri.parse(root + file.path),
        );
        models.current.set(file.path, model);
      } else if (model.getValue() !== file.content) model.setValue(file.content);
    }
    for (const [filename, model] of models.current) {
      if (!files.some((file) => file.path === filename)) {
        model.dispose();
        models.current.delete(filename);
      }
    }
    const instance = editor.current;
    const next = models.current.get(path);
    if (instance && next && instance.getModel() !== next) {
      const previous = [...models.current].find(([, model]) => model === instance.getModel())?.[0];
      if (previous) states.current.set(previous, instance.saveViewState());
      instance.setModel(next);
      instance.restoreViewState(states.current.get(path) ?? null);
      instance.focus();
    }
    instance?.updateOptions({ readOnly });
  }, [files, path, readOnly, scope]);

  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!reveal || reveal.path !== path || !instance || !model) return;
    /** 文件在结果展示后可能被编辑；先按当前模型修正范围，禁止越界。 */
    const start = model.validatePosition({ lineNumber: reveal.line, column: reveal.column });
    const offset = model.getOffsetAt(start);
    const end = model.getPositionAt(
      Math.min(model.getValueLength(), offset + Math.max(0, reveal.length)),
    );
    const selection = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
    instance.setSelection(selection);
    instance.revealRangeInCenter(selection);
    instance.focus();
  }, [reveal, path, scope]);

  return (
    <div className="code-editor-shell">
      <div className="code-editor-heading">
        <span title={path}>{path}</span>
        <Button
          size="small"
          disabled={readOnly}
          onClick={() => void editor.current?.getAction('editor.action.formatDocument')?.run()}
        >
          格式化
        </Button>
      </div>
      <div
        ref={container}
        className="code-editor-surface"
        role="group"
        aria-label={`编辑 ${path}`}
      />
      <div className="code-editor-status">
        <span>{editorLanguage(path).toUpperCase()}</span>
        <span>{problems ? `${problems} 项诊断` : '无错误'} · Ctrl/⌘ S 保存</span>
      </div>
    </div>
  );
}
