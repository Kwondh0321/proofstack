import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type ComparisonExperimentSummary,
  runComparisonExperiment,
  type RunComparisonExperimentOptions,
} from "./workflow.js";

const MAX_REQUEST_BODY_BYTES = 4_096;

const styles = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#071018;color:#e8f0f7}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 10% 0,#12334a 0,transparent 35%),#071018}main{width:min(920px,calc(100% - 32px));margin:48px auto}.language{display:flex;justify-content:flex-end;gap:10px;font-size:14px}.language a{color:#a9bac7}.language a[aria-current=page]{color:#62d8b0;font-weight:800}.eyebrow{color:#62d8b0;font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(32px,6vw,62px);line-height:1;margin:12px 0 18px;letter-spacing:-.04em}p{color:#a9bac7;line-height:1.65}.card{background:#0d1923;border:1px solid #243746;border-radius:22px;padding:24px;box-shadow:0 24px 80px #0006}form{display:grid;grid-template-columns:1fr 1fr auto;gap:14px;align-items:end}label{display:grid;gap:8px;color:#c6d3dc;font-size:14px;font-weight:700}input{width:100%;border:1px solid #32495a;border-radius:12px;background:#08131b;color:#fff;padding:14px 16px;font:inherit}button{border:0;border-radius:12px;background:#62d8b0;color:#052118;padding:15px 20px;font-weight:900;cursor:pointer}button:disabled{opacity:.55;cursor:wait}a:focus-visible,input:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #ffd166;outline-offset:3px}.status{margin:20px 0 0;min-height:25px;color:#b8c7d1}.result{display:none;margin-top:18px}.result.show{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{background:#08131b;border:1px solid #203440;border-radius:15px;padding:18px}.metric span{display:block;color:#9aadb9;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.metric strong{display:block;margin-top:8px;font-size:26px;overflow-wrap:anywhere}.verified{color:#62d8b0}details{margin-top:18px;border-top:1px solid #243746;padding-top:18px}summary{cursor:pointer;color:#c7d3db}pre{overflow:auto;max-height:360px;background:#050b10;padding:16px;border-radius:12px;color:#b9e8d8;font-size:12px;line-height:1.55}.notice{margin-top:18px;font-size:13px;color:#93a5b1}@media(max-width:720px){form{grid-template-columns:1fr}.result.show{grid-template-columns:1fr}main{margin:24px auto}}`;

const browserScript = `const form=document.querySelector('#experiment');const button=document.querySelector('#run');const status=document.querySelector('#status');const result=document.querySelector('#result');const raw=document.querySelector('#raw');const deltaOutput=document.querySelector('#delta');const directionOutput=document.querySelector('#direction');const integrityOutput=document.querySelector('#integrity');form.addEventListener('submit',async(event)=>{event.preventDefault();button.disabled=true;status.textContent=form.dataset.running;result.classList.remove('show');try{const response=await fetch('/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baselineMilliseconds:Number(document.querySelector('#baseline').value),candidateMilliseconds:Number(document.querySelector('#candidate').value)})});const body=await response.json();if(!response.ok)throw new Error(body.error||form.dataset.failed);const delta=body.outcome.delta;const exact=delta.denominator==='1'?delta.numerator:delta.numerator+'/'+delta.denominator;deltaOutput.textContent=(exact==='0'||exact.startsWith('-')?'':'+')+exact+' '+delta.unit;directionOutput.textContent=body.outcome.direction;integrityOutput.textContent=body.evidence.integrity;integrityOutput.className=body.evidence.integrity==='verified'?'verified':'';raw.textContent=JSON.stringify(body,null,2);result.classList.add('show');status.textContent=form.dataset.complete}catch(error){status.textContent=form.dataset.errorPrefix+(error instanceof Error?error.message:form.dataset.failed);raw.textContent=String(error)}finally{button.disabled=false}});`;

interface Copy {
  readonly complete: string;
  readonly description: string;
  readonly details: string;
  readonly direction: string;
  readonly errorPrefix: string;
  readonly failed: string;
  readonly heading: string;
  readonly initial: string;
  readonly notice: string;
  readonly run: string;
  readonly running: string;
}

const copy: Record<"en" | "ko", Copy> = {
  en: {
    complete: "Complete: the result was stored, read back, and verified as an exact record.",
    description:
      "Enter baseline and candidate values. The real core engine creates an immutable definition and two evidence snapshots, derives an exact delta, and reads the stored result back.",
    details: "View machine-readable result and immutable bindings",
    direction: "Direction (descriptive)",
    errorPrefix: "Error: ",
    failed: "Experiment failed",
    heading: "ProofStack comparison lab",
    initial: "Run the defaults first, or enter your own non-negative integer measurements.",
    notice:
      "This lab executes real ProofStack comparison logic with synthetic measurements. It does not prove an agent's performance, safety, or production fitness, and it makes no release decision.",
    run: "Run exact comparison",
    running: "Creating immutable snapshots and deriving the exact comparison…",
  },
  ko: {
    complete: "완료: 결과를 저장하고 exact record를 다시 읽어 무결성을 검증했습니다.",
    description:
      "baseline과 candidate 값을 입력하세요. 실제 코어 엔진이 불변 정의와 두 evidence snapshot을 만들고 정확한 차이를 도출한 뒤, 저장된 결과를 다시 읽습니다.",
    details: "기계 판독 결과와 불변 binding 보기",
    direction: "방향(설명값)",
    errorPrefix: "오류: ",
    failed: "실험에 실패했습니다",
    heading: "ProofStack 비교 실험실",
    initial: "먼저 기본값으로 실행하거나 0 이상의 정수 측정값을 입력하세요.",
    notice:
      "이 실험실은 synthetic 측정값으로 실제 ProofStack 비교 로직을 실행합니다. 실제 agent의 성능·안전성·production 적합성을 증명하거나 release 결정을 내리지는 않습니다.",
    run: "정확 비교 실행",
    running: "불변 snapshot을 만들고 exact comparison을 도출하는 중…",
  },
};

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function page(language: "en" | "ko"): string {
  const text = copy[language];
  const englishCurrent = language === "en" ? ' aria-current="page"' : "";
  const koreanCurrent = language === "ko" ? ' aria-current="page"' : "";
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text.heading}</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><nav class="language" aria-label="Language"><a href="/" hreflang="en"${englishCurrent}>English</a><a href="/?lang=ko" hreflang="ko"${koreanCurrent}>한국어</a></nav><header><div class="eyebrow">Actual core execution · Synthetic evidence</div><h1>${text.heading}</h1><p>${text.description}</p></header>
<section class="card"><form id="experiment" data-running="${escapeAttribute(text.running)}" data-complete="${escapeAttribute(text.complete)}" data-error-prefix="${escapeAttribute(text.errorPrefix)}" data-failed="${escapeAttribute(text.failed)}"><label>Baseline latency (ms)<input id="baseline" name="baseline" type="number" min="0" max="9007199254740991" step="1" value="125" required></label><label>Candidate latency (ms)<input id="candidate" name="candidate" type="number" min="0" max="9007199254740991" step="1" value="100" required></label><button id="run" type="submit">${text.run}</button></form><div id="status" class="status" role="status" aria-live="polite">${text.initial}</div>
<div id="result" class="result" aria-live="polite"><div class="metric"><span>Exact delta (candidate − baseline)</span><strong id="delta">—</strong></div><div class="metric"><span>${text.direction}</span><strong id="direction">—</strong></div><div class="metric"><span>Integrity</span><strong id="integrity">—</strong></div></div>
<details><summary>${text.details}</summary><pre id="raw">—</pre></details><p class="notice">${text.notice}</p></section></main><script src="/app.js" defer></script></body></html>`;
}

class LabInputError extends Error {}

function secureHeaders(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "content-type": contentType,
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, secureHeaders(contentType));
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_REQUEST_BODY_BYTES) {
      throw new LabInputError("Request body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new LabInputError("Request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw new LabInputError("Request body must be valid JSON", { cause });
  }
}

function parseMeasurements(input: unknown): Omit<RunComparisonExperimentOptions, "namespace"> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LabInputError("Request body must be an object");
  }
  const body = input as Record<string, unknown>;
  if (
    Reflect.ownKeys(body).some(
      (key) => key !== "baselineMilliseconds" && key !== "candidateMilliseconds",
    )
  ) {
    throw new LabInputError("Request body contains an unknown field");
  }
  const baselineMilliseconds = body["baselineMilliseconds"];
  const candidateMilliseconds = body["candidateMilliseconds"];
  if (
    !Number.isSafeInteger(baselineMilliseconds) ||
    (baselineMilliseconds as number) < 0 ||
    !Number.isSafeInteger(candidateMilliseconds) ||
    (candidateMilliseconds as number) < 0
  ) {
    throw new LabInputError("Both measurements must be non-negative safe integers");
  }
  return {
    baselineMilliseconds: baselineMilliseconds as number,
    candidateMilliseconds: candidateMilliseconds as number,
  };
}

export interface ComparisonLabOptions {
  readonly namespace?: () => string;
  readonly run?: (options: RunComparisonExperimentOptions) => Promise<ComparisonExperimentSummary>;
}

export function createComparisonLab(options: ComparisonLabOptions = {}): Server {
  const run = options.run ?? runComparisonExperiment;
  let sequence = 0;
  const namespace =
    options.namespace ??
    (() => {
      sequence += 1;
      return `trial${Date.now().toString(36)}${sequence.toString(36)}`.slice(-20);
    });

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      const language = url.searchParams.get("lang") === "ko" ? "ko" : "en";
      send(response, 200, "text/html; charset=utf-8", page(language));
      return;
    }
    if (request.method === "GET" && url.pathname === "/styles.css") {
      send(response, 200, "text/css; charset=utf-8", styles);
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      send(response, 200, "text/javascript; charset=utf-8", browserScript);
      return;
    }
    if (request.method === "POST" && url.pathname === "/run") {
      try {
        const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType !== "application/json") {
          throw new LabInputError("Content-Type must be application/json");
        }
        const measurements = parseMeasurements(await readJson(request));
        const summary = await run({ ...measurements, namespace: namespace() });
        sendJson(response, 200, summary);
      } catch (error) {
        if (error instanceof LabInputError) {
          sendJson(response, 400, { error: error.message });
        } else {
          sendJson(response, 500, { error: "Experiment execution failed" });
        }
      }
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  });
}
