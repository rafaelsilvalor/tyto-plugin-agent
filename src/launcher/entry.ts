import { main } from './launch.js';

// The bundle's only top-level effect: `adapter/launch.mjs` is a program, never imported.
await main(process.argv.slice(2));
