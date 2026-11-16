import React, { useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import FileTypeIcon from '../components/FileTypeIcon';
import {
  SEARCH_LIMITS,
  prepareSearchFiles,
  propertySearchCandidates,
  type SearchFile,
  type SearchMatch,
  type SearchOptions,
  type SearchResults,
} from './globalSearch';

/** 当前副本内容搜索；每次查询独立 Worker，变更/关闭/超时立即终止旧任务。 */
export default function GlobalSearch({
  files,
  query,
  property,
  focusRequest,
  onQueryChange,
  onSelect,
  onClose,
}: {
  files: SearchFile[];
  query: string;
  property?: string;
  focusRequest: number;
  onQueryChange: (query: string) => void;
  onSelect: (match: SearchMatch) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [selectedMatch, setSelectedMatch] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const [search, setSearch] = useState<{ results?: SearchResults; busy: boolean }>({ busy: false });

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    setSelectedMatch('');
    if (!query) {
      setSearch({ busy: false });
      return;
    }
    setSearch({ busy: true });
    let active = true;
    let worker: Worker | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(() => {
      try {
        worker = new Worker(new URL('./globalSearch.worker.ts', import.meta.url), {
          type: 'module',
        });
        const prepared = prepareSearchFiles(files);
        deadline = setTimeout(() => {
          if (!active) return;
          active = false;
          worker?.terminate();
          setSearch({
            busy: false,
            results: {
              groups: [],
              count: 0,
              truncated: true,
              error: '搜索超时，请缩短查询或关闭正则',
            },
          });
        }, SEARCH_LIMITS.timeoutMs);
        worker.onmessage = (event: MessageEvent<SearchResults>) => {
          if (!active) return;
          active = false;
          clearTimeout(deadline);
          worker?.terminate();
          setSearch({
            busy: false,
            results: { ...event.data, truncated: prepared.truncated || event.data.truncated },
          });
        };
        worker.onerror = () => {
          if (!active) return;
          active = false;
          clearTimeout(deadline);
          worker?.terminate();
          setSearch({
            busy: false,
            results: { groups: [], count: 0, truncated: false, error: '搜索不可用，请重试' },
          });
        };
        worker.postMessage({ files: prepared.files, query, options });
      } catch {
        worker?.terminate();
        clearTimeout(deadline);
        setSearch({
          busy: false,
          results: { groups: [], count: 0, truncated: false, error: '搜索不可用，请重试' },
        });
      }
    }, 180);
    return () => {
      active = false;
      clearTimeout(debounce);
      clearTimeout(deadline);
      worker?.terminate();
    };
  }, [files, query, options]);

  const { results, busy } = search;
  return (
    <section className="editor-search" aria-label="副本全文搜索" aria-busy={busy}>
      <div className="editor-search-heading">
        <strong>{property ? '源码查找' : '全文搜索'}</strong>
        <button
          type="button"
          className="editor-search-back"
          onClick={onClose}
          aria-label="关闭搜索，返回文件目录"
          title="返回文件目录"
        >
          <Icon name="arrow" style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>
      <div className="editor-search-field">
        <input
          ref={input}
          className="editor-search-input"
          aria-label="搜索源码内容"
          placeholder="查找内容"
          value={query}
          maxLength={SEARCH_LIMITS.queryCharacters}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="editor-search-options" role="group" aria-label="搜索选项">
          {(
            [
              ['caseSensitive', '区分大小写', 'Aa'],
              ['wholeWord', '全字匹配', 'ab'],
              ['regex', '正则', '.*'],
            ] as const
          ).map(([key, label, symbol]) => (
            <button
              key={key}
              type="button"
              role="checkbox"
              aria-label={label}
              aria-checked={!!options[key]}
              title={label}
              className={`editor-search-option${key === 'wholeWord' ? ' is-whole-word' : ''}`}
              onClick={() => setOptions((old) => ({ ...old, [key]: !old[key] }))}
            >
              {symbol}
            </button>
          ))}
        </div>
      </div>
      {property && (
        <p className="editor-search-help" title="只查找文本候选位置，不代表CSS最终生效来源">
          <code>{property}</code>
          <span>源码候选</span>
        </p>
      )}
      <div
        className={`editor-search-summary${results?.error ? ' is-error' : ''}`}
        role="status"
        aria-label="源码搜索状态"
        aria-live="polite"
      >
        {busy
          ? '正在搜索…'
          : (results?.error ??
            (!query
              ? `${files.length} 个文件`
              : `${results?.count ?? 0} 处匹配 · ${results?.groups.length ?? 0} 个文件`))}
        {results?.truncated && !busy && !results.error && (
          <span
            className="editor-search-truncated"
            title="最多500处匹配、2000文件，单文件200万/合计800万字符"
          >
            已截断
          </span>
        )}
      </div>
      {!busy && query && results?.count === 0 && !results.error && property && (
        <div className="editor-search-candidates">
          {propertySearchCandidates(property)
            .filter((value) => value !== query)
            .map((value) => (
              <button
                type="button"
                key={value}
                title={`改为查找 ${value}`}
                onClick={() => {
                  setOptions({});
                  onQueryChange(value);
                }}
              >
                {value}
              </button>
            ))}
        </div>
      )}
      <div className="editor-search-results">
        {!busy && query && results?.count === 0 && !results.error && (
          <p className="editor-search-empty">没有匹配内容</p>
        )}
        {!busy &&
          !results?.error &&
          results?.groups.map((group) => {
            const parts = group.path.split('/');
            const filename = parts.pop()!;
            const directory = parts.join('/');
            return (
              <details className="editor-search-group" key={group.path} open>
                <summary className="editor-search-path" title={group.path}>
                  <Icon name="chevron" />
                  <FileTypeIcon path={group.path} />
                  <span className="editor-search-file-identity">
                    <span className="editor-search-file-name">{filename}</span>
                    {directory && <span className="editor-search-directory">{directory}</span>}
                  </span>
                  <span className="editor-search-count">{group.matches.length}</span>
                </summary>
                {group.matches.map((match) => {
                  const key = `${match.path}:${match.line}:${match.column}`;
                  return (
                    <button
                      type="button"
                      className={`editor-search-match${selectedMatch === key ? ' is-selected' : ''}`}
                      key={`${match.line}:${match.column}`}
                      title={`${match.path}:${match.line}:${match.column}`}
                      aria-label={`${match.path}，第 ${match.line} 行，第 ${match.column} 列`}
                      aria-current={selectedMatch === key ? 'location' : undefined}
                      onClick={() => {
                        setSelectedMatch(key);
                        onSelect(match);
                      }}
                    >
                      <span className="editor-search-location">
                        {match.line}:{match.column}
                      </span>
                      <code>
                        {match.snippet.slice(0, match.snippetColumn)}
                        <mark>
                          {match.snippet.slice(
                            match.snippetColumn,
                            match.snippetColumn + match.length,
                          )}
                        </mark>
                        {match.snippet.slice(match.snippetColumn + match.length)}
                      </code>
                    </button>
                  );
                })}
              </details>
            );
          })}
      </div>
    </section>
  );
}
