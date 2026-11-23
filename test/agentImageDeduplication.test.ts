import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  prepareImageMessages,
  withoutImagePayload,
  type AgentImage,
} from '../src/functions/d2c/run/agent/images';

// Actual one-pixel PNG bytes, carried by real LangChain content blocks.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const image: AgentImage = { mimeType: 'image/png', data: png };
const imageBlock = (ref: string) => ({ type: 'image_url' as const, image_url: { url: ref } });
const human = (...refs: string[]) => new HumanMessage({ content: refs.map(imageBlock) });
const tool = (name: string, imageRef: string, id = name) =>
  new ToolMessage({
    id,
    name,
    tool_call_id: `call-${id}`,
    content: JSON.stringify({ ok: true, path: 'design-reference/root.png', imageRef }),
  });
/** Inspect actual multimodal blocks rather than counting base64-looking text. */
function blocks(messages: BaseMessage[]) {
  return messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
}
function payloads(messages: BaseMessage[]) {
  return blocks(messages).filter((block) => block.type === 'image_url');
}
function texts(messages: BaseMessage[]) {
  return blocks(messages).flatMap((block) => (block.type === 'text' ? [block.text as string] : []));
}

/** Duplicate pointers must identify an actual image block in this exact request. */
function assertPointers(messages: BaseMessage[], expected: number) {
  let count = 0;
  for (const text of texts(messages)) {
    const match = /本次请求已在第 (\d+) 条会话消息的第 (\d+) 个内容块/.exec(text);
    if (!match) continue;
    const content = messages[Number(match[1]) - 1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[Number(match[2]) - 1].type, 'image_url');
    count++;
  }
  assert.equal(count, expected);
}

test('same trusted ref across human blocks and preview results has one payload and one resolution', async () => {
  const ref = `attachment://${'a'.repeat(64)}`;
  const original = [
    new SystemMessage('fixed instructions'),
    new HumanMessage({
      id: 'first',
      name: 'feedback',
      additional_kwargs: { source: 'attachment-upload', custom: { locale: 'zh-CN' } },
      response_metadata: { trace: 'offline-trace' },
      content: [{ type: 'text', text: 'baseline' }, imageBlock(ref)],
    }),
    new AIMessage('checking'),
    human(ref, ref),
    tool('inspect_preview', ref),
  ];
  const saved = original.map((message) => message.toDict());
  for (const message of original) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) Object.freeze(block);
      Object.freeze(message.content);
    }
  }
  const calls: string[] = [];
  const view = await prepareImageMessages(original, async (value) => {
    calls.push(value);
    return image;
  });
  assert.deepEqual(calls, [ref]);
  assert.equal(view.hasImages, true);
  assert.equal(payloads(view.messages).length, 1);
  assert.equal(
    JSON.stringify(view.messages).split('data:image/png;base64,').length - 1,
    1,
    'serialized view contains no hidden payload copies',
  );
  assert.deepEqual(
    payloads(view.messages)[0],
    imageBlock(`data:image/png;base64,${png.toString('base64')}`),
  );
  assertPointers(view.messages, 3);
  for (const field of ['id', 'name', 'additional_kwargs', 'response_metadata'] as const)
    assert.deepEqual(view.messages[1][field], original[1][field]);
  assert.ok(Object.keys(view.messages[1].toDict().data).every((key) => !key.startsWith('lc_')));

  assert.ok(
    texts(view.messages)
      .filter((text) => text.startsWith(`[图片引用 ${ref}；`))
      .every((text) => text.includes('第 2 条会话消息的第 2 个内容块')),
  );
  assert.match(texts(view.messages).join('\n'), /实际运行截图/);
  assert.equal(view.messages[4], original[4], 'tool result is retained verbatim');
  assert.deepEqual(
    original.map((message) => message.toDict()),
    saved,
  );
  assert.doesNotMatch(JSON.stringify(saved), /data:image|base64/);
});

test('repeated design baseline tool reads add one image while retaining every original tool result', async () => {
  const ref = `artifact://${'b'.repeat(64)}`;
  const original = [tool('read_file', ref, 'one'), tool('read_file', ref, 'two')];
  const calls: string[] = [];
  const view = await prepareImageMessages(original, async (value) => {
    calls.push(value);
    return image;
  });
  assert.deepEqual(calls, [ref]);
  assert.equal(payloads(view.messages).length, 1);
  assert.equal(view.messages[0], original[0]);
  assert.equal(view.messages[1], original[1]);
  assert.match(texts(view.messages).join('\n'), /工作区原图/);
  assert.match(texts(view.messages).join('\n'), /不是运行预览截图/);
  assert.ok(
    texts(view.messages).some((text) => text.includes('第 2 个及后续内容块') && text.includes(ref)),
  );
});

test('different refs with identical bytes keep design and runtime provenance separate', async () => {
  const designRef = `artifact://${'c'.repeat(64)}`;
  const screenshotRef = `attachment://${'d'.repeat(64)}`;
  const original = [tool('read_file', designRef), tool('inspect_preview', screenshotRef)];
  const calls: string[] = [];
  const view = await prepareImageMessages(original, async (ref) => {
    calls.push(ref);
    return image;
  });
  assert.deepEqual(calls, [designRef, screenshotRef]);
  assert.equal(
    payloads(view.messages).length,
    2,
    'deduplication is deliberately per ref, not per byte hash',
  );
  assert.match(texts([view.messages[2]]).join('\n'), /工作区原图/);
  assert.match(texts([view.messages[3]]).join('\n'), /实际运行截图/);
  assert.equal(view.hasImages, true);
});

test('latest four distinct refs win, with repeated recent feedback and runtime screenshots keeping priority', async () => {
  const old = 'attachment://old';
  const recentFeedback = 'attachment://recent-feedback';
  const design = `artifact://${'e'.repeat(64)}`;
  const screenshot = `preview://${'f'.repeat(64)}`;
  const original = [
    human(old),
    human(recentFeedback),
    human('attachment://middle'),
    human('attachment://newer'),
    human(recentFeedback, recentFeedback),
    tool('read_file', design),
    tool('inspect_preview', screenshot),
  ];
  const calls: string[] = [];
  const view = await prepareImageMessages(original, async (ref) => {
    calls.push(ref);
    return image;
  });
  assert.deepEqual(calls, ['attachment://newer', recentFeedback, design, screenshot]);
  assert.equal(payloads(view.messages).length, 4);
  assert.equal(view.hasImages, true);
  assert.match(texts(view.messages).find((text) => text.includes(old))!, /本次未载入/);
  assertPointers(view.messages, 2);
  assert.match(texts(view.messages).join('\n'), /实际运行截图/);
});

test('a new request, retry or compacted history rematerializes its remaining unique image', async () => {
  const ref = 'attachment://retained';
  const original = [human(ref), human(ref, ref)];
  const saved = original.map((message) => message.toDict());
  let calls = 0;
  const resolve = async () => {
    calls++;
    return image;
  };
  for (const history of [original, original, original.slice(1)]) {
    const view = await prepareImageMessages(history, resolve);
    assert.equal(view.hasImages, true);
    assert.equal(payloads(view.messages).length, 1);
    assertPointers(view.messages, history.length === 1 ? 1 : 2);
  }
  assert.equal(calls, 3, 'no cross-request already-seen state');
  assert.deepEqual(
    original.map((message) => message.toDict()),
    saved,
  );
});

test('missing resolver sanitizes image blocks, emits no image and never claims visual evidence', async () => {
  const original = [
    human(
      'attachment://missing',
      `data:image/png;base64,${png.toString('base64')}`,
      'https://example.invalid/image.png',
    ),
    tool('read_file', `artifact://${'1'.repeat(64)}`),
  ];
  const saved = original.map((message) => message.toDict());
  const view = await prepareImageMessages(original);
  assert.equal(view.hasImages, false);
  assert.equal(payloads(view.messages).length, 0);
  assert.doesNotMatch(JSON.stringify(view.messages), /data:image/);
  assert.doesNotMatch(
    JSON.stringify(view.messages.map((message) => message.toDict())),
    /data:image/,
  );
  assert.match(texts(view.messages).join('\n'), /不得声称已查看/);
  assert.match(texts(view.messages).join('\n'), /重新读取原图片路径/);
  assert.deepEqual(
    original.map((message) => message.toDict()),
    saved,
  );
});

test('null and malformed resolver results remain short unavailable references', async () => {
  const originals = [human('attachment://null', 'attachment://malformed', 'attachment://valid')];
  const calls: string[] = [];
  const view = await prepareImageMessages(originals, async (ref) => {
    calls.push(ref);
    if (ref.endsWith('malformed'))
      return { mimeType: 'image/png', data: null } as unknown as AgentImage;
    return ref.endsWith('valid') ? image : null;
  });
  assert.equal(calls.length, 3);
  assert.equal(view.hasImages, true);
  assert.equal(payloads(view.messages).length, 1);
  assert.equal(texts(view.messages).filter((text) => text.includes('本次未载入')).length, 2);
  const unavailable = await prepareImageMessages([human('attachment://null')], async () => null);
  assert.equal(unavailable.hasImages, false);
  assert.equal(payloads(unavailable.messages).length, 0);
  assert.match(texts(unavailable.messages).join('\n'), /不得声称已查看/);
});

test('resolver storage, lease and cancellation errors propagate unchanged without mutating history', async () => {
  const original = [human('attachment://error', 'attachment://error')];
  const saved = original.map((message) => message.toDict());
  for (const error of [
    new Error('STORAGE_UNAVAILABLE'),
    new Error('LEASE_LOST'),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ]) {
    let calls = 0;
    await assert.rejects(
      prepareImageMessages(original, async () => {
        calls++;
        throw error;
      }),
      (received) => received === error,
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      original.map((message) => message.toDict()),
      saved,
    );
  }
});

test('empty, over-10MiB and unsupported images are not materialized or reported as present', async () => {
  for (const invalid of [
    { mimeType: 'image/png', data: Buffer.alloc(0) },
    { mimeType: 'image/png', data: Buffer.alloc(10 * 1024 * 1024 + 1) },
    { mimeType: 'image/svg+xml', data: png },
    { mimeType: 'image/gif', data: png },
  ]) {
    let calls = 0;
    const view = await prepareImageMessages(
      [human('attachment://invalid', 'attachment://invalid')],
      async () => {
        calls++;
        return invalid;
      },
    );
    assert.equal(calls, 1);
    assert.equal(view.hasImages, false);
    assert.equal(payloads(view.messages).length, 0);
    assert.ok(texts(view.messages).every((text) => text.includes('不得声称已查看')));
  }
});

test('exactly 10MiB remains allowed once and each supported MIME retains its data URL', async () => {
  const maximum = Buffer.alloc(10 * 1024 * 1024);
  png.copy(maximum);
  const view = await prepareImageMessages(
    [human('attachment://max', 'attachment://max')],
    async () => ({ mimeType: 'image/png', data: maximum }),
  );
  assert.equal(view.hasImages, true);
  assert.equal(payloads(view.messages).length, 1);
  const block = payloads(view.messages)[0] as unknown as { image_url: { url: string } };
  assert.equal(Buffer.from(block.image_url.url.split(',')[1], 'base64').length, maximum.length);
  assertPointers(view.messages, 1);
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
    const result = await prepareImageMessages([human('attachment://supported')], async () => ({
      mimeType,
      data: png,
    }));
    assert.equal(result.hasImages, true);
    assert.deepEqual(payloads(result.messages), [
      imageBlock(`data:${mimeType};base64,${png.toString('base64')}`),
    ]);
  }
});

test('untrusted URLs and tool names never reach the resolver and do not create images', async () => {
  const refs = [
    'https://example.invalid/image.png',
    'file:///private/image.png',
    'attachment://../escape',
    `data:image/png;base64,${png.toString('base64')}`,
  ];
  const original = [
    ...refs.map((ref) => human(ref)),
    tool('write_file', `artifact://${'2'.repeat(64)}`),
  ];
  const view = await prepareImageMessages(original, async () => {
    assert.fail('untrusted reference');
  });
  assert.equal(view.hasImages, false);
  assert.equal(payloads(view.messages).length, 0);
});

test('vision refusal removes payloads and duplicate placement claims, leaving original history reusable', async () => {
  const ref = `attachment://${'3'.repeat(64)}`;
  const original = [human(ref, ref), tool('inspect_preview', ref)];
  const saved = original.map((message) => message.toDict());
  const prepared = await prepareImageMessages(original, async () => image);
  const preparedSaved = prepared.messages.map((message) => message.toDict());
  assertPointers(prepared.messages, 2);
  const refused = withoutImagePayload(prepared.messages);
  assert.doesNotMatch(
    JSON.stringify(refused.map((message) => message.toDict())),
    /data:image|本次请求已在第/,
  );
  assert.equal(payloads(refused).length, 0);
  assert.doesNotMatch(JSON.stringify(refused), /data:image|本次请求已在第|载入同一图片/);
  assert.equal(texts(refused).filter((text) => text.includes('网关未接受')).length, 3);
  assert.match(texts(refused).join('\n'), /不能声称看过图片/);
  assert.deepEqual(
    prepared.messages.map((message) => message.toDict()),
    preparedSaved,
  );
  assert.deepEqual(
    original.map((message) => message.toDict()),
    saved,
  );
  const retried = await prepareImageMessages(original, async () => image);
  assert.equal(retried.hasImages, true);
  assert.equal(payloads(retried.messages).length, 1);
});

test('plain text and tool-only histories report hasImages=false', async () => {
  const original = [
    new SystemMessage('system'),
    new HumanMessage('text'),
    new AIMessage('reply'),
    tool('write_file', 'attachment://ignored'),
  ];
  const view = await prepareImageMessages(original, async () => {
    assert.fail('no image to resolve');
  });
  assert.equal(view.hasImages, false);
  assert.equal(payloads(view.messages).length, 0);
  assert.deepEqual(
    view.messages.map((message) => message.toDict()),
    original.map((message) => message.toDict()),
  );
});
