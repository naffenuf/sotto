import { buildApp } from "./app.js";
import { HOST, loadConfig, MissingApiKeyError } from "./config.js";

async function main(): Promise<void> {
  let port: number;
  try {
    ({ port } = loadConfig());
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      console.error(`sotto: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp({ logger: true });
  await app.listen({ host: HOST, port });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

void main();
