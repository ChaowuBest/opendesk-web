import * as esbuild from 'esbuild';

const config: esbuild.BuildOptions = {
  entryPoints: ['src/main/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/cli/cli.cjs',
  external: ['node-screenshots', 'vectra'],
};

async function build() {
  await esbuild.build(config);
}

build().catch((error) => {
    console.error('Failed to build CLI: ', error.message);
    process.exit(1);
});
