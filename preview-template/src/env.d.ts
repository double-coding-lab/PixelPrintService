/// <reference types="vite/client" />

declare module '@preview-entry' {
  import type { ComponentType } from 'react';
  const Page: ComponentType;
  export default Page;
}
