const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** Extension host bundle (Node.js / CommonJS) */
const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
};

/** Webview React bundle (browser / IIFE) */
const webviewConfig = {
    entryPoints: ['src/webview/index.tsx'],
    bundle: true,
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    define: {
        'process.env.NODE_ENV': '"production"',
    },
};

async function main() {
    if (isWatch) {
        const extCtx = await esbuild.context(extensionConfig);
        const webCtx = await esbuild.context(webviewConfig);
        await Promise.all([extCtx.watch(), webCtx.watch()]);
        console.log('👀 Watching for changes...');
    } else {
        await Promise.all([
            esbuild.build(extensionConfig),
            esbuild.build(webviewConfig),
        ]);
        console.log('✅ Build complete');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
