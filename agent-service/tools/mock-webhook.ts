import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "../src/webhooks/sign.js";

const PORT = Number(process.env.MOCK_WEBHOOK_PORT ?? 9009);
const SECRET = process.env.AGENT_WEBHOOK_SECRET ?? "dev-webhook-secret";
const OUT_DIR = process.env.MOCK_WEBHOOK_DIR ?? "./data/webhooks";

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const valid = verifySignature({
        secrets: [SECRET],
        signatureHeader: req.headers[SIGNATURE_HEADER] as string | undefined,
        timestampHeader: req.headers[TIMESTAMP_HEADER] as string | undefined,
        rawBody,
      });
      if (!valid) {
        console.error(`[mock-webhook] REJECTED unsigned/invalid webhook (${req.method} ${req.url})`);
        res.writeHead(401).end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      const payload = JSON.parse(rawBody) as { job_id?: string; status?: string };
      console.log(`[mock-webhook] verified: job=${payload.job_id} status=${payload.status}`);
      console.log(JSON.stringify(payload, null, 2));
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(path.join(OUT_DIR, `${payload.job_id ?? "unknown"}.json`), rawBody);
      res.writeHead(200).end(JSON.stringify({ ok: true }));
    })().catch((err) => {
      console.error("[mock-webhook] handler error:", err);
      res.writeHead(500).end();
    });
  });
});

server.listen(PORT, () => {
  console.log(`[mock-webhook] listening on :${PORT} (secret: ${SECRET === "dev-webhook-secret" ? "dev default" : "custom"})`);
});
