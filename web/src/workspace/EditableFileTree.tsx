import FileTypeIcon from '../components/FileTypeIcon';
import { useEffect, useMemo, useState } from 'react';
import { Input, Tree } from 'antd';
import { buildEditableFileTree, filterEditableFiles, type EditableFile } from './editableFiles';
import { directoryKeys } from './fileTree';

export type EditableFileTreeProps = {
  files: EditableFile[];
  selectedPath: string;
  onSelect: (path: string) => void;
  /** 编辑器只读时仍允许导航，目录树自身不提供写入操作。 */
  readOnly?: boolean;
  dirtyPaths?: string[];
};

/** 展示当前 draft 的文本目录；搜索临时展开匹配目录，清空后恢复手动展开状态。 */
export default function EditableFileTree({
  files,
  selectedPath,
  onSelect,
  readOnly = false,
  dirtyPaths = [],
}: EditableFileTreeProps) {
  const [search, setSearch] = useState('');
  const editable = useMemo(() => filterEditableFiles(files), [files]);
  const tree = useMemo(() => buildEditableFileTree(editable, search), [editable, search]);
  const [expanded, setExpanded] = useState<string[]>(() =>
    buildEditableFileTree(files)
      .filter((node) => !node.isLeaf)
      .map((node) => node.key),
  );
  const dirty = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const searching = !!search.trim();

  useEffect(() => {
    const parts = selectedPath.split('/');
    const parents = parts
      .slice(0, -1)
      .map((_, index) => `directory:${parts.slice(0, index + 1).join('/')}`);
    setExpanded((prior) => [...new Set([...prior, ...parents])]);
  }, [selectedPath]);

  return (
    <nav className="editable-file-tree" aria-label="副本文件目录">
      <div className="editable-file-tree-heading">
        <span>
          文件 <span className="editable-file-tree-count">{editable.length}</span>
        </span>
        {readOnly && <span className="editable-file-tree-readonly">只读</span>}
      </div>
      <div className="editable-file-tree-toolbar">
        <Input.Search
          size="small"
          placeholder="搜索文件"
          aria-label="搜索副本文件"
          allowClear
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          disabled={searching || !tree.length}
          onClick={() => setExpanded(expanded.length ? [] : directoryKeys(tree))}
        >
          {expanded.length ? '收起目录' : '展开目录'}
        </button>
      </div>
      <div className="editable-file-tree-scroll">
        {!tree.length && (
          <p className="editable-file-tree-empty">
            {editable.length ? '没有匹配的文件' : '没有可编辑的源文件'}
          </p>
        )}
        <Tree.DirectoryTree
          showIcon
          icon={(node) => (
            <FileTypeIcon
              path={(node as { data?: { file?: { path: string } } }).data?.file?.path ?? ''}
              directory={!node.isLeaf}
              expanded={node.expanded}
            />
          )}
          blockNode
          multiple={false}
          treeData={tree}
          expandedKeys={searching ? directoryKeys(tree) : expanded}
          onExpand={(keys) => {
            if (!searching) setExpanded(keys.map(String));
          }}
          selectedKeys={selectedPath ? [selectedPath] : []}
          onSelect={(_, info) => {
            if (info.node.isLeaf && info.node.file) onSelect(info.node.file.path);
          }}
          titleRender={(node) => (
            <span className="editable-file-tree-title" title={node.file?.path ?? node.title}>
              <span className="editable-file-tree-name">{node.title}</span>
              {node.isLeaf && dirty.has(node.file!.path) && (
                <span className="editable-file-tree-dirty" role="img" aria-label="未保存修改" />
              )}
            </span>
          )}
        />
      </div>
    </nav>
  );
}
