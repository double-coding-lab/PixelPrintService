import assert from 'node:assert/strict';
import test from 'node:test';
import { appPath, readAppRoute } from '../web/src/workspace/appRoutes';

const routes = [
  { view: 'workbench' },
  { view: 'workbench', workspaceId: 'space-a', sessionId: 'session-b' },
  { view: 'works' },
  { view: 'works', versionId: 'version-c' },
  { view: 'my-works' },
  { view: 'my-works', resourceId: 'work-d' },
  { view: 'plaza' },
  { view: 'plaza', resourceId: 'share-e' },
] as const;
for (const route of routes) {
  test(`页面路径可刷新与解析: ${appPath(route)}`, () => {
    const path = appPath(route);
    assert.ok(!path.includes('?'));
    assert.equal(appPath(readAppRoute(new URL(path, 'http://localhost'))), path);
  });
}

test('旧查询定位兼容并转换为路径，规范路径优先于旧查询', () => {
  for (const [legacy, expected] of [
    ['/?view=plaza&share=a', '/plaza/a'],
    ['/?view=my-works&work=b', '/plaza/saved/b'],
    ['/slbhealthcheck.html?view=my-works&work=b', '/plaza/saved/b'],
    ['/works/saved', '/plaza/saved'],
    ['/works/saved/b', '/plaza/saved/b'],
    ['/plaza/saved?view=plaza&share=saved', '/plaza/saved'],
    ['/plaza/saved/b?view=works&version=x', '/plaza/saved/b'],
    ['/?view=works&version=c', '/works/versions/c'],
    ['/slbhealthcheck.html?workspace=w&session=s', '/workbench/w/sessions/s'],
    ['/?session=s', '/workbench'],
    ['/plaza/a?view=works&version=c', '/plaza/a'],
    ['/invalid?view=plaza', '/workbench'],
    ['/plaza/%zz', '/workbench'],
  ])
    assert.equal(appPath(readAppRoute(new URL(legacy, 'http://localhost'))), expected);
});

test('定位 ID 按路径段编码，特殊字符不能创建额外路由', () => {
  const route = { view: 'plaza', resourceId: '设计/一?x=#y' } as const;
  assert.equal(appPath(route), '/plaza/%E8%AE%BE%E8%AE%A1%2F%E4%B8%80%3Fx%3D%23y');
  assert.deepEqual(readAppRoute(new URL(appPath(route), 'http://localhost')), route);
});

test('广场saved分类先于分享ID解析，非法深层路径不回退到查询参数', () => {
  for (const path of ['/plaza/saved', '/plaza/saved/'])
    assert.deepEqual(readAppRoute(new URL(path, 'http://localhost')), {
      view: 'my-works',
      resourceId: '',
    });
  assert.deepEqual(readAppRoute(new URL('/plaza/saved/work-a', 'http://localhost')), {
    view: 'my-works',
    resourceId: 'work-a',
  });
  assert.deepEqual(
    readAppRoute(new URL('/plaza/saved/a/extra?view=my-works&work=b', 'http://localhost')),
    { view: 'workbench' },
  );
  const route = { view: 'my-works', resourceId: '设计/一?x=#y' } as const;
  assert.deepEqual(readAppRoute(new URL(appPath(route), 'http://localhost')), route);
});
