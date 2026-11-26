type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type SavedDraft = { text: string; version: string };

/** 只缓存聊天文本；身份未知时仅留内存，不使用跨用户的匿名持久化键。 */
export function createSessionDraft(
  workspaceId: string,
  sessionId: string,
  storage: () => StorageLike | undefined = () => window.localStorage,
) {
  let key: string | undefined;
  let text = '';
  let revision = 0;
  let version = '';
  let savedVersion = '';

  function read(): SavedDraft | undefined {
    try {
      const value = key && storage()?.getItem(key);
      if (!value) return;
      const saved = JSON.parse(value) as SavedDraft;
      if (
        typeof saved?.text === 'string' &&
        saved.text.length <= 65536 &&
        typeof saved.version === 'string'
      )
        return saved;
    } catch {
      // 禁用存储、配额耗尽或损坏缓存都不影响输入。
    }
  }

  function persist() {
    if (!key) return;
    try {
      const target = storage();
      if (!target) return;
      if (text) target.setItem(key, JSON.stringify({ text, version }));
      else target.removeItem(key);
      savedVersion = text ? version : '';
    } catch {
      // 当前草稿仍留在内存，输入和发送继续可用。
    }
  }

  return {
    get text() {
      return text;
    },
    /** 身份只绑定一次；等待身份时的新输入（包括手动清空）优先于历史缓存。 */
    bindActor(actorKey: string) {
      if (key || !actorKey) return;
      key = `pixelprint:chat-draft:v1:${JSON.stringify([actorKey, workspaceId, sessionId])}`;
      const saved = read();
      savedVersion = saved?.version ?? '';
      if (!revision) {
        text = saved?.text ?? '';
        version = saved?.version ?? '';
      } else persist();
    },
    setText(value: string) {
      text = value;
      revision++;
      version = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${revision}`;
      persist();
    },
    snapshot: () => revision,
    /** 仅确认过的那版输入可清空；编辑后改回同文、切走重进及其他标签页均有版本保护。 */
    clearIfUnchanged(sentRevision: number) {
      if (revision !== sentRevision) return false;
      const saved = read();
      if (saved && saved.version !== savedVersion) return false;
      text = '';
      revision++;
      persist();
      return true;
    },
  };
}
