import * as esbuild from 'esbuild';
import fs from 'fs';

async function build() {
  try {
    // Clean previous output (dist is gitignored).
    if (fs.existsSync('dist')) {
      fs.rmSync('dist', { recursive: true, force: true });
    }
    await esbuild.build({
      entryPoints: ['src/index.js'],
      bundle: true,
      outfile: 'dist/index.js',
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // NOTE: no banner — esbuild preserves src/index.js's #! shebang automatically.
      // Adding banner duplicates it (line 2 #! = SyntaxError).
      // Mark dependencies as external so they aren't bundled
      external: [
        'playwright',
        '@modelcontextprotocol/sdk',
        'zod',
        // Node builtins are automatically externalized by platform: 'node', 
        // but it doesn't hurt to be explicit or if there are any edge cases.
      ],
      minify: false,
      sourcemap: true,
    });
    // Restore executable bit lost during bundling (bin entry).
    try {
      fs.chmodSync('dist/index.js', 0o755);
    } catch { /* Windows ignores chmod */ }
    console.log('✅ Build successful: dist/index.js created');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
