import { readFileSync } from "node:fs";
import { RAKAZO_DOCS_URLS } from "./product-doc-index.js";

/** Only fixed product documentation URLs resolve to repository files. */
export function localProductDoc(url: string): string | undefined {
  if (!RAKAZO_DOCS_URLS.includes(url)) return undefined;
  const pathname = new URL(url).pathname;
  const slug = pathname === "/docs.md" ? "getting-started" : pathname.slice(6, -3);
  return readFileSync(new URL(`../../../docs/${slug}.md`, import.meta.url), "utf8")
    .replace(/\bRakazo\b/g, "eTraderBot")
    .replaceAll("https://rakazo.com/docs", "http://localhost:5173/docs")
    .replaceAll("https://app.rakazo.com", "http://localhost:5173")
    .replace(
      /\]\(\.\/([\w-]+)\.md([#\w-]*)\)/g,
      (_, slug: string, hash: string) =>
        `](${slug === "getting-started" ? "/docs.md" : `/docs/${slug}.md`}${hash})`,
    );
}
