// Writes the sample document the editor offers ("Try the sample", src/objects/sample.ts) to a file.
//   node scripts/sample-pdf.ts [out.pdf]
import { writeFile } from 'node:fs/promises';
import { samplePdf, SAMPLE_NAME } from '../src/objects/sample.ts';

const out = process.argv[2] || SAMPLE_NAME;
const bytes = await samplePdf();
await writeFile(out, bytes);
console.log(`${out}: ${bytes.length} bytes`);
