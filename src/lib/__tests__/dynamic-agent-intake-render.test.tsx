import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * WHAT THE DYNAMIC INTAKE FORM ACTUALLY PAINTS, asked of the RENDER.
 *
 * Phase 8 asks for "component tests: dynamic intake rendering for each field
 * type, required/format validation blocking submit, and no regression at
 * existing call sites". A source scan cannot answer the first of those: the
 * component branches per `field.type`, and `{field.type === "select" ? <Select/>
 * : null}` is satisfied by the identifier appearing in the file whether or not
 * the branch ever renders. Only rendering each field type can tell those apart
 * — the same reasoning seat-remove-confirm-render.test.tsx documents for its
 * own gated sentence.
 *
 * `renderToStaticMarkup` under `environment: "node"` is this repo's own
 * established pattern for that (react-dom/server, ~10 existing suites). An
 * earlier version of these tests asserted there was no such pattern here and
 * skipped the render coverage on that basis; that was wrong, and this file is
 * the correction.
 *
 * The VALUE-dependent half of validation (an error message appearing after a
 * failed submit) is not reachable through a static render, which has no event
 * loop to click with — those rules are unit-tested directly against the
 * exported validators in dynamic-agent-intake-form.test.ts, and the assertions
 * here cover what the first paint owes the client: the control, its label, its
 * help text, its required marker, its options, its accept filter.
 */

vi.mock("server-only", () => ({}));

import { DynamicAgentIntakeForm } from "@/components/dynamic-agent-intake-form";
import type { DynamicAgentInputDef } from "@/lib/types";

function field(patch: Partial<DynamicAgentInputDef> = {}): DynamicAgentInputDef {
  return { key: "company_name", type: "text", label: "Company name", required: true, order: 0, ...patch };
}

function paint(inputSchema: DynamicAgentInputDef[]): string {
  return renderToStaticMarkup(
    <DynamicAgentIntakeForm inputSchema={inputSchema} clientId="c1" onSubmit={() => {}} />,
  );
}

describe("one control per field type", () => {
  it("text renders a single-line input, not a textarea", () => {
    const html = paint([field({ type: "text" })]);
    // The ui.tsx Input primitive leaves `type` unset, which is HTML's default
    // of "text" — so the assertion is "an input that is not a file input",
    // not a literal type="text" that React never emits.
    expect(html).toMatch(/<input(?![^>]*type="file")[^>]*\/>/);
    expect(html).not.toContain("<textarea");
  });

  it("textarea renders a textarea, not a single-line input", () => {
    const html = paint([field({ type: "textarea", key: "brief", label: "Brief" })]);
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
  });

  it("select renders a select with a placeholder plus one option per admin-authored choice", () => {
    const html = paint([field({ key: "tone", type: "select", label: "Tone", options: ["Warm", "Direct"] })]);
    expect(html).toContain("<select");
    expect(html).toContain(">Warm</option>");
    expect(html).toContain(">Direct</option>");
    // the empty placeholder so a required select starts genuinely unanswered
    // (React also marks it selected, hence the tolerant match)
    expect(html).toMatch(/<option value=""[^>]*>Select/);
  });

  it("file renders a multi-capable file input", () => {
    const html = paint([field({ key: "brief_doc", type: "file", label: "Brief" })]);
    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).toMatch(/<input[^>]*multiple/);
  });

  it("image renders a single file input — an image field takes one image", () => {
    const html = paint([field({ key: "logo", type: "image", label: "Logo" })]);
    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).not.toMatch(/<input[^>]*multiple/);
  });

  it("renders every type together in one form, each exactly once", () => {
    const html = paint([
      field({ key: "a", type: "text", label: "A", order: 0 }),
      field({ key: "b", type: "textarea", label: "B", order: 1 }),
      field({ key: "c", type: "select", label: "C", options: ["x"], order: 2 }),
      field({ key: "d", type: "file", label: "D", order: 3 }),
      field({ key: "e", type: "image", label: "E", order: 4 }),
    ]);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html.match(/type="file"/g)).toHaveLength(2);
    for (const label of ["A", "B", "C", "D", "E"]) expect(html).toContain(`>${label}`);
  });
});

describe("what the admin authored reaches the client's screen", () => {
  it("paints the admin's label and help text", () => {
    const html = paint([field({ label: "Company name", helpText: "As it appears on the invoice." })]);
    expect(html).toContain("Company name");
    expect(html).toContain("As it appears on the invoice.");
  });

  it("marks a required field and leaves an optional one unmarked", () => {
    expect(paint([field({ required: true })])).toContain("*");
    const optional = paint([field({ required: false, helpText: "" })]);
    expect(optional).not.toContain(">*<");
  });

  it("puts the admin's accept list on the input as the picker's default filter", () => {
    const html = paint([field({ key: "logo", type: "image", label: "Logo", accept: "image/png,image/jpeg" })]);
    expect(html).toContain('accept="image/png,image/jpeg"');
  });

  it("renders fields in the admin's `order`, not the array's", () => {
    const html = paint([
      field({ key: "second", label: "Second", order: 1 }),
      field({ key: "first", label: "First", order: 0 }),
    ]);
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
  });

  it("escapes an admin-authored label rather than injecting it as markup", () => {
    const html = paint([field({ label: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the form's own shell", () => {
  it("says so plainly when the admin declared no questions at all", () => {
    const html = paint([]);
    expect(html).toMatch(/no additional questions/i);
    expect(html).not.toContain("<textarea");
    expect(html).not.toMatch(/<input[^>]*type="file"/);
  });

  it("always paints a submit button, so a no-question agent is still runnable", () => {
    expect(paint([])).toMatch(/<button[^>]*type="submit"/);
    expect(paint([field()])).toMatch(/<button[^>]*type="submit"/);
  });

  it("gives every control an id its label points at", () => {
    const html = paint([field({ key: "company_name" })]);
    const forMatch = /<label[^>]*for="([^"]+)"/.exec(html);
    expect(forMatch).not.toBeNull();
    expect(html).toContain(`id="${forMatch?.[1]}"`);
  });

  it("renders no client-facing copy in any language other than English", () => {
    // The Studio's own chrome is English-only (DoD); admin-authored labels are
    // stored data and are whatever the admin typed, so only the shell is checked.
    const html = paint([]);
    expect(html).not.toMatch(/[֐-׿]/); // Hebrew block
  });
});

describe("SCRUM-133: the admin's placeholder reaches the client's control", () => {
  it("paints it on a text input", () => {
    const html = paint([field({ type: "text", placeholder: "e.g. Acme Industries" })]);
    expect(html).toContain('placeholder="e.g. Acme Industries"');
  });

  it("paints it on a textarea", () => {
    const html = paint([field({ key: "brief", type: "textarea", label: "Brief", placeholder: "Paste it here" })]);
    expect(html).toContain('placeholder="Paste it here"');
  });

  it("emits no placeholder attribute at all when the admin set none", () => {
    expect(paint([field({ type: "text" })])).not.toContain("placeholder=");
  });

  it("keeps it separate from help text — both render, and the help text is the persistent one", () => {
    const html = paint([
      field({ type: "text", helpText: "As it appears on the invoice.", placeholder: "e.g. Acme" }),
    ]);
    expect(html).toContain("As it appears on the invoice.");
    expect(html).toContain('placeholder="e.g. Acme"');
  });

  it("escapes it rather than injecting it as markup", () => {
    const html = paint([field({ type: "text", placeholder: '"><script>alert(1)</script>' })]);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
