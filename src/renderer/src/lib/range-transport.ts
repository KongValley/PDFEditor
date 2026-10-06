import { PDFDataRangeTransport } from 'pdfjs-dist'

/**
 * pdf.js 按需分段传输:每次 requestDataRange 通过 IPC 从主进程内存读取。
 * 读取失败必须自行终止加载(pdf.js 只会一直等数据,不会超时)。
 */
export class DocRangeTransport extends PDFDataRangeTransport {
  private failed = false

  constructor(
    length: number,
    private readonly read: (begin: number, end: number) => Promise<Uint8Array>,
    private readonly onFatal: (err: Error) => void
  ) {
    // initialData=null:无预置数据;progressiveDone=true:不存在渐进流
    super(length, null, true)
  }

  override requestDataRange(begin: number, end: number): void {
    void this.read(begin, end).then(
      (bytes) => this.onDataRange(begin, bytes),
      (err) => {
        if (this.failed) return
        this.failed = true
        this.onFatal(err instanceof Error ? err : new Error(String(err)))
      }
    )
  }
}
