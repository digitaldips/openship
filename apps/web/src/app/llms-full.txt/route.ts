import { docsSource } from "@/lib/source";
import { pageToMarkdown, type LlmPage } from "@/lib/llms";

/**
 * `/llms-full.txt` — every docs page concatenated as markdown, for agents that
 * want the whole set in one fetch instead of walking `/llms.txt`.
 */
export const dynamic = "force-static";

export async function GET() {
  const pages = docsSource.getPages() as unknown as LlmPage[];
  const docs = await Promise.all(pages.map((page) => pageToMarkdown(page)));

  return new Response(docs.join("\n\n---\n\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
