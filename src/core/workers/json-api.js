/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * JSON DNS API wrapper around the existing DoH pipeline.
 *
 * Designed for client apps (e.g. the deepmarket app) that want a
 * simple HTTP+JSON DNS lookup endpoint hosted on Cloudflare Workers.
 *
 *   GET  /resolve?name=example.com&type=A
 *   POST /resolve            { "name": "example.com", "type": "AAAA" }
 *   GET  /dns-json?name=...  (alias of /resolve)
 *   GET  /__health           liveness probe
 *
 * Response shape mirrors Cloudflare's `application/dns-json` so that
 * existing client SDKs work unchanged.
 */

import * as bufutil from "../../commons/bufutil.js";
import * as dnsutil from "../../commons/dnsutil.js";
import * as util from "../../commons/util.js";
import { handleRequest } from "../doh.js";

// dns-packet RR type names → numeric codes (subset that matters for JSON).
// Values from IANA DNS Parameters; clients send either form.
const RRTYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NAPTR: 35,
  OPT: 41,
  DS: 43,
  SSHFP: 44,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
  NSEC3: 50,
  TLSA: 52,
  SVCB: 64,
  HTTPS: 65,
  SPF: 99,
  CAA: 257,
};
const RRTYPE_BY_CODE = Object.fromEntries(
  Object.entries(RRTYPE).map(([k, v]) => [v, k])
);

const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
};

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isJsonApiPath(path) {
  if (!path) return false;
  return (
    path === "/resolve" ||
    path === "/resolve/" ||
    path === "/dns-json" ||
    path === "/dns-json/" ||
    path === "/__health" ||
    path === "/__health/"
  );
}

/**
 * Entry point invoked from server-workers.js.
 * @param {Request} request
 * @param {object} env
 * @param {{waitUntil: Function, passThroughOnException: Function}} ctx
 * @returns {Promise<Response>}
 */
export async function handleJsonApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return preflight();

  if (path === "/__health") return health();

  if (path !== "/resolve" && path !== "/dns-json") return notFound();

  if (request.method !== "GET" && request.method !== "POST") {
    return jsonError(405, "Method Not Allowed");
  }

  const auth = checkAuth(request, env);
  if (!auth.ok) return jsonError(auth.status, auth.message);

  let name;
  let type;
  let cd = false;
  let doBit = false;

  try {
    if (request.method === "POST") {
      const ct = (request.headers.get("Content-Type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return jsonError(415, "Content-Type must be application/json");
      }
      const body = await request.json();
      name = body.name;
      type = body.type;
      cd = !!body.cd;
      doBit = !!body.do;
    } else {
      name = url.searchParams.get("name");
      type = url.searchParams.get("type");
      cd = parseBool(url.searchParams.get("cd"));
      doBit = parseBool(url.searchParams.get("do"));
    }
  } catch (_) {
    return jsonError(400, "Invalid JSON body");
  }

  const validation = validateQuery(name, type);
  if (validation.error) return jsonError(400, validation.error);

  const qname = validation.name;
  const qtypeName = validation.typeName;

  const wire = encodeQuery(qname, qtypeName, cd, doBit);
  if (!wire) return jsonError(500, "Failed to encode DNS query");

  const dohRequest = buildDohGet(url, wire);
  const dohEvent = util.mkFetchEvent(
    dohRequest,
    null,
    ctx.waitUntil.bind(ctx),
    ctx.passThroughOnException.bind(ctx)
  );

  let dohResponse;
  try {
    dohResponse = await handleRequest(dohEvent);
  } catch (e) {
    return jsonError(502, "Upstream resolver failed");
  }

  if (!dohResponse) return jsonError(502, "Empty upstream response");

  // Surface block / region / flag headers from the inner DoH response
  // so callers can tell when something was filtered.
  const flag = dohResponse.headers.get("x-nile-flags") || "";
  const flagDn = dohResponse.headers.get("x-nile-flags-dn") || "";
  const region = dohResponse.headers.get("x-nile-region") || "";

  const ab = await dohResponse.arrayBuffer();
  if (bufutil.emptyBuf(ab)) {
    return jsonError(dohResponse.status || 502, "Empty DNS response");
  }

  let packet;
  try {
    packet = dnsutil.decode(ab);
  } catch (_) {
    return jsonError(502, "Failed to decode DNS response");
  }

  const json = packetToJson(packet, qname, qtypeName);
  if (flag) {
    json.blocked = true;
    json.flag = flag;
  } else if (flagDn) {
    json.blocked = false;
    json.flag = flagDn;
  } else {
    json.blocked = false;
  }
  if (region) json.region = region;

  const ttl = dnsutil.ttl(packet);
  return jsonResponse(json, 200, ttl > 0 ? ttl : 0);
}

function checkAuth(request, env) {
  const required = env && env.DEEPMARKET_API_KEY;
  if (!required) return { ok: true };

  const url = new URL(request.url);
  const fromHeader =
    request.headers.get("x-api-key") ||
    bearer(request.headers.get("authorization"));
  const fromQuery = url.searchParams.get("key");
  const presented = fromHeader || fromQuery;

  if (!presented) {
    return { ok: false, status: 401, message: "Missing API key" };
  }
  if (!constantTimeEquals(presented, required)) {
    return { ok: false, status: 403, message: "Invalid API key" };
  }
  return { ok: true };
}

function bearer(h) {
  if (!h) return null;
  const [scheme, value] = h.split(" ", 2);
  if (!scheme || !value) return null;
  return scheme.toLowerCase() === "bearer" ? value.trim() : null;
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Walk `b` (the configured secret) end-to-end so the work done depends on
  // the secret's length, not on the attacker-controlled `a`. The length
  // delta is folded into `r` via XOR so any mismatch — same length but
  // different bytes, or different length — yields a non-zero result.
  // `a.charCodeAt(i)` past the end returns NaN; `| 0` coerces that to 0
  // without an input-length branch.
  const lb = b.length;
  let r = a.length ^ lb;
  for (let i = 0; i < lb; i++) {
    const ca = a.charCodeAt(i) | 0;
    r |= ca ^ b.charCodeAt(i);
  }
  return r === 0;
}

function parseBool(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function validateQuery(name, type) {
  if (util.emptyString(name)) return { error: "Missing 'name'" };
  if (name.length > 253) return { error: "'name' too long" };
  if (!util.isDNSName(name)) return { error: "'name' is not a valid hostname" };

  let typeName = "A";
  if (type != null && String(type).trim() !== "") {
    const t = String(type).trim().toUpperCase();
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10);
      const named = RRTYPE_BY_CODE[n];
      if (!named) return { error: "Unsupported numeric 'type'" };
      typeName = named;
    } else {
      if (!RRTYPE[t]) return { error: "Unsupported 'type'" };
      typeName = t;
    }
  }
  // strip trailing dot for consistency
  const cleanName = name.endsWith(".") ? name.slice(0, -1) : name;
  return { name: cleanName, typeName };
}

function encodeQuery(name, typeName, cd, doBit) {
  try {
    return dnsutil.encode({
      id: 0,
      type: "query",
      flags: cd ? 0x0110 : 0x0100, // RD, optionally CD
      questions: [{ name, type: typeName, class: "IN" }],
      additionals: doBit
        ? [
            {
              name: ".",
              type: "OPT",
              udpPayloadSize: 4096,
              flags: 0x8000, // DO bit
            },
          ]
        : [],
    });
  } catch (_) {
    return null;
  }
}

function buildDohGet(originalUrl, wireQuery) {
  const dns = bufutil.bytesToBase64Url(wireQuery);
  const inner = new URL(originalUrl.toString());
  inner.pathname = "/dns-query";
  inner.search = "?dns=" + dns;
  // RFC 8484 GET with Accept: application/dns-message
  return new Request(inner.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-message",
    },
  });
}

function packetToJson(packet, qname, qtypeName) {
  const status = rcodeToInt(packet && packet.rcode);
  const flagsInt = typeof packet.flags === "number" ? packet.flags : 0;

  const out = {
    Status: status,
    TC: bit(flagsInt, 9),
    RD: bit(flagsInt, 8),
    RA: bit(flagsInt, 7),
    AD: bit(flagsInt, 5),
    CD: bit(flagsInt, 4),
    Question: [{ name: qname, type: RRTYPE[qtypeName] || 0 }],
    Answer: [],
  };

  if (!util.emptyArray(packet.answers)) {
    for (const a of packet.answers) {
      if (!a || a.type === "OPT") continue;
      out.Answer.push({
        name: stripDot(a.name),
        type: RRTYPE[String(a.type).toUpperCase()] || 0,
        TTL: typeof a.ttl === "number" ? a.ttl : 0,
        data: stringifyRdata(a),
      });
    }
  }

  if (!util.emptyArray(packet.authorities)) {
    out.Authority = [];
    for (const a of packet.authorities) {
      if (!a || a.type === "OPT") continue;
      out.Authority.push({
        name: stripDot(a.name),
        type: RRTYPE[String(a.type).toUpperCase()] || 0,
        TTL: typeof a.ttl === "number" ? a.ttl : 0,
        data: stringifyRdata(a),
      });
    }
  }

  return out;
}

function rcodeToInt(rcode) {
  if (rcode == null) return 0;
  if (typeof rcode === "number") return rcode;
  const u = String(rcode).toUpperCase();
  return Object.prototype.hasOwnProperty.call(RCODE, u) ? RCODE[u] : 0;
}

function bit(flags, n) {
  return ((flags >> n) & 1) === 1;
}

function stripDot(s) {
  if (!s || typeof s !== "string") return s || "";
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function stringifyRdata(a) {
  if (!a) return "";
  const t = String(a.type || "").toUpperCase();
  const d = a.data;
  if (d == null) return "";
  if (t === "A" || t === "AAAA") return String(d);
  if (t === "CNAME" || t === "NS" || t === "PTR") return stripDot(String(d));
  if (t === "TXT") {
    if (Array.isArray(d)) return d.map(coerceTxt).join("");
    return coerceTxt(d);
  }
  if (t === "MX") return `${d.preference || 0} ${stripDot(d.exchange || "")}`;
  if (t === "SOA") {
    return [
      stripDot(d.mname || ""),
      stripDot(d.rname || ""),
      d.serial,
      d.refresh,
      d.retry,
      d.expire,
      d.minimum,
    ].join(" ");
  }
  if (t === "SRV") {
    return `${d.priority || 0} ${d.weight || 0} ${d.port || 0} ${stripDot(
      d.target || ""
    )}`;
  }
  if (t === "CAA") return `${d.flags || 0} ${d.tag || ""} "${d.value || ""}"`;
  if (t === "HTTPS" || t === "SVCB") {
    const target = d.targetName === "." ? "." : stripDot(d.targetName || "");
    return `${d.svcPriority || 0} ${target}`;
  }
  if (typeof d === "string") return d;
  try {
    return JSON.stringify(d);
  } catch (_) {
    return "";
  }
}

function coerceTxt(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const u = v instanceof Uint8Array ? v : new Uint8Array(v);
    return new TextDecoder().decode(u);
  }
  return String(v);
}

function health() {
  return jsonResponse({ ok: true, ts: Date.now() }, 200, 0);
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: privacyHeaders({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, X-API-Key, Authorization, Accept",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
    }),
  });
}

function notFound() {
  return jsonError(404, "Not Found");
}

function jsonError(status, message) {
  return jsonResponse({ Status: -1, error: message }, status, 0);
}

function jsonResponse(obj, status, ttl) {
  const headers = privacyHeaders({
    "Content-Type": "application/dns-json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "x-nile-flags, x-nile-flags-dn, x-nile-region",
  });

  if (ttl > 0) {
    headers["Cache-Control"] = `public, max-age=${ttl}`;
  } else {
    headers["Cache-Control"] = "no-store, private";
  }

  return new Response(JSON.stringify(obj), { status, headers });
}

// Headers that limit data leakage from the API surface itself,
// independent of the DNS answer being returned.
function privacyHeaders(extra = {}) {
  return Object.assign(
    {
      "Strict-Transport-Security":
        "max-age=63072000; includeSubDomains; preload",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "interest-cohort=()",
    },
    extra
  );
}
