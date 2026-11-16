import { paints, prefix, subtree, type Fact, type Data } from './facts';

const geometry = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'RECTANGLE',
  'ELLIPSE',
  'STAR',
  'REGULAR_POLYGON',
  'LINE',
]);
const builtins = [
  'img',
  'bg',
  'bgc',
  'x',
  'input',
  'sub',
  'block',
  'btn',
  'fixed',
  'end',
  'scrollx',
  'scrolly',
  'bl',
  'list',
];

/** Platform-specific policy over shared facts; no source-code or storage inspection. */
export function adapter(target: 'h5' | 'rn') {
  return {
    /** H5 uses pure geometry; RN additionally permits containers and requires three true paths. */
    implicitImage(fact: Fact): boolean {
      if (builtins.some((p) => prefix(fact.node, p))) return false;
      const nodes = subtree(fact)
        .filter((f) => !f.hidden)
        .map((f) => f.node);
      if (nodes.some((n) => builtins.some((p) => prefix(n, p)))) return false;
      return (
        nodes.every(
          (n) => geometry.has(n.type) || (target === 'rn' && ['GROUP', 'FRAME'].includes(n.type)),
        ) &&
        (target === 'h5' ||
          nodes.filter((n) =>
            ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON'].includes(n.type),
          ).length >= 3)
      );
    },
    /** Platform defaults differ; explicit facts are useful even before implementation exists. */
    expected(rule: string): string {
      return (target === 'rn' ? RN_EXPECTED[rule] : H5_EXPECTED[rule]) ?? COMMON_EXPECTED[rule];
    },
    /** R09 RN uses only the last visible gradient, while H5 preserves all gradient layers. */
    buttonGradient(node: Data): boolean {
      const fills = paints(node);
      return target === 'rn' ? gradient(fills.at(-1)) : fills.some(gradient);
    },
    /** Runtime style expectations are explicitly expressed in each platform's property syntax. */
    layout(node: Data): Data {
      const direction = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
      return target === 'rn'
        ? { flexDirection: direction, defaultDirection: 'column' }
        : { display: 'flex', 'flex-direction': direction, defaultDirection: 'row' };
    },
  };
}

/** Only protocol gradient kinds qualify; arbitrary strings cannot introduce rules. */
export function gradient(fill?: Data): boolean {
  return (
    !!fill &&
    ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'].includes(
      fill.type,
    )
  );
}

/** Convert a validated Figma SOLID/stop color without fabricating missing channels. */
export function hex(color: unknown): string | null {
  const c = color as Data | null;
  if (!c || !['r', 'g', 'b'].every((k) => typeof c[k] === 'number' && c[k] >= 0 && c[k] <= 1))
    return null;
  return (
    '#' +
    ['r', 'g', 'b']
      .map((k) =>
        Math.round(c[k] * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Compact instructions; the verified Markdown remains the authoritative detailed reference. */
const COMMON_EXPECTED: Record<string, string> = {
  R02: '记录真实切图到 assets.txt 并在产物引用；保留 nodeId。',
  R03: '为该纯几何子树整体切图，记录 assets.txt，按事实尺寸定位；不展开矢量。',
  R06: '文字颜色取末位可见 SOLID；全不可见时默认 #000000；保留 alpha。',
  R10: '生成后逐节点溯源实际 SOLID 色；排除 R06/R07/R09 已负责的色与系统默认值。',
  R15: '使用一份 .map() 模板和样式，模板绑定代表项 nodeId；数据差异放入列表数据。',
  R16: '含 TEXT 的非 img/bg 容器不得整体切图；按前缀展开文字与交互。',
  R17: '整体切图或 x 忽略子树的后代不得独立渲染或重复绑定 nodeId。',
  R19: '四边 padding = Figma × scale，含零值对账，容差 2；不得凭空增加。',
  R21: '独立渲染节点携带真实 data-node-id；模板只绑定代表项，禁止虚构 id。',
  R22: '生成后检查按钮文字、背景、边框、图片或渐变；空视觉仅 warning，允许合法透明热区。',
  R23: '生成后比较显式宽高与 bbox × scale，容差 4；禁止 1×1 隐藏锚点。',
};

/** H5 expectations use CSS defaults and background/clip semantics. */
const H5_EXPECTED: Record<string, string> = {
  R01: '使用 position: fixed，className + data-node-id；按 constraints 写视口边 top/left/right/bottom: 0。',
  R04: '文字用 span 承载真实渐变/图案；background 后设置 background-clip: text、-webkit-background-clip: text、color: transparent。',
  R05: '父容器 display:flex，按主轴设置方向，justify-content:space-between，align-items:center；不用 margin:auto 模拟。',
  R07: '保留每层可见 fills；CSS background 图层与 Figma 顺序相反，保留颜色、透明度和混合方式。',
  R08: '背景切图写父容器 background-image + background-size；父挂背景 nodeId，不单独生成 img/空 div/伪元素。',
  R09: '按钮 background 取 bgc 子层全部真实 fills 的渐变，不编造色或用纯色替代。',
  R11: '模型判断 CSS 可表达性；复杂几何无法表达则整体切图，简单矩形/圆形用 CSS。',
  R12: 'flat 合并后检查类名冲突，使用 block 语义前缀；独立 CSS Modules 隔离时豁免。',
  R13: '尺寸类输出值 = Figma × unit.scale；单位换算只执行一次。',
  R14: '多个 fixed 按设计层级区分 z-index；底栏/浮钮 >=100，顶栏依层级排列，不能全缺或全相同。',
  R18: 'flex 布局中 VERTICAL 显式 flex-direction:column；HORIZONTAL 为 row（可省略）。',
  R20: 'position:absolute；top/left = (子 bbox − 父 bbox) × scale，容差 4；父为定位容器。',
  R24: '容器 display:flex、flex-direction:row、align-items:baseline；直接文字子层走基线流，免 R20 坐标对账。',
};

/** RN expectations use native defaults, explicit images and documented degradation paths. */
const RN_EXPECTED: Record<string, string> = {
  R01: '放根 View 直接子层，position:absolute、zIndex>=100；按 constraints 贴屏，不进 ScrollView。',
  R04: '渐变文字退化为首 stop 色，IMAGE 文字不比首 stop 色；assets.txt 记录该 nodeId 的 [退化告警]。',
  R05: "父容器按主轴设置 flexDirection，justifyContent:'space-between'，alignItems:'center'。",
  R07: '保留全部可见 fills，底层 View backgroundColor，上层 Image/LinearGradient 分层组合。',
  R08: '父容器内生成独立 Image，position:absolute，宽高取 Figma × scale 数值尺寸，保留 nodeId。',
  R09: '按钮使用已引入的 LinearGradient，或首 stop backgroundColor + assets.txt 对应 nodeId 的 [退化告警]。',
  R11: '模型判断 RN 可表达性；复合 mask/path 不可还原则整体切图，避免 View 近似。',
  R12: 'flat 合并后检查 StyleSheet key 跨文件重名，使用 block 命名空间。',
  R13: '尺寸白名单值按 Figma × scale，responsive 开启时用配置 helper rpx 包装；zIndex/flex/opacity/fontWeight 不包。',
  R14: '多个 fixed 的 zIndex 必须存在且可区分；不强求具体递增次序，动态值不计统计。',
  R18: "HORIZONTAL 显式 flexDirection:'row'（或 row-reverse）；VERTICAL 可省略（默认 column）。",
  R20: "position:'absolute'；top/left = (子 bbox − 父 bbox) × scale，容差 4；不使用 inset 简写。",
  R24: "容器 flexDirection:'row'、alignItems:'baseline'；直接 Text 子层走基线流，免 R20/RN02。",
  RN01: '页面 View>ScrollView>View(scrollContent)，scrollContent 用 minHeight，禁根/内容 overflow:hidden；block 禁重复页面骨架。',
  RN02: '顺流子禁 position/非零 offset/margin；padding 必须有事实来源，flex:1 须 layoutGrow=1 或 FILL 依据。',
  RN03: '背景 Image 宽高必须为事实数值，禁止百分比及 StyleSheet.absoluteFillObject。',
  RN04: 'StyleSheet.create 放独立 styles 文件，JSX 禁静态 inline style 对象；动态样式数组允许。',
};
