import { describe, expect, it } from "vitest";
import {
  groupRunFiles,
  guessAssetType,
  humanizeItemName,
  normalizeLabSlug,
  pickPrimaryFiles,
  type LabFile,
} from "../lab-outputs-shared";

function file(relPath: string, size = 100): LabFile {
  return {
    name: relPath.split("/").pop()!,
    path: `clients/acme/outputs/instagram-agent/2026-07-06-run/client/${relPath}`,
    relPath,
    size,
  };
}

describe("groupRunFiles", () => {
  it("groups by item folder, per the lab contract's client/ layout", () => {
    const groups = groupRunFiles([
      file("01-hero/01.png"),
      file("01-hero/caption.txt"),
      file("02-promo/01.png"),
      file("02-promo/caption.txt"),
      file("02-promo/about.txt"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["01-hero", "02-promo"]);
    expect(groups[0].files).toHaveLength(2);
    expect(groups[1].files).toHaveLength(3);
  });

  it("puts flat files into a single 'run' group", () => {
    const groups = groupRunFiles([file("article.md"), file("caption.txt")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("run");
  });

  it("handles mixed flat + folder layouts", () => {
    const groups = groupRunFiles([file("README.md"), file("01-item/post.png")]);
    expect(groups.map((g) => g.key).sort()).toEqual(["01-item", "run"]);
  });
});

describe("pickPrimaryFiles", () => {
  it("prefers caption.txt as body and collects images", () => {
    const files = [file("01/03.png"), file("01/01.png"), file("01/caption.txt"), file("01/about.txt")];
    const picked = pickPrimaryFiles(files);
    expect(picked.captionFile?.name).toBe("caption.txt");
    expect(picked.aboutFile?.name).toBe("about.txt");
    expect(picked.imageFiles.map((f) => f.name)).toContain("01.png");
  });

  it("falls back to the largest text deliverable when there is no caption", () => {
    const picked = pickPrimaryFiles([file("post.md", 5000), file("notes.txt", 100), file("hero.png")]);
    expect(picked.captionFile).toBeUndefined();
    expect(picked.textFile?.name).toBe("post.md");
  });

  it("returns the item's data.json metadata file when present", () => {
    const picked = pickPrimaryFiles([
      file("01/caption.txt"),
      file("01/data.json"),
      file("01/01.png"),
    ]);
    expect(picked.dataJsonFile?.name).toBe("data.json");
  });

  it("omits dataJsonFile when there is no data.json", () => {
    const picked = pickPrimaryFiles([file("01/caption.txt"), file("01/01.png")]);
    expect(picked.dataJsonFile).toBeUndefined();
  });

  it("never treats data.json as the text body or an image", () => {
    const picked = pickPrimaryFiles([file("01/data.json"), file("01/hero.png")]);
    expect(picked.textFile).toBeUndefined();
    expect(picked.imageFiles.map((f) => f.name)).not.toContain("data.json");
  });
});

describe("guessAssetType", () => {
  it("maps lab agent folders to platform asset types", () => {
    expect(guessAssetType("instagram-agent")).toBe("instagram_post");
    expect(guessAssetType("instagram-tiktok-agent")).toBe("instagram_post");
    expect(guessAssetType("newsletter-agent")).toBe("email");
    expect(guessAssetType("blog-agent")).toBe("article");
    expect(guessAssetType("linkedin-agent")).toBe("social_post");
    expect(guessAssetType("rebrand")).toBe("note");
  });
});

describe("normalizeLabSlug", () => {
  it("passes through a plain slug", () => {
    expect(normalizeLabSlug("karoslabs")).toBe("karoslabs");
    expect(normalizeLabSlug("  XODigital ")).toBe("xodigital");
  });

  it("extracts the slug from a full GitHub URL", () => {
    expect(
      normalizeLabSlug("https://github.com/karoslabs/karos-agents/tree/main/clients/karoslabs/outputs"),
    ).toBe("karoslabs");
  });

  it("extracts the slug from a repo path", () => {
    expect(normalizeLabSlug("clients/karoslabs/outputs")).toBe("karoslabs");
    expect(normalizeLabSlug("clients/xodigital")).toBe("xodigital");
  });

  it("returns empty for blank input", () => {
    expect(normalizeLabSlug("")).toBe("");
    expect(normalizeLabSlug(null)).toBe("");
    expect(normalizeLabSlug(undefined)).toBe("");
  });
});

describe("humanizeItemName", () => {
  it("strips the item index and dashes", () => {
    expect(humanizeItemName("01-template-launch-hero")).toBe("Template launch hero");
    expect(humanizeItemName("2026-07-06-template-launch")).toBe("Template launch");
    expect(humanizeItemName("run")).toBe("Run");
  });
});
