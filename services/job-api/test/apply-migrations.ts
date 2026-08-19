import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

declare module "cloudflare:workers" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[];
	}
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
