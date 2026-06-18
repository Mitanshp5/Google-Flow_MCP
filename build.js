import * as esbuild from 'esbuild';

async function build() {
  try {
    await esbuild.build({
      entryPoints: ['src/index.js'],
      bundle: true,
      outfile: 'dist/index.js',
      format: 'esm',
      platform: 'node',
      target: 'node18',
      // Mark dependencies as external so they aren't bundled
      external: [
        'playwright',
        '@modelcontextprotocol/sdk',
        'zod',
        // Node builtins are automatically externalized by platform: 'node', 
        // but it doesn't hurt to be explicit or if there are any edge cases.
      ],
      minify: false,
      sourcemap: false,
    });
    console.log('✅ Build successful: dist/index.js created');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
