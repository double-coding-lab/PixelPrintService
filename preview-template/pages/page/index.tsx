import './index.scss';

/** 模板自检页，用于验证 React、SCSS 和交互；接入真实产物时替换此目录。 */
export default function PreviewExample() {
  return (
    <main className="preview-example">
      <span className="preview-example__label">PIXELPRINT / PREVIEW</span>
      <h1>预览模板已就绪</h1>
      <p>这是模板示例，还没有加载会话生成的页面。</p>
      <div className="preview-example__steps">
        <span>01</span>
        <div>
          <h2>放入页面源码</h2>
          <p>替换 pages/page/ 内的 React 和 SCSS 文件。</p>
        </div>
        <span>02</span>
        <div>
          <h2>查看真实效果</h2>
          <p>保存后自动更新；构建后得到可独立访问的静态页面。</p>
        </div>
      </div>
      <details>
        <summary>当前支持范围</summary>
        <p>React、TypeScript、SCSS、静态资源及实际 CDN 图片地址。</p>
      </details>
    </main>
  );
}
