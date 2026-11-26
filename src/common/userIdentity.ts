/** 外部身份使用保留前缀，沿用现有工作区、团队和凭据的账号长度约束。 */
export function isExternalUserId(value: string): boolean {
  return (
    /^github-[1-9]\d{0,19}$/.test(value) ||
    /^guest-[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(value)
  );
}
