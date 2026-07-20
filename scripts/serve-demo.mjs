/**
 * Dev server for the demo page. Run `npm run bundle` to refresh sdk.js.
 *
 * Deliberately not esbuild's `--servedir`: that shuts down when stdin closes,
 * which breaks any non-interactive runner.
 */
import { startServer } from './static-server.mjs';

const port = Number(process.env.PORT ?? 5173);
await startServer(port);
console.info(`[demo] http://localhost:${port}`);
