import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { storedHistoryToMessages } from './history';
import type { StoredAgentMessage } from '../types';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';

export type GuidanceReader = (
  applied: string[],
) => Promise<Array<{ id: string; message: StoredAgentMessage }>>;

/** The graph commits the input and watermark together before ROOT model execution; retries use stable IDs. */
export function createGuidanceMiddleware(
  read: GuidanceReader,
  transform?: (message: BaseMessage) => BaseMessage,
) {
  return createMiddleware({
    name: 'PixelPrintGuidance',
    stateSchema: z.object({ guidanceApplied: z.array(z.string()).default([]) }),
    beforeModel: async (state) => {
      const applied = state.guidanceApplied ?? [];
      const pending = await read(applied);
      if (!pending.length) return;
      return {
        guidanceApplied: [...applied, ...pending.map((item) => item.id)],
        messages: pending
          .flatMap(({ id, message }) =>
            storedHistoryToMessages([message]).map((value) => new HumanMessage({ ...value, id })),
          )
          .map((message) => transform?.(message) ?? message),
      };
    },
  });
}
