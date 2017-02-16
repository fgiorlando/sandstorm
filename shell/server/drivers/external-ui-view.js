// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { PersistentImpl } from "/imports/server/persistent.js";

const Future = Npm.require("fibers/future");
const Capnp = Npm.require("capnp");
const Url = Npm.require("url");
const Http = Npm.require("http");
const Https = Npm.require("https");
const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
const PersistentApiSession =
    Capnp.importSystem("sandstorm/api-session-impl.capnp").PersistentApiSession;

ExternalUiView = class ExternalUiView {
  constructor(url, token) {
    this.url = url;
    this.token = token;
  }

  newSession(userInfo, context, sessionType, sessionParams) {
    if (sessionType !== ApiSession.typeId) {
      throw new Error("SessionType must be ApiSession.");
    }

    const options = {};

    if (this.token) {
      options.headers = {
        authorization: "Bearer " + this.token,
      };
    }

    return { session: new Capnp.Capability(new ExternalWebSession(this.url, options), ApiSession) };
  }
};

function newExternalHttpSession(url, auth, db, saveTemplate) {
  // `url` and `auth` are the corresponding members of `ApiToken.frontendRef.http`.

  const createCap = authorization => {
    return new Capnp.Capability(new ExternalWebSession(url,
        authorization ? { headers: { authorization } } : {},
        db, saveTemplate), PersistentApiSession);
  };

  if (auth.refresh) {
    throw new Error("refresh tokens unimplemented");
  } else if (auth.bearer) {
    return createCap("Bearer " + auth.bearer);
  } else if (auth.basic) {
    const userpass = [auth.basic.username, auth.basic.password].join(":");
    return createCap("Basic " + new Buffer(userpass, "utf8").toString("base64"));
  } else {
    return createCap(null);
  }
}

function registerHttpApiFrontendRef(registry) {
  registry.register({
    frontendRefField: "http",
    typeId: "14445827391922490823",

    restore(db, saveTemplate, value) {
      return newExternalHttpSession(value.url, value.auth, db, saveTemplate);
    },

    validate(db, session, request) {
      check(request, {
        url: String,
        auth: Match.OneOf(
            { none: null },
            { bearer: String },
            { basic: { username: String, password: String } }),
      });

      if (!request.url.startsWith("https://") &&
          !request.url.startsWith("http://")) {
        throw new Meteor.Error(400, "URL must be HTTP or HTTPS.");
      }

      // Check for URL patterns.
      const parsedUrl = Url.parse(request.url);

      if (parsedUrl.auth) {
        const parts = parsedUrl.auth.split(":");
        if (parts.length === 2) {
          if ("none" in request.auth) {
            request.auth = { basic: { username: parts[0], password: parts[1] } };
          } else {
            throw new Meteor.Error(400, "Can't supprot multiple authentication mechanisms at once");
          }
        }

        parsedUrl.auth = null;
        request.url = Url.format(parsedUrl);
      }

      if (parsedUrl.hash) {
        if ("none" in request.auth) {
          request.auth = { bearer: parsedUrl.hash.slice(1) };
        } else {
          throw new Meteor.Error(400, "Can't supprot multiple authentication mechanisms at once");
        }

        parsedUrl.hash = null;
        request.url = Url.format(parsedUrl);
      }

      const descriptor = { tags: [ { id: ApiSession.typeId } ] };
      return { descriptor, requirements: [], frontendRef: request };
    },

    query(db, userAccountId, tagValue) {
      const tag = tagValue ? Capnp.parse(ApiSession.PowerboxTag, tagValue) : {};

      const options = [];

      if (tag.canonicalUrl &&
          (tag.canonicalUrl.startsWith("https://") ||
           tag.canonicalUrl.startsWith("http://"))) {
        options.push({
          _id: "http-url-" + tag.canonicalUrl,
          frontendRef: { http: { url: tag.canonicalUrl, auth: { none: null } } },
          cardTemplate: "httpUrlPowerboxCard",
        });
      }

      options.push({
        _id: "http-arbitrary",
        cardTemplate: "httpArbitraryPowerboxCard",
        configureTemplate: "httpArbitraryPowerboxConfiguration",
      });

      return options;
    },
  });
}

Meteor.startup(() => { registerHttpApiFrontendRef(globalFrontendRefRegistry); });

// =======================================================================================

const responseCodes = {
  200: { type: "content", code: "ok" },
  201: { type: "content", code: "created" },
  202: { type: "content", code: "accepted" },
  204: { type: "noContent", shouldResetForm: false },
  205: { type: "noContent", shouldResetForm: true },

  // Unsupported until something demonstrates need.
  // 206: {type: 'noContent'},
  // 300: {type: 'redirect'},
  301: { type: "redirect", switchToGet: true, isPermanent: true },
  302: { type: "redirect", switchToGet: true, isPermanent: false },
  303: { type: "redirect", switchToGet: true, isPermanent: false },

  // Unsupported until something demonstrates need.
  // 304: {type: 'redirect'},
  // 305: {type: 'redirect'},
  307: { type: "redirect", switchToGet: false, isPermanent: false },
  308: { type: "redirect", switchToGet: false, isPermanent: true },
  400: { type: "clientError", clientErrorCode: "badRequest", descriptionHtml: "Bad Request" },
  403: { type: "clientError", clientErrorCode: "forbidden", descriptionHtml: "Forbidden" },
  404: { type: "clientError", clientErrorCode: "notFound", descriptionHtml: "Not Found" },
  405: { type: "clientError", clientErrorCode: "methodNotAllowed", descriptionHtml: "Method Not Allowed" },
  406: { type: "clientError", clientErrorCode: "notAcceptable", descriptionHtml: "Not Acceptable" },
  409: { type: "clientError", clientErrorCode: "conflict", descriptionHtml: "Conflict" },
  410: { type: "clientError", clientErrorCode: "gone", descriptionHtml: "Gone" },
  413: { type: "clientError", clientErrorCode: "requestEntityTooLarge", descriptionHtml: "Request Entity Too Large" },
  414: { type: "clientError", clientErrorCode: "requestUriTooLong", descriptionHtml: "Request-URI Too Long" },
  415: { type: "clientError", clientErrorCode: "unsupportedMediaType", descriptionHtml: "Unsupported Media Type" },
  418: { type: "clientError", clientErrorCode: "imATeapot", descriptionHtml: "I'm a teapot" },
  500: { type: "serverError" },
  501: { type: "serverError" },
  502: { type: "serverError" },
  503: { type: "serverError" },
  504: { type: "serverError" },
  505: { type: "serverError" },
};

ExternalWebSession = class ExternalWebSession extends PersistentImpl {
  constructor(url, options, db, saveTemplate) {
    super(db, saveTemplate);

    const parsedUrl = Url.parse(url);
    this.host = parsedUrl.hostname;
    this.port = parsedUrl.port;
    this.protocol = parsedUrl.protocol;
    this.options = options || {};
  }

  get(path, context) {
    return this._requestHelper("GET", path, context);
  }

  post(path, content, context) {
    return this._requestHelper("POST", path, context, content.content, content.mimeType);
  }

  put(path, content, context) {
    return this._requestHelper("PUT", path, context, content.content, content.mimeType);
  }

  delete(path, context) {
    return this._requestHelper("DELETE", path, context);
  }

  // TODO(someday): implement streaming and websockets for ExternalWebSession
  //postStreaming(path, mimeType, context) {
  //}

  //putStreaming(path, mimeType, context) {
  //}

  //openWebSocket(path, context, protocol, clientStream) {
  //}

  _requestHelper(method, path, context, content, contentType) {
    const _this = this;
    const session = _this;
    return new Promise((resolve, reject) => {
      const options = _.clone(session.options);
      options.headers = options.headers || {};

      // According to the specification of `WebSession`, `path` should not contain a
      // leading slash, and therefore we need to prepend "/". However, for a long time
      // this implementation did not in fact prepend a "/". Since some apps might rely on
      // that behavior, we only prepend "/" if the path does not start with "/".
      //
      // TODO(soon): Once apps have updated, prepend "/" unconditionally.
      options.path = path.startsWith("/") ? path : "/" + path;

      options.method = method;
      if (contentType) {
        options.headers["content-type"] = contentType;
      }

      // set accept header
      if ("accept" in context) {
        options.headers.accept = context.accept.map((acceptedType) => {
          return acceptedType.mimeType + "; " + acceptedType.qValue;
        }).join(", ");
      } else if (!("accept" in options.headers)) {
        options.headers.accept = "*/*";
      }

      // set cookies
      if (context.cookies && context.cookies.length > 0) {
        options.headers.cookies = options.headers.cookies || "";
        context.cookies.forEach((keyVal) => {
          options.headers.cookies += keyVal.key + "=" + keyVal.val + ",";
        });
        options.headers.cookies = options.headers.cookies.slice(0, -1);
      }

      options.host = session.host;
      options.port = session.port;

      let requestMethod = Http.request;
      if (session.protocol === "https:") {
        requestMethod = Https.request;
      }

      req = requestMethod(options, (resp) => {
        try {
          const buffers = [];
          const statusInfo = responseCodes[resp.statusCode];

          const rpcResponse = {};

          switch (statusInfo ? statusInfo.type : resp.statusCode) {
            case "content":
              resp.on("data", (buf) => {
                buffers.push(buf);
              });

              resp.on("end", () => {
                const content = {};
                rpcResponse.content = content;

                content.statusCode = statusInfo.code;
                if ("content-encoding" in resp.headers) content.encoding = resp.headers["content-encoding"];
                if ("content-language" in resp.headers) content.language = resp.headers["content-language"];
                if ("content-type" in resp.headers) content.language = resp.headers["content-type"];
                if ("content-disposition" in resp.headers) {
                  const disposition = resp.headers["content-disposition"];
                  const parts = disposition.split(";");
                  if (parts[0].toLowerCase().trim() === "attachment") {
                    parts.forEach((part) => {
                      const splitPart = part.split("=");
                      if (splitPart[0].toLowerCase().trim() === "filename") {
                        content.disposition = { download: splitPart[1].trim() };
                      }
                    });
                  }
                }

                content.body = {};
                content.body.bytes = Buffer.concat(buffers);

                resolve(rpcResponse);
              });
              break;
            case "noContent":
              const noContent = {};
              rpcResponse.noContent = noContent;
              noContent.setShouldResetForm = statusInfo.shouldResetForm;
              resolve(rpcResponse);
              break;
            case "redirect":
              const redirect = {};
              rpcResponse.redirect = redirect;
              redirect.isPermanent = statusInfo.isPermanent;
              redirect.switchToGet = statusInfo.switchToGet;
              if ("location" in resp.headers) redirect.location = resp.headers.location;
              resolve(rpcResponse);
              break;
            case "clientError":
              const clientError = {};
              rpcResponse.clientError = clientError;
              clientError.statusCode = statusInfo.clientErrorCode;
              clientError.descriptionHtml = statusInfo.descriptionHtml;
              resolve(rpcResponse);
              break;
            case "serverError":
              const serverError = {};
              rpcResponse.serverError = serverError;
              clientError.descriptionHtml = statusInfo.descriptionHtml;
              resolve(rpcResponse);
              break;
            default: // ???
              err = new Error("Invalid status code " + resp.statusCode + " received in response.");
              reject(err);
              break;
          }
        } catch (err) {
          reject(err);
        }
      });

      req.on("error", (e) => {
        reject(e);
      });

      req.setTimeout(15000, () => {
        req.abort();
        err = new Error("Request timed out.");
        err.kjType = "overloaded";
        reject(err);
      });

      if (content) {
        req.end(content);
      } else {
        req.end();
      }
    });
  }
};
