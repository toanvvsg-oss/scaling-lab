import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const [cluster, ...images] = process.argv.slice(2);
if (typeof cluster !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(cluster) || !images.length) throw new Error('Usage: load-images cluster image...');
const abort = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => abort.abort());
const tmp = await mkdtemp(join(tmpdir(), 'scaling-kind-images-'));
async function run(cmd, args) {
  const r = await exec(cmd, args, { signal: abort.signal, timeout: 180_000, maxBuffer: 1024 * 1024 });
  return r.stdout;
}
try {
  const help = await run('docker', ['image', 'save', '--help']);
  for (const image of images) {
    const platform = (await run('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image])).trim();
    const archive = join(tmp, 'image.tar');
    // Recent Docker uses multi-platform OCI indexes. Export only the local
    // platform so old kind/containerd does not request undownloaded blobs.
    const args = ['image', 'save', '-o', archive];
    if (help.includes('--platform')) args.push('--platform', platform);
    args.push(image);
    console.log('Loading ' + image + ' (' + platform + ') into ' + cluster);
    await run('docker', args);
    await run('kind', ['load', 'image-archive', archive, '--name', cluster]);
  }
} finally { await rm(tmp, { recursive: true, force: true }); }
