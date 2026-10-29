// This site's measured title styles, as prompt text for the title generator and the article writer.
import { sql } from "@/lib/db";
import { styleBlock, type Test } from "./titles";

/** Empty until the site has measured wins or losses (and if the rank loop tables are not there yet). */
export async function titleStyles(siteId: string): Promise<string> {
  try {
    const tests = (await sql()`select outcome, new_title, old_title from seo_tests where site_id = ${siteId} and outcome in ('win', 'loss') order by changed_on desc limit 20`) as unknown as Test[];
    return styleBlock(tests);
  } catch {
    return "";
  }
}
