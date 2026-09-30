/// <reference types="vite/client" />

import type { PdfAPI } from '@shared/api'

declare global {
  interface Window {
    pdfAPI: PdfAPI
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
