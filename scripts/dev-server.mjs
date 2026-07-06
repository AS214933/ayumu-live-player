import { createServer } from "vite";

const server = await createServer({
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});

await server.listen();
server.printUrls();

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
