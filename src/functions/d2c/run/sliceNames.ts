/** ASCII stems leave ample room for .png within a 255-byte filesystem component. */
export const MAX_SLICE_FILENAME_LENGTH = 160;

/** Fixed design vocabulary, not a general-purpose Chinese translation service. */
const DESIGN_WORDS: Readonly<Record<string, string>> = {
  背景: 'background',
  底图: 'background',
  底色: 'background',
  规则: 'rules',
  活动规则: 'rules',
  返回: 'back',
  返回键: 'back',
  按钮: 'button',
  标题: 'title',
  主标题: 'main-title',
  副标题: 'subtitle',
  券卡: 'coupon-card',
  优惠券: 'coupon',
  代金券: 'voucher',
  券: 'coupon',
  卡片: 'card',
  抽奖: 'lottery',
  转盘: 'wheel',
  福利: 'benefits',
  挂钩: 'hook',
  挂件: 'pendant',
  图片: 'image',
  图标: 'icon',
  照片: 'photo',
  插画: 'illustration',
  头像: 'avatar',
  横幅: 'banner',
  海报: 'poster',
  标志: 'logo',
  装饰: 'decoration',
  遮罩: 'overlay',
  蒙层: 'overlay',
  弹窗: 'modal',
  弹框: 'modal',
  关闭: 'close',
  确认: 'confirm',
  取消: 'cancel',
  提交: 'submit',
  领取: 'claim',
  立即领取: 'claim-now',
  购买: 'buy',
  支付: 'pay',
  分享: 'share',
  下载: 'download',
  更多: 'more',
  查看: 'view',
  详情: 'details',
  箭头: 'arrow',
  首页: 'home',
  导航: 'navigation',
  菜单: 'menu',
  标签: 'label',
  页签: 'tab',
  列表: 'list',
  内容: 'content',
  容器: 'container',
  模块: 'section',
  区块: 'section',
  头部: 'header',
  顶部: 'top',
  底部: 'bottom',
  左侧: 'left',
  右侧: 'right',
  中间: 'center',
  左: 'left',
  右: 'right',
  上: 'top',
  下: 'bottom',
  选中: 'selected',
  未选中: 'unselected',
  默认: 'default',
  禁用: 'disabled',
  成功: 'success',
  失败: 'failure',
  提示: 'hint',
  文案: 'text',
  文字: 'text',
  数字: 'number',
  价格: 'price',
  金额: 'amount',
  奖品: 'prize',
  奖励: 'reward',
  中奖: 'win',
  记录: 'history',
  任务: 'task',
  活动: 'campaign',
  礼包: 'gift-pack',
  礼物: 'gift',
  礼盒: 'gift-box',
  红包: 'red-packet',
  金币: 'coin',
  积分: 'points',
  会员: 'member',
  订单: 'order',
  商品: 'product',
  购物车: 'cart',
  酒店: 'hotel',
  机票: 'flight',
  火车票: 'train-ticket',
  门票: 'ticket',
  日历: 'calendar',
  日期: 'date',
  时间: 'time',
  倒计时: 'countdown',
  搜索: 'search',
  定位: 'location',
  地址: 'address',
  星星: 'star',
  爱心: 'heart',
  勾选: 'check',
  分隔线: 'divider',
  进度条: 'progress',
  二维码: 'qr-code',
};

const DESIGN_TERMS = Object.keys(DESIGN_WORDS).sort((a, b) => b.length - a.length);

/** Reject unsafe or overlong overrides, including unused entries, rather than repairing them. */
export function validateSliceNames(names: Record<string, string>): void {
  if (!names || typeof names !== 'object' || Array.isArray(names)) {
    throw new Error('Slice names must be a filename-stem mapping.');
  }
  for (const [key, value] of Object.entries(names)) {
    if (
      typeof value !== 'string' ||
      value.length > MAX_SLICE_FILENAME_LENGTH ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
    ) {
      throw new Error(
        `Invalid slice filename mapping for ${JSON.stringify(key)}: use ASCII stems of 1-${MAX_SLICE_FILENAME_LENGTH} characters.`,
      );
    }
  }
}

/**
 * Translate complete known design terms and retain ASCII words/numbers as lowercase slugs.
 * Any unknown letter/ideograph rejects the whole translation; punctuation is only a separator.
 * Callers assign ordered image-N fallbacks rather than discarding unknown Chinese or using IDs.
 */
export function englishSliceName(value: string): string | null {
  const words: string[] = [];
  let remaining = value.toLowerCase();
  while (remaining) {
    const ascii = /^[a-z0-9]+/.exec(remaining)?.[0];
    if (ascii) {
      words.push(ascii);
      remaining = remaining.slice(ascii.length);
      continue;
    }
    const term = DESIGN_TERMS.find((entry) => remaining.startsWith(entry));
    if (term) {
      words.push(DESIGN_WORDS[term]);
      remaining = remaining.slice(term.length);
      continue;
    }
    const character = String.fromCodePoint(remaining.codePointAt(0)!);
    if (/[\p{L}\p{N}\p{M}]/u.test(character)) return null;
    remaining = remaining.slice(character.length);
  }
  return words.join('-') || null;
}
