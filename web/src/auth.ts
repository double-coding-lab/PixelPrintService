let redirecting = false;

/** 未登录时由浏览器进入本站登录入口；并发失败只跳一次，当前定位由回跳参数携带。 */
export function redirectToLogin() {
  if (typeof window === 'undefined' || redirecting || window.location.pathname === '/login') return;
  const page = new URL(window.location.href);
  page.searchParams.delete('ticket');
  const returnTo = `${page.pathname}${page.search}${page.hash}`;
  redirecting = true;
  window.location.assign(`/login?${new URLSearchParams({ returnTo })}`);
}
