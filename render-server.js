#!/usr/bin/env node
// Render entry point: serves the API only.
//
// The static pages are on Firebase Hosting, so this process answers just the
// /api routes and relies on the CORS headers the handler already sets.
//
// api/index.js is shared verbatim with the Vercel deployment. It was written
// against Vercel's request/response objects, which add a couple of
// Express-style helpers on top of Node's; those are shimmed here rather than
// changed in the handler, so both deployments keep running the same code.

const http = require("node:http");
const handler = require("./api/index.js");

const PORT = Number(process.env.PORT) || 3000;

function decorate(response) {
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.send = (body) => {
    response.end(body);
  };
  return response;
}

const server = http.createServer((request, response) => {
  decorate(response);
  // The handler catches its own errors, but a rejection thrown before that
  // would otherwise leave the socket hanging until the client gives up.
  Promise.resolve(handler(request, response)).catch((error) => {
    console.error("Unhandled request error:", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    response.end(JSON.stringify({ error: "Internal server error" }));
  });
});

server.listen(PORT, () => {
  console.log(`MoTrack API listening on port ${PORT}`);
});
