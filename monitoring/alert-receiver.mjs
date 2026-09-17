import { createServer } from "node:http";

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    console.log(
      JSON.stringify({
        event: "ALERT_RECEIVER_SMOKE",
        method: request.method,
        path: request.url,
        body: body ? JSON.parse(body) : null,
      }),
    );
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok\n");
  });
});

server.listen(8080, "0.0.0.0");
