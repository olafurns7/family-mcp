// Creates the key at KEY and kills itself with SIGKILL right after STEP, driven by test/storage.test.ts.
import { LocalKeyFileProvider } from '../src/index.js';

const [key, step] = process.argv.slice(2);

if (key === undefined || step === undefined) throw new RangeError('Usage: key-worker KEY STEP');

await new LocalKeyFileProvider({
  path: key,
  onPublish: (reached) => {
    if (reached === step) process.kill(process.pid, 'SIGKILL');
  },
}).createKey();
