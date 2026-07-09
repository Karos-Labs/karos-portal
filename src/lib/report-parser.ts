/**
 * Parses a Karos Intel Markdown report into structured ClientReport fields.
 * Designed for the exact template produced by the Karos Intel report generator.
 */

import type {
  ClientReport,
  ClientCompetitor,
  DimensionScore,
  CompetitorRanking,
  Recommendation,
  SWOTMatrix,
  BrandVoiceRow,
  CustomerSentimentEntry,
} from "@/lib/types";

export interface ParsedReport {
  reportDate: string;
  url: string;
  businessType: string;
  founded: string;
  authorization: string;
  cnpj: string;
  minInvestment: string;
  techStack: string;
  reportStatus: string;
  overallScore: number;
  overallGrade: string;
  dimensionScores: DimensionScore[];
  competitorRankings: CompetitorRanking[];
  contentAnalysis: string;
  conversionAnalysis: string;
  seoAnalysis: string;
  geoAnalysis: string;
  positioningAnalysis: string;
  brandAnalysis: string;
  growthAnalysis: string;
  swot: SWOTMatrix;
  recommendations: Recommendation[];
  brandVoiceRows: BrandVoiceRow[];
  brandVoiceArchetypes: Array<{ company: string; archetype: string }>;
  brandVoiceTerritory: string;
  customerSentiment: CustomerSentimentEntry[];
  whitespaceOpportunities: string[];
  /** Raw competitor rows from Wide Scan + Profiles merged, for bulk-creating ClientCompetitor docs */
  competitorRows: Omit<ClientCompetitor, "id" | "clientId" | "source" | "createdAt" | "updatedAt">[];
}

/* ────────────────────── Helpers ────────────────────── */

function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns true when a string is a placeholder value rather than real data. */
function isPlaceholder(s: string): boolean {
  return /^(n\/a|unknown|not\s+provided|not\s+applicable|data\s+unavailable|not\s+available|tbd|pending|—|-|omit\s+line\s+if|omit\s+if)$/i.test(
    s.trim(),
  );
}

/** Extract the value of a `**Field:** value` bullet from markdown. Returns "" for placeholders. */
function bullet(md: string, field: string): string {
  const re = new RegExp(`\\*\\*${escRe(field)}[:\\s]*\\*\\*\\s*(.+)`, "i");
  const val = re.exec(md)?.[1]?.trim() ?? "";
  return isPlaceholder(val) ? "" : val;
}

/**
 * Extract the text content between `## Heading` (matched loosely) and the next
 * same-level heading, or end of string.
 */
function section(md: string, heading: string): string {
  const re = new RegExp(`^#{1,3}[^\\n]*${escRe(heading)}[^\\n]*\\n`, "mi");
  const m = re.exec(md);
  if (!m) return "";
  const after = md.slice(m.index + m[0].length);
  const next = /^#{1,3}\s/m.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

/**
 * Parse a markdown table into a 2-D array of strings (headers are row 0).
 * Strips `**bold**` markers and trims cells.
 */
function parseTable(text: string): string[][] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !l.match(/^\|[-:\s|]+\|$/));
  return lines.map((l) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.replace(/\*\*/g, "").trim()),
  );
}

/** Pull bullet-point list items from a markdown sub-section. Strips placeholders. */
function bullets(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[>\-*\s]+/, "").trim())
    .filter((l) => l.length > 0 && !isPlaceholder(l));
}

/** "AmFi (amfi.finance)" → { name: "AmFi", url: "amfi.finance" } */
function parseNameAndUrl(raw: string): { name: string; url?: string } {
  const match = raw.match(/^([^(]+?)\s*(?:\(([^)]+)\))?$/);
  return { name: match?.[1]?.trim() ?? raw.trim(), url: match?.[2]?.trim() || undefined };
}

/* ────────────────────── Sub-parsers ────────────────────── */

function parseOverallScore(
  sec: string,
): { overallScore: number; overallGrade: string; competitorRankings: CompetitorRanking[] } {
  const rows = parseTable(sec);
  if (rows.length < 2) return { overallScore: 0, overallGrade: "", competitorRankings: [] };

  // Skip header row (row[0])
  const rankings: CompetitorRanking[] = rows.slice(1).map((r) => ({
    company: r[0] ?? "",
    score: parseInt(r[1]?.split("/")?.[0] ?? "0") || 0,
    grade: r[2] ?? "",
    rank: parseInt((r[3] ?? "").replace(/[^0-9]/g, "")) || 0,
    bestDimension: "",
    weakestDimension: "",
  }));

  // The ranking table in the Competitive Ranking section has extra columns
  if (rows[0]?.includes("BEST DIMENSION") || rows[0]?.includes("Best Dimension")) {
    rankings.forEach((r, i) => {
      const row = rows[i + 1];
      r.bestDimension = row?.[4] ?? "";
      r.weakestDimension = row?.[5] ?? "";
    });
  }

  // Client is the last row or the one with the lowest rank (highest number)
  const client = rankings.reduce((a, b) => (b.rank > a.rank ? b : a), rankings[0]);
  return {
    overallScore: client?.score ?? 0,
    overallGrade: client?.grade ?? "",
    competitorRankings: rankings,
  };
}

function parseDimensionScores(sec: string): DimensionScore[] {
  const rows = parseTable(sec);
  if (rows.length < 2) return [];
  // Header: Dimension | Weight | ClientName | Competitor1 | ...
  // Client score is always column index 2
  return rows.slice(1).map((r) => ({
    dimension: r[0] ?? "",
    weight: parseInt(r[1]?.replace("%", "") ?? "0") || 0,
    score: parseInt(r[2] ?? "0") || 0,
  }));
}

function parseWideScan(
  sec: string,
): Omit<ClientCompetitor, "id" | "clientId" | "source" | "createdAt" | "updatedAt">[] {
  const rows = parseTable(sec);
  if (rows.length < 2) return [];
  return rows.slice(1)
    .filter((r) => r[0] && !isPlaceholder(r[0]))
    .map((r) => {
      const tier = r[1]?.trim() ?? "Other";
      const overlap = r[3]?.trim() ?? "Low";
      // Wide Scan cells are often "Company (domain.com)" — split out the URL.
      const { name, url } = parseNameAndUrl(r[0] ?? "");
      return {
        company: name,
        url,
        marketTier: (["Leader", "Challenger", "Niche"].includes(tier) ? tier : "Other") as ClientCompetitor["marketTier"],
        minInvestment: isPlaceholder(r[2] ?? "") ? "" : (r[2] ?? ""),
        overlap: (["High", "Medium", "Low-Med", "Low"].includes(overlap) ? overlap : "Low") as ClientCompetitor["overlap"],
        deepDive: r[4]?.toLowerCase() === "yes",
        keyStrengths: [],
        keyWeaknesses: [],
      };
    });
}

function parseSWOT(sec: string): SWOTMatrix {
  const sub = (heading: string) => {
    const re = new RegExp(`### ${escRe(heading)}\\n([\\s\\S]*?)(?=###|$)`, "i");
    const m = re.exec(sec);
    return m ? bullets(m[1]) : [];
  };
  return {
    strengths: sub("Strengths"),
    weaknesses: sub("Weaknesses"),
    opportunities: sub("Opportunities"),
    threats: sub("Threats"),
  };
}

function parseRecommendations(sec: string): Recommendation[] {
  const recs: Recommendation[] = [];
  let priority = 1;
  let priorityLabel = "";

  for (const line of sec.split("\n")) {
    const pMatch = line.match(/^#+\s+Priority\s+(\d+)[:\s]+(.+)/i);
    if (pMatch) {
      priority = parseInt(pMatch[1]);
      priorityLabel = pMatch[2].trim();
      continue;
    }
    // Numbered item: `5. Title text [Karos: Tag]`
    const iMatch = line.match(/^(\d+)\.\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/);
    if (iMatch) {
      const tag = (iMatch[3] ?? "").replace(/^Karos:\s*/i, "").trim();
      recs.push({
        number: parseInt(iMatch[1]),
        title: iMatch[2].trim(),
        description: "",
        priority,
        priorityLabel,
        tag,
      });
    }
  }
  return recs;
}

function parseBrandVoice(sec: string): {
  brandVoiceRows: BrandVoiceRow[];
  brandVoiceArchetypes: Array<{ company: string; archetype: string }>;
  brandVoiceTerritory: string;
} {
  const rows = parseTable(sec);
  if (rows.length < 2) return { brandVoiceRows: [], brandVoiceArchetypes: [], brandVoiceTerritory: "" };

  const headers = rows[0]; // ["Dimension", "XO Digital", "INCO", "Bloxs", "Captable"]
  const companies = headers.slice(1);

  const voiceRows: BrandVoiceRow[] = [];
  const archetypes: Array<{ company: string; archetype: string }> = [];

  for (const row of rows.slice(1)) {
    const dim = row[0] ?? "";
    if (/archetype/i.test(dim)) {
      companies.forEach((c, i) => {
        if (row[i + 1]) archetypes.push({ company: c, archetype: row[i + 1] });
      });
    } else {
      const scores: Record<string, string> = {};
      companies.forEach((c, i) => {
        scores[c] = row[i + 1] ?? "";
      });
      voiceRows.push({ dimension: dim, scores });
    }
  }

  // "**Voice Territory Opportunity:** ..." paragraph
  const territoryMatch = sec.match(/\*\*Voice Territory Opportunity[:\s]*\*\*\s*(.+)/i);
  const territory = territoryMatch?.[1]?.trim() ?? "";

  return { brandVoiceRows: voiceRows, brandVoiceArchetypes: archetypes, brandVoiceTerritory: territory };
}

function parseCustomerSentiment(sec: string): {
  customerSentiment: CustomerSentimentEntry[];
  whitespaceOpportunities: string[];
} {
  // Reclame Aqui table
  const tableText = section(sec, "Reclame Aqui") || sec;
  const rows = parseTable(tableText);
  const entries: CustomerSentimentEntry[] = [];
  if (rows.length >= 2) {
    for (const row of rows.slice(1)) {
      const company = row[0] ?? "";
      if (!company || isPlaceholder(company)) continue;
      const raw = row[1] ?? "";
      if (isPlaceholder(raw) && isPlaceholder(row[2] ?? "") && isPlaceholder(row[3] ?? "")) continue;
      // "8.1/10 (Otimo)" → rating "8.1/10", label "Otimo"
      const m = raw.match(/^([0-9.]+\/10)\s*\(([^)]+)\)/) ?? raw.match(/^([0-9.]+\/10)/);
      entries.push({
        company,
        rating: m ? m[1] : (!isPlaceholder(raw) ? raw : undefined),
        ratingLabel: m?.[2] || undefined,
        responseTime: !isPlaceholder(row[2] ?? "") ? (row[2] || undefined) : undefined,
        wouldReturn: !isPlaceholder(row[3] ?? "") ? (row[3] || undefined) : undefined,
      });
    }
  }

  // Whitespace opportunities — numbered list
  const wsText = section(sec, "Whitespace") || sec;
  const whitespace = wsText
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s+/, "").trim())
    .filter((l) => l.length > 4 && !/^#+/.test(l) && !/^\|/.test(l) && !isPlaceholder(l));

  return { customerSentiment: entries, whitespaceOpportunities: whitespace };
}

/** Parse the deep-dive Competitor Profiles section and return a map keyed by company name. */
function parseCompetitorProfiles(
  sec: string,
): Record<string, Partial<Omit<ClientCompetitor, "id" | "clientId" | "source" | "createdAt" | "updatedAt">>> {
  const profiles: Record<string, Partial<Omit<ClientCompetitor, "id" | "clientId" | "source" | "createdAt" | "updatedAt">>> = {};
  // Split on ### headings
  const blocks = sec.split(/^###\s+/m).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    const heading = lines[0]?.trim() ?? "";
    // "INCO (inco.vc)" → name "INCO", url "inco.vc"
    const { name: rawName, url } = parseNameAndUrl(heading);
    const name = rawName.split(/\s*\/\s*/)[0].trim(); // handle "Bloxs / Altxs"
    const body = lines.slice(1).join("\n");

    const founded = bullet(body, "Founded");
    const scale = bullet(body, "Scale");
    const strengthsRaw = bullet(body, "Key Strengths");
    const weaknessesRaw = bullet(body, "Key Weaknesses");
    const threatRaw = bullet(body, "Threat Level");

    const threat = (["HIGH", "MEDIUM", "LOW"].includes(threatRaw?.toUpperCase() ?? "")
      ? threatRaw.toUpperCase()
      : undefined) as ClientCompetitor["threatLevel"] | undefined;

    profiles[name.toLowerCase()] = {
      url: url || undefined,
      founded: founded || undefined,
      scale: scale || undefined,
      keyStrengths: strengthsRaw ? strengthsRaw.split(/,\s*/).map((s) => s.trim()) : [],
      keyWeaknesses: weaknessesRaw ? weaknessesRaw.split(/,\s*/).map((s) => s.trim()) : [],
      threatLevel: threat,
    };
  }
  return profiles;
}

/* ────────────────────── Main export ────────────────────── */

export function parseMarkdownReport(md: string): ParsedReport {
  // Report date — may appear as `**Date:** ...` or `March 31, 2026` pattern
  const dateMatch = md.match(/\*\*Date[:\s]*\*\*\s*(.+)/i) ?? md.match(/^((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/m);
  const reportDate = dateMatch?.[1]?.trim() ?? "";

  const wideScan = parseWideScan(section(md, "Wide Scan"));
  const profiles = parseCompetitorProfiles(section(md, "Competitor Profiles"));

  // Merge profile details (url, founded, scale, strengths, weaknesses, threatLevel) into Wide Scan rows.
  // Only overwrite with defined profile values — an explicit `undefined` shouldn't clobber a
  // url/threatLevel already parsed from the Wide Scan row.
  const competitorRows = wideScan.map((row) => {
    const key = row.company.toLowerCase().split(/\s*\/\s*/)[0].trim();
    const profile = profiles[key] ?? {};
    const definedProfile = Object.fromEntries(
      Object.entries(profile).filter(([, v]) => v !== undefined),
    );
    return { ...row, ...definedProfile };
  });

  const { brandVoiceRows, brandVoiceArchetypes, brandVoiceTerritory } = parseBrandVoice(
    section(md, "Brand Voice"),
  );
  const { customerSentiment, whitespaceOpportunities } = parseCustomerSentiment(
    section(md, "Customer Sentiment"),
  );

  return {
    reportDate,
    url: bullet(md, "URL"),
    businessType: bullet(md, "Business Type"),
    founded: bullet(md, "Founded"),
    authorization: bullet(md, "CVM Authorization") || bullet(md, "Authorization"),
    cnpj: bullet(md, "CNPJ"),
    minInvestment: bullet(md, "Min. Investment") || bullet(md, "Min Investment"),
    techStack: bullet(md, "Tech Stack"),
    reportStatus: bullet(md, "Status"),

    ...parseOverallScore(section(md, "Overall Score") || section(md, "Competitive Ranking")),
    dimensionScores: parseDimensionScores(section(md, "Dimension Scores")),
    competitorRows,
    competitorRankings:
      parseOverallScore(section(md, "Competitive Ranking") || section(md, "Overall Score")).competitorRankings,

    contentAnalysis: section(md, "Content & Messaging"),
    conversionAnalysis: section(md, "Conversion Optimization"),
    seoAnalysis: section(md, "SEO & Discoverability"),
    geoAnalysis: section(md, "GEO & AI"),
    positioningAnalysis: section(md, "Competitive Positioning"),
    brandAnalysis: section(md, "Brand & Trust"),
    growthAnalysis: section(md, "Growth & Strategy"),

    swot: parseSWOT(section(md, "SWOT")),
    recommendations: parseRecommendations(section(md, "Recommendations")),
    brandVoiceRows,
    brandVoiceArchetypes,
    brandVoiceTerritory,
    customerSentiment,
    whitespaceOpportunities,
  };
}

/**
 * Build a full ClientReport object from parsed data.
 * Call this after parseMarkdownReport(); supply the clientId and optional pdfUrl.
 */
export function buildClientReport(
  clientId: string,
  parsed: ParsedReport,
  rawMarkdown: string,
  pdfUrl?: string,
): Omit<ClientReport, "id"> {
  const now = Date.now();
  return {
    clientId,
    reportDate: parsed.reportDate,
    url: parsed.url,
    businessType: parsed.businessType,
    founded: parsed.founded,
    authorization: parsed.authorization,
    cnpj: parsed.cnpj,
    minInvestment: parsed.minInvestment,
    techStack: parsed.techStack,
    reportStatus: parsed.reportStatus,
    overallScore: parsed.overallScore,
    overallGrade: parsed.overallGrade,
    dimensionScores: parsed.dimensionScores,
    competitorRankings: parsed.competitorRankings,
    contentAnalysis: parsed.contentAnalysis,
    conversionAnalysis: parsed.conversionAnalysis,
    seoAnalysis: parsed.seoAnalysis,
    geoAnalysis: parsed.geoAnalysis,
    positioningAnalysis: parsed.positioningAnalysis,
    brandAnalysis: parsed.brandAnalysis,
    growthAnalysis: parsed.growthAnalysis,
    swot: parsed.swot,
    recommendations: parsed.recommendations,
    brandVoiceRows: parsed.brandVoiceRows,
    brandVoiceArchetypes: parsed.brandVoiceArchetypes,
    brandVoiceTerritory: parsed.brandVoiceTerritory,
    customerSentiment: parsed.customerSentiment,
    whitespaceOpportunities: parsed.whitespaceOpportunities,
    rawMarkdown,
    pdfUrl,
    createdAt: now,
    updatedAt: now,
  };
}
