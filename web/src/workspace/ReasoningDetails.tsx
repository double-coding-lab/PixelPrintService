import React from 'react';
import MarkdownMessage from '../components/MarkdownMessage';

/** 模型返回的思考仅供折叠查看，与正式答复分开；完成后仍保留历史内容。 */
export default function ReasoningDetails({ text, status }: { text: string; status?: string }) {
  if (!text) return null;
  return (
    <details className="model-reasoning">
      <summary>{status === 'streaming' ? '思考中' : '思考'}</summary>
      <MarkdownMessage text={text} />
    </details>
  );
}
