import { describe, expect, it } from "vitest";
import { errorPage, js, successPage } from "@/lib/integrations/oauth-popup";

const XSS = '</script><img src=x onerror="alert(1)">';

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

describe("oauth popup script escaping", () => {
  it("never emits a raw </script> from an interpolated value", () => {
    expect(js(XSS)).not.toContain("</script>");
    expect(js(XSS)).toContain("\\u003c");
  });

  it("keeps an attacker-controlled error_description inside the string literal", async () => {
    // The callback route reflects the provider's error_description BEFORE the
    // state/CSRF check, so this path is reachable unauthenticated.
    const html = await bodyOf(errorPage("twitter", XSS, "https://app.example", 400));
    const script = html.slice(html.indexOf("<script>") + 8);
    expect(script).not.toContain("</script><img");
    expect(script).toContain("\\u003c/script");
    // The visible body is HTML-escaped by esc().
    expect(html).toContain("&lt;/script&gt;");
  });

  it("escapes the provider segment and the account name too", async () => {
    const errHtml = await bodyOf(errorPage(XSS, "nope", "https://app.example", 401));
    expect(errHtml.split("<script>")[1]).not.toContain("</script><img");

    const okHtml = await bodyOf(successPage("linkedin", XSS, "https://app.example"));
    expect(okHtml.split("<script>")[1]).not.toContain("</script><img");
  });
});
