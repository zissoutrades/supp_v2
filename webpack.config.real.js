// Build for manual real-Gmail testing (Part C of TESTING-ONBOARDING.md).
// Outputs to dist-test/ so the extension ID and registered redirect URIs stay the same,
// but hits real gmail.googleapis.com instead of Mockoon.
import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: 'development',
  entry: {
    'content': './src/content/main.js',
    'service-worker': './src/background/service-worker.js',
    'popup': './popup/popup.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist-test'),
    filename: '[name].js',
    clean: true
  },
  module: {
    rules: []
  },
  resolve: {
    extensions: ['.js']
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('test'),
      // Real Gmail API — no Mockoon
      '__GMAIL_API_BASE__': JSON.stringify('https://gmail.googleapis.com/gmail/v1'),
      '__GMAIL_UPLOAD_BASE__': JSON.stringify('https://gmail.googleapis.com/upload/gmail/v1'),
      '__SKIP_OAUTH__': JSON.stringify(false)
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'popup/popup.html', to: 'popup.html' },
        { from: 'assets/icons', to: 'icons' },
        { from: 'node_modules/@inboxsdk/core/pageWorld.js', to: 'pageWorld.js' }
      ]
    })
  ],
  optimization: {
    splitChunks: false,
    runtimeChunk: false
  },
  target: ['web', 'es2020'],
  devtool: 'source-map'
};
