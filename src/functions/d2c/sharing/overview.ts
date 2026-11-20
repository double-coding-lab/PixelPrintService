import { literal } from 'sequelize';

/** 主对话只需要子任务入口；长正文和思考在打开对应子 Agent 后按原接口读取。 */
export function publicOverviewPayload() {
  return literal(`CASE
    WHEN \`kind\` = 'stage' AND JSON_UNQUOTE(JSON_EXTRACT(\`displayPayload\`, '$.stage')) = 'subagent'
    THEN JSON_REMOVE(\`displayPayload\`, '$.message', '$.reasoning')
    ELSE \`displayPayload\`
  END`);
}
