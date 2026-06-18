// pdf-parse 1.1.1 没有自带 .d.ts —— 加一个最小声明
declare module "pdf-parse" {
  interface PdfResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }
  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PdfResult>;
  export default pdfParse;
}
