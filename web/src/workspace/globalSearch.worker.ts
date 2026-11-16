import { searchFileContents, type SearchFile, type SearchOptions } from './globalSearch';

/** 独立 Worker 允许宿主终止灾难回溯正则，不占用 UI 线程。 */
self.onmessage = (
  event: MessageEvent<{ files: SearchFile[]; query: string; options: SearchOptions }>,
) => {
  const { files, query, options } = event.data;
  self.postMessage(searchFileContents(files, query, options));
};
