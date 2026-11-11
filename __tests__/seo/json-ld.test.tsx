/** @jest-environment node */

import { renderToStaticMarkup } from "react-dom/server";
import { JsonLd } from "@/components/seo/JsonLd";

describe("JsonLd", () => {
  it("emits the data as JSON in a ld+json script", () => {
    const html = renderToStaticMarkup(<JsonLd data={{ name: "Asha" }} />);
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('{"name":"Asha"}');
  });

  it("escapes < so a field cannot close the script block", () => {
    const html = renderToStaticMarkup(
      <JsonLd data={{ name: "</script><img src=x onerror=alert(1)>" }} />,
    );
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script>");
    const inner = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(JSON.parse(inner).name).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
  });
});
