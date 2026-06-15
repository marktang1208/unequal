import { load } from "cheerio";

export interface ParsedHtml {
  title: string;
  paragraphs: string[];
  totalChars: number;
}

/**
 * HTML → 纯文本段落（cheerio 解析）。
 * - title: 优先 <article> 内的 <h1>，fallback 到 <title>
 * - paragraphs: <article>/<main> 内的所有 <p>，去 HTML 标签，去 header/footer/nav/script/style
 */
export function parseHtml(html: string): ParsedHtml {
  const $ = load(html);

  // title: 优先 article 内的 h1，fallback head title
  const h1 = $("article h1").first().text().trim();
  const headTitle = $("head title").first().text().trim();
  const title = h1 || headTitle || "";

  // 移除 noise
  $("script, style, nav, header, footer").remove();

  // 段落: article/main 内的 p，fallback body p
  const scope = $("article").length > 0 ? $("article p") : $("body p");
  const paragraphs: string[] = [];
  scope.each((_, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
  return { title, paragraphs, totalChars };
}
