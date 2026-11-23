import { createHash } from 'node:crypto';
import { toolIssue } from '../toolFeedback';

/** 每个 Agent 独立记住实际读写回执；省略摘要不等于自动接受当前文件的未知版本。 */
export function createFileVersions() {
  const versions = new Map<string, string>();
  function remember(path: string, sha256: unknown) {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return;
    versions.delete(path);
    versions.set(path, sha256);
    if (versions.size > 256) versions.delete(versions.keys().next().value!);
  }
  return {
    /** 只登记真实工具返回的完整文件摘要，不从源码片段或模型提供的值推断。 */
    read(path: string, value: string) {
      try {
        const page = JSON.parse(value);
        if (typeof page.content === 'string') remember(path, page.sha256);
      } catch {
        // 非文本结果不提供编辑依据。
      }
    },
    /** 成功整文件保存的内容就是本 Agent 已知的新基线。 */
    wrote(path: string, content: string) {
      remember(path, createHash('sha256').update(content).digest('hex'));
    },
    /** 显式摘要保持原值；缺少回执时必须先读文件，不能猜测或读取最新版本后覆盖。 */
    expected(path: string, explicit?: string | null): string {
      const version = explicit ?? versions.get(path);
      if (!version)
        throw toolIssue(
          'INVALID_ARGUMENT',
          'VALIDATION_FAILED',
          { stage: 'tool', tool: 'edit_file' },
          {
            path: path.slice(0, 1024),
            detail: '本Agent尚无该文件的读写回执，请先read_file；也可提供已读取的expectedSha256。',
          },
        );
      return version;
    },
    /** 成功局部编辑采用服务端回执；冲突后旧版本不再作为隐式依据。 */
    edited(path: string, value: string) {
      try {
        const result = JSON.parse(value);
        if (result.ok === true) remember(path, result.sha256);
        if (result.code === 'EDIT_REVISION_CONFLICT') versions.delete(path);
      } catch {
        // 无新摘要的兼容回执不能推断新的文件基线。
      }
    },
  };
}
