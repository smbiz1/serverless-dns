/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as util from "./commons/util.js";
import { handleRequest } from "./core/doh.js";
import { handleJsonApi, isJsonApiPath } from "./core/workers/json-api.js";
import "./core/workers/config.js";
import * as system from "./system.js";

export default {
  // workers/runtime-apis/fetch-event#syntax-module-worker
  async fetch(request, env, context) {
    return await serve(request, env, context);
  },
};

function serve(request, env, ctx) {
  // on Workers, the network-context is only available in an event listener
  // and so, publish system prepare from here instead of from main which
  // runs in global-scope.
  system.pub("prepare", { env: env });

  const url = safeUrl(request.url);
  const path = url ? url.pathname.replace(/\/+$/, "") || "/" : "/";
  const wantsJson = isJsonApiPath(path);

  return new Promise((accept) => {
    system
      .when("go")
      .then((_v) => {
        if (wantsJson) return handleJsonApi(request, env, ctx);
        const event = util.mkFetchEvent(
          request,
          null,
          ctx.waitUntil.bind(ctx),
          ctx.passThroughOnException.bind(ctx)
        );
        return handleRequest(event);
      })
      .then((response) => {
        accept(response);
      })
      .catch((e) => {
        console.error("server", "serve err", e);
        accept(util.respond405());
      });
  });
}

function safeUrl(s) {
  try {
    return new URL(s);
  } catch (_) {
    return null;
  }
}
