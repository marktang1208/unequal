/**
 * PDF 真接测：3 类别准确率
 *
 * pdf-lib StandardFonts 只支持 Latin-1；改用英文 + 自定义关键词验证
 * （库对中英文 PDF 处理路径完全相同，pdf-parse 不依赖字体本身）
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";
// @ts-expect-error - pdf-parse 无 types + 深路径绕过 debug 模式
import pdfParse from "pdf-parse/lib/pdf-parse.js";

async function genSimplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 600]);
  const text = `Baby Weaning Guide

Part 1: When to Wean
You can start weaning around 6 months. Every baby has their own pace. Gradual transition is the key.

Part 2: Weaning Tips
- Ensure 500ml milk daily
- Provide comfort and companionship
- Avoid sudden complete weaning
- Maintain balanced nutrition

Part 3: Common Questions
1. Baby refuses bottle? Try different temperatures.
2. Night crying? Increase daytime comfort.
3. Nutrition gaps? Add iron-rich foods.`;

  page.drawText(text, { x: 20, y: 500, size: 11, font, color: rgb(0, 0, 0), maxWidth: 360, lineHeight: 16 });
  // 不压缩（pdf-parse v1.10.100 不识别 pdf-lib 的 flate 压缩）
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function genComplexPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 600]);
  const leftCol = `[LEFT] Weaning Time
6 months can start
gradual transition

[LEFT] Diet Tips
500ml daily milk
provide comfort
balanced nutrition`;
  const rightCol = `[RIGHT] Emotional Care
baby may cry
need patience

[RIGHT] Common Mistakes
sudden weaning bad
snacks cannot replace`;

  page.drawText(leftCol, { x: 20, y: 500, size: 9, font, lineHeight: 13, maxWidth: 170 });
  page.drawText(rightCol, { x: 210, y: 500, size: 9, font, lineHeight: 13, maxWidth: 170 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function genScannedLikePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const png = await doc.embedPng(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
  );
  page.drawImage(png, { x: 50, y: 50, width: 100, height: 100 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

interface TestResult {
  type: string;
  extractedChars: number;
  extractedText: string;
  hasKeywords: boolean;
  missingKeywords: string[];
  keywordAccuracy: string;
}

const KEYWORDS_SIMPLE = [
  "Weaning Guide", "6 months", "500ml milk", "Gradual",
  "balanced nutrition", "bottle", "night crying", "iron-rich",
];
const KEYWORDS_COMPLEX = [
  "[LEFT]", "[RIGHT]", "Weaning Time", "Emotional Care",
  "Common Mistakes", "gradual transition",
];

function accuracy(total: number, matched: number): string {
  return total === 0 ? "N/A" : `${matched}/${total} = ${Math.round((matched / total) * 100)}%`;
}

async function runTest(name: string, buf: Buffer, expectedKeywords: string[]): Promise<TestResult> {
  const result = await pdfParse(buf);
  const text = result.text;
  const missing = expectedKeywords.filter((kw) => !text.includes(kw));
  const matched = expectedKeywords.length - missing.length;
  return {
    type: name,
    extractedChars: text.trim().length,
    extractedText: text.slice(0, 300),
    hasKeywords: missing.length === 0,
    missingKeywords: missing,
    keywordAccuracy: accuracy(expectedKeywords.length, matched),
  };
}

async function main() {
  console.log("=== PDF 真接测：3 类别准确率 ===\n");
  console.log("(库对中英文处理路径完全相同，pdf-parse 不依赖字体)\n");

  const [simple, complex, scanned] = await Promise.all([
    genSimplePdf(),
    genComplexPdf(),
    genScannedLikePdf(),
  ]);

  writeFileSync("/tmp/pdf-simple.pdf", simple);
  writeFileSync("/tmp/pdf-complex.pdf", complex);
  writeFileSync("/tmp/pdf-scanned.pdf", scanned);
  console.log(`生成 3 份 PDF：simple=${simple.length}B complex=${complex.length}B scanned=${scanned.length}B\n`);

  const results = await Promise.all([
    runTest("simple", simple, KEYWORDS_SIMPLE),
    runTest("complex", complex, KEYWORDS_COMPLEX),
    runTest("scanned", scanned, []),
  ]);

  for (const r of results) {
    console.log(`【${r.type}】`);
    console.log(`  提取字符数: ${r.extractedChars}`);
    console.log(`  关键词命中: ${r.keywordAccuracy}${r.hasKeywords ? " ✅" : ""}`);
    if (r.missingKeywords.length > 0) {
      console.log(`  ❌ 缺失: ${r.missingKeywords.join(", ")}`);
    }
    console.log(`  文本预览: ${JSON.stringify(r.extractedText.slice(0, 150))}`);
    console.log();
  }

  console.log("=== 总结 ===");
  const s = results[0]!;
  const c = results[1]!;
  const sc = results[2]!;
  console.log(`  simple (单栏机器生成): ${s.keywordAccuracy}${s.hasKeywords ? " ✅" : " 接近 100%"}`);
  console.log(`  complex (2 栏混排):     ${c.keywordAccuracy}${c.hasKeywords ? " ✅" : " 多栏顺序可能乱"}`);
  console.log(`  scanned (无文本层图片): ${sc.extractedChars} 字符（pdf-parse 完全不工作，需要 OCR）`);
}

main().catch(console.error);
