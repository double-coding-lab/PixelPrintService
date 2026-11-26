import path from 'node:path';
import { readTemplateResources } from '../src/functions/d2c/workspace/resources';

// 校验实际发布目录，避免只用测试夹具而漏掉镜像中的必需模板。
const bundle = await readTemplateResources(path.resolve('pixelprint'));
console.log(`平台模板校验通过：${bundle.files.length} 个文件，版本 ${bundle.sourceVersion}`);
