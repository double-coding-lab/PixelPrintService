import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamMembers } from '../web/src/workspace/TeamSettings';
import { PUBLIC_TEAM_ID, PUBLIC_TEAM_NAME } from '../src/shared/publicTeam';

/** 渲染真实成员组件，公开团队说明不能冒充零成员或暴露成员管理入口。 */
test('公开团队显示所有用户含访客及独立凭据说明，不显示成员增删按钮', () => {
  const html = renderToStaticMarkup(
    React.createElement(TeamMembers, {
      team: {
        teamId: PUBLIC_TEAM_ID,
        name: PUBLIC_TEAM_NAME,
        createdUserId: null,
        creatorName: null,
        isOwner: false,
        isPublic: true,
        memberCount: 0,
        members: [],
      },
      pending: false,
      onRemove() {
        throw new Error('Public team must not remove members');
      },
    }),
  );
  assert.match(html, /所有登录用户和访客自动加入/);
  assert.match(html, /凭据各自独立/);
  assert.doesNotMatch(html, /<button|0 人/);
});
