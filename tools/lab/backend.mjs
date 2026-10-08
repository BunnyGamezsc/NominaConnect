import http from "node:http";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("nomina lab backend ok\n");
});

server.listen(8080, "0.0.0.0", () => {
  console.log("Nomina lab backend listening on port 8080");
});
